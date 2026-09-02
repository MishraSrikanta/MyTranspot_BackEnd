const LocationPing = require("../models/LocationPing");
const VehicleState = require("../models/VehicleState");
const { errors } = require("./apiError");
const { round, assessFix, routeProgress, haversineKm } = require("./geo");
const { parseLatLng } = require("./validate");

/*
 * Taking in positions from driver phones.
 *
 * ================= how the tracking actually works =================
 *
 * The driver app samples GPS on a timer — fifteen minutes by default, set per
 * company and overridable per vehicle — and it does that whether or not the
 * phone has a signal. Each sample is written to a queue on the handset with the
 * time it was TAKEN. When the phone next has a connection, it POSTs the whole
 * queue in one request and empties it on a 2xx.
 *
 * That design is the entire answer to "the lorry drove through a valley with no
 * network for four hours". The alternative — send the current position, drop it
 * if the network is down — produces a map with a straight line across
 * Chhattisgarh and a distance total that is short by a hundred kilometres,
 * which is money, because the driver is paid per kilometre.
 *
 * Three consequences run through everything below:
 *
 *   1. `recordedAt` is authoritative, `receivedAt` is diagnostic. Ordering,
 *      distance and speed all come from when the fix was taken.
 *   2. Uploads must be idempotent. A phone that sends a batch and loses signal
 *      before the reply will send it again; the unique index on
 *      (vehicleId, recordedAt) makes the duplicate a no-op rather than a second
 *      copy of the same journey.
 *   3. A batch is processed in time order, as one continuous track, so the
 *      distance across the offline gap is measured properly rather than being
 *      collapsed into one enormous jump from the last online point.
 */

/* A phone whose clock is ahead. Some skew is normal; a fix from next Tuesday is
 * not, and would sit at the end of the track for ever, breaking every distance
 * and duration on the trip. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

/* One request. Enough for three days offline at a one-minute interval; beyond
 * that the phone sends more than one batch, which it must be able to do anyway. */
const MAX_BATCH = 500;

/*
 * Normalise and sanity-check the pings in a batch before any of them is stored.
 *
 * Note what is refused outright versus what is merely marked. A fix with a bad
 * timestamp is refused, because it cannot be placed in the track at all. A fix
 * that is simply poor — a vague cell-tower position, an impossible jump — is
 * STORED with a reason and left out of the distance. Discarding those silently
 * would make a tracker that has been producing rubbish for a fortnight look
 * exactly like a lorry that has been parked.
 */
function normaliseBatch(rawPings, { maxOfflineBacklogHours }) {
  if (!Array.isArray(rawPings) || rawPings.length === 0) {
    throw errors.validation("Send at least one location fix.", {
      pings: "must be a non-empty array",
    });
  }
  if (rawPings.length > MAX_BATCH) {
    throw errors.payloadTooLarge(
      `Send at most ${MAX_BATCH} location fixes per upload.`,
      { pings: `must contain at most ${MAX_BATCH} items` }
    );
  }

  const now = Date.now();
  const oldestAllowed = now - maxOfflineBacklogHours * 3600 * 1000;
  const out = [];

  for (const raw of rawPings) {
    const { lat, lng } = parseLatLng(raw.lat, raw.lng, "ping");

    const recordedAt = new Date(raw.recordedAt ?? raw.timestamp ?? Date.now());
    if (Number.isNaN(recordedAt.getTime())) {
      throw errors.validation("A location fix has an invalid timestamp.", {
        recordedAt: "must be a date",
      });
    }
    if (recordedAt.getTime() > now + MAX_CLOCK_SKEW_MS) {
      throw errors.validation(
        "A location fix is dated in the future. Check the clock on the device.",
        { recordedAt: "must not be in the future" }
      );
    }
    /* Silently dropped rather than failing the batch: a phone that has been off
     * for a week should still be able to upload the last three days. Rejecting
     * the whole request would mean it can never empty its queue. */
    if (recordedAt.getTime() < oldestAllowed) continue;

    out.push({
      lat,
      lng,
      recordedAt,
      speedKmh: numOrZero(raw.speedKmh ?? raw.speed),
      headingDeg: numOrNull(raw.headingDeg ?? raw.heading),
      accuracyM: numOrNull(raw.accuracyM ?? raw.accuracy),
      altitudeM: numOrNull(raw.altitudeM ?? raw.altitude),
      batteryPercent: numOrNull(raw.batteryPercent ?? raw.battery),
    });
  }

  /* Time order, not arrival order. Everything downstream assumes it. */
  out.sort((a, b) => a.recordedAt - b.recordedAt);
  return out;
}

