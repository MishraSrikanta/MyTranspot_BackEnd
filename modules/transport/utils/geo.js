/*
 * Everything the system knows about where a lorry is and how far it has gone.
 *
 * All of it is plain arithmetic on latitude/longitude — no map provider is
 * called from the server. That is a deliberate architectural choice: the
 * distance a trip covered, whether it left its route, and how far it still has
 * to go are all business facts that decide a driver's fee and a customer's
 * bill. They must not stop working, or start costing money per request,
 * because a third-party routing API is down or unpaid. The frontend is free to
 * draw a prettier road-snapped line on top; the numbers banked against the trip
 * come from here.
 *
 * A point is `{ lat, lng }`. A path is an array of them, in time order.
 */

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

const round = (n, dp = 2) => {
  const f = 10 ** dp;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};

/* Great-circle distance in kilometres. */
function haversineKm(a, b) {
  if (!a || !b) return 0;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* Compass bearing from a to b, in degrees clockwise from north. */
function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/* Total length of a path, summed leg by leg. */
function pathDistanceKm(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineKm(points[i - 1], points[i]);
  }
  return round(total, 3);
}

/*
 * Project a point onto one segment and return both how far off it is and how
 * far along the segment the nearest spot lies.
 *
 * Over a segment of a few kilometres the curvature of the earth is far smaller
 * than a GPS fix is accurate, so the segment is treated as flat with longitude
 * scaled by cos(latitude). That approximation is what keeps this cheap enough
 * to run against every ping of every lorry.
 */
function projectOnSegment(p, a, b) {
  const kx = Math.cos(toRad((a.lat + b.lat) / 2));
  const ax = a.lng * kx;
  const ay = a.lat;
  const bx = b.lng * kx;
  const by = b.lat;
  const px = p.lng * kx;
  const py = p.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  /* A zero-length segment (a repeated waypoint) is just its own endpoint. */
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const nearest = { lat: ay + t * dy, lng: (ax + t * dx) / kx };
  return { t, nearest, offRouteKm: haversineKm(p, nearest) };
}

/*
 * The nearest spot on a whole route to a point, plus how far along the route it
 * is. This one function answers three questions the product asks constantly:
 * has the lorry left its route, how far has it come, and how much is left.
 */
function nearestOnPath(point, path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  if (path.length === 1) {
    return {
      offRouteKm: haversineKm(point, path[0]),
      alongKm: 0,
      index: 0,
      nearest: path[0],
    };
  }

  let best = null;
  let travelled = 0;

  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const segmentKm = haversineKm(a, b);
    const { t, nearest, offRouteKm } = projectOnSegment(point, a, b);

    if (!best || offRouteKm < best.offRouteKm) {
      best = {
        offRouteKm: round(offRouteKm, 3),
        alongKm: round(travelled + t * segmentKm, 3),
        index: i - 1,
        nearest,
      };
    }
    travelled += segmentKm;
  }
  return best;
}

/*
 * How far a point is from the planned route. Used to decide whether the owner
 * should be told the lorry has gone somewhere else.
 */
function offRouteKm(point, path) {
  const near = nearestOnPath(point, path);
  return near ? near.offRouteKm : null;
}

/*
 * Progress along a planned route, as the owner reads it on the trip card.
 *
 * `remainingKm` is deliberately measured along the ROUTE and not as the crow
 * flies to the destination. A lorry on the Bhubaneswar-Delhi run that has just
 * passed Nagpur is much further by road than by straight line, and quoting the
 * straight line would promise the customer an arrival that cannot happen.
 */
function routeProgress(point, path) {
  const totalKm = pathDistanceKm(path);
  const near = nearestOnPath(point, path);
  if (!near || totalKm === 0) {
    return { totalKm, coveredKm: 0, remainingKm: totalKm, percent: 0, offRouteKm: null };
  }
  const coveredKm = Math.min(near.alongKm, totalKm);
  return {
    totalKm: round(totalKm),
    coveredKm: round(coveredKm),
    remainingKm: round(Math.max(0, totalKm - coveredKm)),
    percent: round((coveredKm / totalKm) * 100, 1),
    offRouteKm: near.offRouteKm,
  };
}

/*
 * Ramer-Douglas-Peucker, run on stored paths before they are handed to a map.
 *
 * A three-day trip pinged every fifteen minutes is a few hundred points, but a
 * driver who leaves the app on a ten-second interval produces tens of
 * thousands, and every one of them is drawn by the browser. Thinning the line
 * to its shape — the corners survive, the straight-motorway filler does not —
 * is the difference between a map that pans smoothly and one that locks up a
 * laptop. The stored history is never thinned; only what is sent for drawing.
 */