/*
 * Store a batch against a trip and update everything the live map reads.
 *
 * Returns a summary the driver app uses to decide what to do next: how many
 * fixes were kept, how far the lorry has come, and — importantly — the current
 * reporting interval, so an owner who changes it in the office sees the phones
 * follow on their next upload without anybody touching a handset.
 */
async function ingestPings(
  { company, trip, vehicle, driver },
  rawPings,
  { wasOffline = false } = {}
) {
  const config = company.trackingConfig();
  const batch = normaliseBatch(rawPings, config);

  if (batch.length === 0) {
    return {
      accepted: 0,
      stored: 0,
      duplicates: 0,
      rejected: 0,
      message: "Nothing recent enough to store.",
      tracking: resolveInterval(company, vehicle),
    };
  }

  /*
   * The last fix already on record for this lorry, which is what the first ping
   * of the batch is measured against. Read by vehicle rather than by trip so a
   * lorry that has just started a second trip still has its distance measured
   * from where it actually was, not from zero.
   */
  let previous = await LocationPing.findOne({ vehicleId: vehicle._id, accepted: true })
    .select("lat lng recordedAt")
    .sort({ recordedAt: -1 })
    .lean();

  const routePoints = (trip.plannedRoute?.points || []).map((p) => ({
    lat: p.lat,
    lng: p.lng,
  }));
  const hasRoute = routePoints.length >= 2;

  const docs = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let approximateCount = 0;
  /*
   * The newest coarse fix in the batch, used only when nothing better arrived.
   * A single precise fix anywhere in the batch outranks every approximate one:
   * it is a real position, and it is what the trip should be told about.
   */
  let lastApproximate = null;
  /* What was turned away and why, so the caller can say something true to the
   * person holding the phone instead of "not counted". */
  const rejectedReasons = {};
  let addedKm = 0;
  let maxOffRoute = trip.maxOffRouteKm || 0;
  let deviationAt = null;
  let lastAccepted = null;
  let lastProgress = null;

  for (const fix of batch) {
    /*
     * A fix older than one we already hold is a late arrival from a queue we
     * have partly seen. It is stored for the track — the map should show where
     * the lorry actually went — but it is not measured against, because the
     * "previous" point for distance purposes has already moved on.
     */
    const isLate = previous && fix.recordedAt <= new Date(previous.recordedAt);
    const verdict = isLate
      ? { accepted: false, reason: "OUT_OF_ORDER", distanceKm: 0 }
      : assessFix(previous, fix, { maxAccuracyM: config.maxAccuracyM });

    let offRoute = null;
    let progress = null;
    if (hasRoute) {
      progress = routeProgress(fix, routePoints);
      offRoute = progress.offRouteKm;
      if (verdict.accepted && offRoute != null && offRoute > maxOffRoute) {
        maxOffRoute = offRoute;
      }
      if (
        verdict.accepted &&
        offRoute != null &&
        offRoute > config.routeDeviationKm &&
        !deviationAt
      ) {
        deviationAt = fix.recordedAt;
      }
    }

    docs.push({
      companyId: company._id,
      tripId: trip._id,
      vehicleId: vehicle._id,
      driverId: driver?._id || trip.driverId || null,
      lat: fix.lat,
      lng: fix.lng,
      speedKmh: fix.speedKmh,
      headingDeg: fix.headingDeg,
      accuracyM: fix.accuracyM,
      altitudeM: fix.altitudeM,
      batteryPercent: fix.batteryPercent,
      recordedAt: fix.recordedAt,
      receivedAt: new Date(),
      wasOffline,
      distanceFromPrevKm: verdict.distanceKm || 0,
      offRouteKm: offRoute,
      routeRevision: trip.plannedRoute?.revision || null,
      accepted: verdict.accepted,
      rejectReason: verdict.reason,
    });

    if (verdict.accepted) {
      acceptedCount += 1;
      addedKm += verdict.distanceKm || 0;
      previous = fix;
      lastAccepted = fix;
      lastProgress = progress;
    } else if (verdict.approximate) {
      approximateCount += 1;
      /*
       * Deliberately NOT assigned to `previous`. The next precise fix must be
       * measured from the last position we actually trust — measuring it from a
       * point that may be two kilometres out would put that error straight into
       * the distance the driver is paid on.
       */
      lastApproximate = fix;
    } else {
      rejectedCount += 1;
      const reason = verdict.reason || "UNKNOWN";
      rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1;
    }
  }

  /*
   * `ordered: false` so one duplicate does not abandon the rest of the batch —
   * which is exactly the case a retry produces: the first half already stored,
   * the second half not. Duplicate-key errors are counted and ignored; anything
   * else is a real failure and is raised.
   */
  let stored = 0;
  let duplicates = 0;
  try {
    const res = await LocationPing.insertMany(docs, { ordered: false, rawResult: true });
    stored = res.insertedCount ?? docs.length;
  } catch (err) {
    if (err && (err.code === 11000 || err.writeErrors)) {
      const writeErrors = err.writeErrors || [];
      duplicates = writeErrors.filter((e) => e.err?.code === 11000 || e.code === 11000).length;
      const other = writeErrors.length - duplicates;
      stored = docs.length - writeErrors.length;
      if (other > 0) throw err;
    } else {
      throw err;
    }
  }

  /*
   * A re-sent batch that was entirely duplicates must not add its distance a
   * second time. The phone gets a success either way — it has done its job and
   * should empty its queue — but the trip's odometer only moves for fixes that
   * were genuinely new.
   */
  const isReplay = stored === 0 && duplicates > 0;

  if (lastAccepted && !isReplay) {
    await applyToTrip(trip, {
      lastAccepted,
      progress: lastProgress,
      addedKm,
      pingCount: stored,
      config,
      deviationAt,
      maxOffRoute,
    });
    await upsertVehicleState({ company, trip, vehicle, driver, fix: lastAccepted, progress: lastProgress, config, wasOffline });
  } else if (lastApproximate && !isReplay) {
    /*
     * Nothing precise arrived, so the rough position is better than nothing —
     * with everything it cannot support switched off: no distance, no route
     * progress, no deviation judgement. The position is marked approximate all
     * the way through, so the map can say so rather than implying a precision
     * it does not have.
     */
    await applyToTrip(trip, {
      lastAccepted: lastApproximate,
      progress: null,
      addedKm: 0,
      pingCount: stored,
      config,
      deviationAt: null,
      maxOffRoute: 0,
      approximate: true,
    });
    await upsertVehicleState({
      company,
      trip,
      vehicle,
      driver,
      fix: lastApproximate,
      progress: null,
      config,
      wasOffline,
      approximate: true,
    });
  }

  return {
    accepted: acceptedCount,
    stored,
    duplicates,
    rejected: rejectedCount,
    /* Stored and shown, but not counted towards distance — see assessFix. */
    approximate: approximateCount,
    approximateAccuracyM: lastApproximate?.accuracyM ?? null,
    /* { POOR_ACCURACY: 1 } and so on. The client turns this into a sentence a
     * driver can act on; without it the only honest thing it could say was
     * "something was wrong with that position". */
    rejectedReasons,
    distanceAddedKm: round(isReplay ? 0 : addedKm),
    tripDistanceKm: round(trip.journey?.distanceKm || 0),
    isOffRoute: !!trip.lastPosition?.isOffRoute,
    /* Echoed on every upload. This is the mechanism by which the owner's
     * interval change reaches the phones — no push channel required, and it
     * works on a handset that has been offline for two days. */
    tracking: resolveInterval(company, vehicle),
  };
}

/*
 * Fold the newest fix into the trip: where the lorry is, how far it has come,
 * and whether it has left the route.
 *
 * `journey.distanceKm` is advanced incrementally here so the live screen has a
 * running total. It is REPLACED by a full recount from the stored track when
 * the trip closes (see summariseJourney) — the increment is for the map, the
 * recount is what the driver is paid on, and the recount is the one that can be
 * audited.
 */
async function applyToTrip(trip, { lastAccepted, progress, addedKm, pingCount, config, deviationAt, maxOffRoute, approximate = false }) {
  const offRoute = progress?.offRouteKm ?? null;
  const isOffRoute = offRoute != null && offRoute > config.routeDeviationKm;

  trip.lastPosition = {
    lat: lastAccepted.lat,
    lng: lastAccepted.lng,
    speedKmh: lastAccepted.speedKmh || 0,
    headingDeg: lastAccepted.headingDeg,
    accuracyM: lastAccepted.accuracyM,
    recordedAt: lastAccepted.recordedAt,
    receivedAt: new Date(),
    offRouteKm: offRoute,
    isOffRoute,
    /* Carried onto the trip so every screen that draws this position can label
     * it, rather than each one having to infer it from the accuracy figure. */
    isApproximate: approximate,
    coveredKm: progress?.coveredKm ?? trip.lastPosition?.coveredKm ?? 0,
    remainingKm: progress?.remainingKm ?? trip.lastPosition?.remainingKm ?? 0,
    progressPercent: progress?.percent ?? trip.lastPosition?.progressPercent ?? 0,
  };

  trip.journey.distanceKm = round((trip.journey?.distanceKm || 0) + addedKm);
  trip.journey.pingCount = (trip.journey?.pingCount || 0) + pingCount;

  if (maxOffRoute > (trip.maxOffRouteKm || 0)) trip.maxOffRouteKm = round(maxOffRoute);
  /*
   * The deviation flag is raised once and left raised. An owner wants to know
   * that a lorry left its route on Tuesday night, not merely whether it happens
   * to be off route at the moment they open the screen — by which time it has
   * usually rejoined.
   */
  if (deviationAt && !trip.hasRouteDeviation) {
    trip.hasRouteDeviation = true;
    trip.routeDeviationAt = deviationAt;
  }

  await trip.save();
}