function simplifyPath(points, toleranceKm = 0.05) {
  if (!Array.isArray(points) || points.length < 3) return points || [];

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;

    let maxDist = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = projectOnSegment(points[i], points[first], points[last]).offRouteKm;
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxDist > toleranceKm && maxIndex > 0) {
      keep[maxIndex] = true;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/*
 * Reject a fix before it is allowed to move a lorry on the map.
 *
 * Two things go wrong constantly with phone GPS, and both corrupt the trip
 * distance the driver is paid against:
 *
 *   - a fix with a huge accuracy radius, typically a cell-tower guess taken
 *     indoors, which lands the lorry a kilometre from where it is parked;
 *   - a teleport, where a stale fix arrives late and the implied speed between
 *     it and the last good point is impossible for a loaded truck.
 *
 * Rejected fixes are still STORED (see the tracking route) and simply not
 * counted towards distance. Throwing them away entirely would hide a genuine
 * tracker fault behind a clean-looking map.
 */
const MAX_PLAUSIBLE_KMH = 140;
const DEFAULT_MAX_ACCURACY_M = 500;
/*
 * The worst accuracy still worth putting on a map, in metres.
 *
 * Ten kilometres is about the size of a town: a marker that vague still tells a
 * dispatcher which stretch of road the lorry is on, which is the whole job of
 * an approximate fix. Wi-Fi positioning typically lands well inside it; a fix
 * derived from an IP address alone does not, and that is exactly the one that
 * should be refused.
 */
const APPROXIMATE_ACCURACY_CEILING_M = 10000;

function assessFix(previous, fix, { maxAccuracyM = DEFAULT_MAX_ACCURACY_M } = {}) {
  /*
   * ================= accuracy, in two tiers =================
   *
   * There used to be one line here: worse than the company's limit, rejected.
   * That is the right rule for a phone with GPS and the wrong rule for the
   * thing this product also has to support — a driver reporting from a browser.
   *
   * A browser on a laptop, or on a phone with "precise location" switched off,
   * positions by Wi-Fi and IP address and reports an accuracy of two to thirty
   * kilometres. Under the old rule every one of those was thrown away, so a
   * driver without the app could press "Send my position" all day and the owner
   * would still see an empty map. That is the worst outcome available: it looks
   * identical to a lorry that has stopped reporting.
   *
   * So a coarse fix is now APPROXIMATE rather than rejected. It answers the
   * question an owner actually asks — roughly where is the lorry — and it is
   * kept away from the two things it genuinely cannot support:
   *
   *   distance    the driver is paid on it, and a 2 km error per fix would
   *               accumulate into a fee nobody can defend.
   *   deviation   a 5 km off-route threshold cannot be judged by a fix that
   *               might be 2 km wrong; it would raise alarms about lorries that
   *               never left the road.
   *
   * Beyond the ceiling it is still a rejection. A fix accurate to 30 km places
   * the lorry somewhere in the district, and drawing that on a map as though it
   * meant something would be a lie with a marker on it.
   */
  if (Number.isFinite(fix.accuracyM) && fix.accuracyM > maxAccuracyM) {
    return {
      accepted: false,
      approximate: fix.accuracyM <= APPROXIMATE_ACCURACY_CEILING_M,
      reason: "POOR_ACCURACY",
      accuracyM: fix.accuracyM,
      distanceKm: 0,
      impliedKmh: null,
    };
  }
  if (!previous) return { accepted: true, reason: null, distanceKm: 0, impliedKmh: null };

  const distanceKm = haversineKm(previous, fix);
  const seconds =
    (new Date(fix.recordedAt).getTime() - new Date(previous.recordedAt).getTime()) / 1000;

  /*
   * Out-of-order arrivals are expected, not exceptional: a phone that was in a
   * tunnel uploads its backlog the moment it reconnects. Ordering is settled by
   * `recordedAt` before this runs, so a non-positive gap here means two fixes
   * share a timestamp — no time passed, so no distance can be credited.
   */
  if (!(seconds > 0)) {
    return { accepted: false, reason: "OUT_OF_ORDER", distanceKm: 0, impliedKmh: null };
  }

  const impliedKmh = (distanceKm / seconds) * 3600;

  /*
   * The 200 m floor matters. Parked overnight, a phone jitters a few metres
   * every fifteen minutes; over a long stop that jitter divided by a short gap
   * can imply a wild speed and get a perfectly good fix thrown out.
   */
  if (distanceKm > 0.2 && impliedKmh > MAX_PLAUSIBLE_KMH) {
    return {
      accepted: false,
      reason: "IMPLAUSIBLE_JUMP",
      distanceKm: 0,
      impliedKmh: round(impliedKmh, 1),
    };
  }

  return {
    accepted: true,
    reason: null,
    distanceKm: round(distanceKm, 3),
    impliedKmh: round(impliedKmh, 1),
  };
}

/*
 * Turn a path into the trip summary the owner sees when the run is over:
 * distance, how long the wheels were turning, and where the lorry stopped.
 *
 * A stop is a run of fixes that stay inside `radiusKm` of each other for longer
 * than `minMinutes`. Tea, a queue at a toll plaza and a night halt all look the
 * same to GPS; the threshold is what stops the report listing forty "stops" for
 * one three-day run.
 */
function summarisePath(points, { stopRadiusKm = 0.3, minStopMinutes = 15 } = {}) {
  const empty = {
    distanceKm: 0,
    durationMinutes: 0,
    movingMinutes: 0,
    stoppedMinutes: 0,
    stops: [],
    averageKmh: 0,
    maxKmh: 0,
  };
  if (!Array.isArray(points) || points.length < 2) return empty;

  const path = [...points].sort(
    (a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)
  );

  let distanceKm = 0;
  let movingMinutes = 0;
  let stoppedMinutes = 0;
  let maxKmh = 0;
  const stops = [];
  let anchor = path[0];
  let anchorIndex = 0;

  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1];
    const cur = path[i];
    const legKm = haversineKm(prev, cur);
    const legMin =
      (new Date(cur.recordedAt) - new Date(prev.recordedAt)) / 60000;

    distanceKm += legKm;
    if (legMin > 0) {
      const kmh = (legKm / legMin) * 60;
      if (kmh > maxKmh && kmh <= MAX_PLAUSIBLE_KMH) maxKmh = kmh;
    }

    if (haversineKm(anchor, cur) <= stopRadiusKm) {
      /* Still sitting near the anchor — the stop, if it is one, grows. */
      if (legMin > 0) stoppedMinutes += legMin;
      continue;
    }

    /* Moved away: close off whatever was happening at the anchor. */
    const heldMin =
      (new Date(prev.recordedAt) - new Date(anchor.recordedAt)) / 60000;
    if (heldMin >= minStopMinutes && i - 1 > anchorIndex) {
      stops.push({
        lat: anchor.lat,
        lng: anchor.lng,
        from: new Date(anchor.recordedAt).toISOString(),
        to: new Date(prev.recordedAt).toISOString(),
        minutes: round(heldMin, 1),
      });
    } else if (heldMin > 0) {
      /* Too short to be a stop, so it was time spent moving. */
      stoppedMinutes -= heldMin;
      movingMinutes += heldMin;
    }
    if (legMin > 0) movingMinutes += legMin;
    anchor = cur;
    anchorIndex = i;
  }

  /* A trip that ends parked at the consignee finishes on an open stop. */
  const tailMin =
    (new Date(path[path.length - 1].recordedAt) - new Date(anchor.recordedAt)) /
    60000;
  if (tailMin >= minStopMinutes && anchorIndex < path.length - 1) {
    stops.push({
      lat: anchor.lat,
      lng: anchor.lng,
      from: new Date(anchor.recordedAt).toISOString(),
      to: new Date(path[path.length - 1].recordedAt).toISOString(),
      minutes: round(tailMin, 1),
    });
  }

  const durationMinutes =
    (new Date(path[path.length - 1].recordedAt) - new Date(path[0].recordedAt)) /
    60000;

  return {
    distanceKm: round(distanceKm),
    durationMinutes: round(durationMinutes, 1),
    movingMinutes: round(Math.max(0, movingMinutes), 1),
    stoppedMinutes: round(Math.max(0, stoppedMinutes), 1),
    stops,
    averageKmh:
      movingMinutes > 0 ? round((distanceKm / movingMinutes) * 60, 1) : 0,
    maxKmh: round(maxKmh, 1),
  };
}

/* Minutes to the "27h 42m" the trip history shows. */
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

module.exports = {
  EARTH_RADIUS_KM,
  MAX_PLAUSIBLE_KMH,
  DEFAULT_MAX_ACCURACY_M,
  round,
  haversineKm,
  bearingDeg,
  pathDistanceKm,
  projectOnSegment,
  nearestOnPath,
  offRouteKm,
  routeProgress,
  simplifyPath,
  assessFix,
  summarisePath,
  formatDuration,
};