/*
 * The one row per lorry that the live fleet map reads. Upserted, never
 * appended — see models/VehicleState.js for why this duplication exists.
 */
async function upsertVehicleState({ company, trip, vehicle, driver, fix, progress, config, wasOffline, approximate = false }) {
  const state = movementStateFor(fix, config);

  const existing = await VehicleState.findOne({ vehicleId: vehicle._id }).select(
    "movementState stateSince"
  );

  await VehicleState.updateOne(
    { vehicleId: vehicle._id },
    {
      $set: {
        companyId: company._id,
        registrationNumber: vehicle.registrationNumber,
        tripId: trip._id,
        tripNumber: trip.tripNumber,
        driverId: driver?._id || trip.driverId || null,
        driverName: driver?.name || trip.driverName || "",
        lat: fix.lat,
        lng: fix.lng,
        speedKmh: fix.speedKmh || 0,
        headingDeg: fix.headingDeg,
        accuracyM: fix.accuracyM,
        batteryPercent: fix.batteryPercent,
        recordedAt: fix.recordedAt,
        receivedAt: new Date(),
        movementState: state,
        /* Only reset when the state actually changes, so "stopped for 3h 20m"
         * survives every subsequent ping that says it is still stopped. */
        ...(existing?.movementState === state
          ? {}
          : { stateSince: fix.recordedAt }),
        offRouteKm: progress?.offRouteKm ?? null,
        isOffRoute:
          progress?.offRouteKm != null && progress.offRouteKm > config.routeDeviationKm,
        /* A coarse position is shown and labelled, never measured against. */
        isApproximate: approximate,
        coveredKm: progress?.coveredKm || 0,
        remainingKm: progress?.remainingKm || 0,
        intervalSeconds: resolveInterval(company, vehicle).intervalSeconds,
        lastUploadWasOffline: wasOffline,
      },
    },
    { upsert: true }
  );
}

/*
 * Moving, idle or stopped. The 5 km/h floor is there because a stationary
 * phone's own speed reading wanders by a few km/h, and a fleet map where every
 * parked lorry says "moving" is a map nobody trusts.
 */
function movementStateFor(fix, config) {
  const ageSeconds = (Date.now() - new Date(fix.recordedAt).getTime()) / 1000;
  if (ageSeconds > config.offlineAfterSeconds) return "OFFLINE";
  if ((fix.speedKmh || 0) > 5) return "MOVING";
  if ((fix.speedKmh || 0) > 0) return "IDLE";
  return "STOPPED";
}

/*
 * The interval this particular lorry should report on: its own override if it
 * has one, otherwise the company setting. Resolved on the server and sent to
 * the phone, so the rule lives in one place and a handset never has to work out
 * which of two settings wins.
 */
function resolveInterval(company, vehicle) {
  const config = company.trackingConfig();
  const override = vehicle?.trackingIntervalSeconds || null;
  const intervalSeconds = override || config.intervalSeconds;
  return {
    ...config,
    intervalSeconds,
    idleIntervalSeconds: override || config.idleIntervalSeconds,
    /* So the app can show the driver "reporting every 15 min (fleet setting)"
     * rather than an unexplained number. */
    source: override ? "vehicle" : "company",
    offlineAfterSeconds: intervalSeconds * 3,
  };
}

/*
 * Read the live state of a fleet, deciding staleness at read time.
 *
 * A stored movement state cannot tell you that a lorry went quiet: nothing
 * writes when a phone STOPS reporting, which is precisely the event the owner
 * needs to see. So the stored state is used while it is fresh, and anything
 * past its offline window is reported OFFLINE regardless of what it last said.
 */
function decorateStaleness(states, company) {
  const config = company.trackingConfig();
  const now = Date.now();
  return states.map((s) => {
    const perVehicle = s.intervalSeconds || config.intervalSeconds;
    const offlineAfter = perVehicle * 3;
    const ageSeconds = s.recordedAt
      ? Math.round((now - new Date(s.recordedAt).getTime()) / 1000)
      : null;
    const isStale = ageSeconds == null || ageSeconds > offlineAfter;
    return {
      ...s,
      ageSeconds,
      movementState: isStale ? (s.recordedAt ? "OFFLINE" : "NO_DATA") : s.movementState,
      expectedIntervalSeconds: perVehicle,
    };
  });
}

const numOrZero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const numOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

module.exports = {
  MAX_BATCH,
  normaliseBatch,
  ingestPings,
  resolveInterval,
  decorateStaleness,
  movementStateFor,
  haversineKm,
};
