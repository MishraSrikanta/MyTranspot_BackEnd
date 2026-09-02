const express = require("express");

const Trip = require("../models/Trip");
const Vehicle = require("../models/Vehicle");
const Driver = require("../models/Driver");
const VehicleState = require("../models/VehicleState");
const LocationPing = require("../models/LocationPing");
const { errors, handler } = require("../utils/apiError");
const { parseDate, parseInteger, parseBoolean, parseEnum } = require("../utils/validate");
const { requireAuth, requirePermission, requireDriverApp } = require("../middleware/auth");
const { trackingRateLimit } = require("../middleware/rateLimit");
const {
  ingestPings,
  resolveInterval,
  decorateStaleness,
  MAX_BATCH,
} = require("../utils/tracking");
const { simplifyPath, summarisePath, round, formatDuration } = require("../utils/geo");
const { summariseJourney } = require("../utils/tripLifecycle");

const router = express.Router();
router.use(requireAuth);

/* ================= the driver app =================
 *
 * Three endpoints, and they are deliberately the whole of the phone's world:
 * ask what to do, send what you have, say when you are finished. Everything
 * else the app shows is read from the trip endpoints.
 */

/* ---- GET /api/v1/tracking/config ----
 * What the phone asks for on sign-in, on resume, and after every upload.
 *
 * The reporting interval lives on the server and nowhere else. An app that
 * hard-coded fifteen minutes could never be changed without a store release;
 * an app that asks gets the owner's current setting, including any override for
 * the particular lorry it is sitting in.
 */
router.get(
  "/config",
  handler(async (req, res) => {
    let vehicle = null;
    let trip = null;

    if (req.account.driverId) {
      const driver = await Driver.findById(req.account.driverId).select("currentTripId");
      if (driver?.currentTripId) {
        trip = await Trip.findOne({
          _id: driver.currentTripId,
          companyId: req.companyId,
        }).select("tripNumber status vehicleId origin destination plannedRoute.revision");
        if (trip?.vehicleId) {
          vehicle = await Vehicle.findById(trip.vehicleId).select(
            "registrationNumber trackingIntervalSeconds"
          );
        }
      }
    }

    return res.json({
      tracking: resolveInterval(req.company, vehicle),
      maxBatchSize: MAX_BATCH,
      /*
       * The trip the phone should be reporting against, resolved server-side.
       * The app never chooses — it cannot post a position against a trip that
       * is not its driver's, because it is never told one.
       */
      activeTrip: trip
        ? {
            id: String(trip._id),
            tripNumber: trip.tripNumber,
            status: trip.status,
            origin: trip.origin?.name,
            destination: trip.destination?.name,
            routeRevision: trip.plannedRoute?.revision || 0,
            vehicle: vehicle?.registrationNumber || "",
          }
        : null,
    });
  })
);

/* ---- POST /api/v1/tracking/pings ----
 * The upload. One or many fixes, in one request.
 *
 * ================= the offline story, end to end =================
 *
 * The phone samples GPS on the interval above whether or not it has a signal,
 * and queues every sample locally with the time it was taken. When a connection
 * comes back it posts the entire queue here and clears it on a 2xx.
 *
 * That is why this endpoint accepts an ARRAY and not a single position, why
 * each fix carries its own `recordedAt`, and why re-sending is safe: the unique
 * index on (vehicle, recordedAt) turns a duplicate into a no-op, so a phone
 * that uploaded successfully and then lost the reply can simply send again.
 *
 * The response tells the app three things it needs: how much was stored, how
 * far the trip has now come, and the current reporting interval — which is the
 * mechanism by which an owner's change in the office reaches a handset that has
 * been out of contact for two days.
 */
const uploadPings = handler(async (req, res) => {
    const driver = await Driver.findOne({ _id: req.account.driverId, companyId: req.companyId });
    if (!driver) throw errors.driverNotFound();

    /*
     * The trip is resolved from the driver's record, not from the request body.
     * A phone cannot nominate a trip: if it could, a compromised handset could
     * write positions onto any trip in the company and corrupt the distance
     * another driver is paid on.
     */
    const trip = driver.currentTripId
      ? await Trip.findOne({ _id: driver.currentTripId, companyId: req.companyId })
      : null;

    if (!trip) {
      /*
       * 409, not 404, and with an explicit instruction. A driver whose trip was
       * closed in the office while they were offline must be told to stop and
       * clear the queue, otherwise the app retries the same batch for ever.
       */
      throw errors.resourceBusy(
        "You are not on an active trip. Stop tracking and refresh the app.",
        { action: "STOP_TRACKING" }
      );
    }
    if (!["IN_TRANSIT", "ARRIVED", "DELAYED", "ON_HOLD"].includes(trip.status)) {
      throw errors.resourceBusy(
        `Trip ${trip.tripNumber} is ${trip.status}. Tracking is not active.`,
        { action: "STOP_TRACKING", tripStatus: trip.status }
      );
    }

    const vehicle = await Vehicle.findById(trip.vehicleId);
    if (!vehicle) throw errors.vehicleNotFound();

    /*
     * Three body shapes are accepted, because three are what apps actually
     * send: a bare array, `{ pings: [...] }`, and a single fix object. Being
     * liberal here costs one line and saves a release of the phone app the day
     * somebody writes the networking code slightly differently.
     */
    const pings = Array.isArray(req.body) ? req.body : req.body.pings || [req.body];

    const result = await ingestPings(
      { company: req.company, trip, vehicle, driver },
      pings,
      /* The app says so when it is emptying a backlog. Used only for reporting —
       * it tells an owner the tracker was fine and the network was not. */
      { wasOffline: parseBoolean(req.body.wasOffline, pings.length > 1) }
    );

    return res.json(result);
});

router.post("/pings", requireDriverApp, trackingRateLimit, uploadPings);

/* ---- POST /api/v1/tracking/ping ----
 * Singular, for a live fix. The same handler: a single fix is a batch of one,
 * and having two code paths for that would mean two places for the distance
 * arithmetic to drift.
 */
router.post("/ping", requireDriverApp, trackingRateLimit, uploadPings);

/* ================= the office =================*/

/* ---- GET /api/v1/tracking/live ----
 * The fleet map. One query, one row per lorry.
 *
 * Staleness is decided here rather than trusted from the stored state, because
 * nothing writes when a phone STOPS reporting — which is exactly the event the
 * owner is watching for. A lorry whose last fix is older than three intervals
 * is reported OFFLINE however cheerfully its last ping described it.
 */
router.get(
  "/live",
  requirePermission("tracking.view"),
  handler(async (req, res) => {
    const states = await VehicleState.find({ companyId: req.companyId })
      .sort({ recordedAt: -1 })
      .limit(500)
      .lean();

    const rows = decorateStaleness(
      states.map((s) => ({ ...s, id: String(s._id) })),
      req.company
    );

    const summary = { total: rows.length, MOVING: 0, IDLE: 0, STOPPED: 0, OFFLINE: 0, NO_DATA: 0 };
    for (const r of rows) summary[r.movementState] = (summary[r.movementState] || 0) + 1;

    /*
     * Running trips that have never reported a position.
     *
     * ================= why the map has to say this =================
     *
     * This endpoint reads VehicleState, and a lorry only gets a row there once a
     * position has been ingested. Starting a trip does not create one — nothing
     * knows where the lorry is until something tells it.
     *
     * The consequence was a map that looked identical in two completely
     * different situations: "no trips are running" and "three trips are running
     * and not one of them is reporting". The first is a quiet day; the second
     * means the drivers have no app installed, or no login, or the app is not
     * running — and the owner cannot see their fleet. Counting them here lets
     * the screen tell the difference instead of leaving an empty rectangle to be
     * interpreted.
     */
    const awaitingFirstFix = await Trip.countDocuments({
      companyId: req.companyId,
      status: { $in: ["IN_TRANSIT", "ARRIVED", "DELAYED", "ON_HOLD"] },
      $or: [{ "lastPosition.recordedAt": null }, { "lastPosition.recordedAt": { $exists: false } }],
    });

    return res.json({
      vehicles: rows,
      summary,
      awaitingFirstFix,
      offRoute: rows.filter((r) => r.isOffRoute).length,
      /* Sent with the map so the UI can label a sparse track honestly —
       * "reporting every 15 min" rather than looking like it has frozen. */
      tracking: req.company.trackingConfig(),
      serverTime: new Date().toISOString(),
    });
  })
);

/* ---- GET /api/v1/tracking/live/:tripId ----
 * One lorry, in detail: where it is, how fast, how far it has come, how far is
 * left, and how long ago it last reported.
 */
router.get(
  "/live/:tripId",
  requirePermission("tracking.view"),
  handler(async (req, res) => {
    const trip = await Trip.findOne({ _id: req.params.tripId, companyId: req.companyId });
    if (!trip) throw errors.tripNotFound();

    const config = req.company.trackingConfig();
    const last = trip.lastPosition || {};
    const ageSeconds = last.recordedAt
      ? Math.round((Date.now() - new Date(last.recordedAt).getTime()) / 1000)
      : null;

    return res.json({
      trip: {
        id: String(trip._id),
        tripNumber: trip.tripNumber,
        status: trip.status,
        vehicle: trip.vehicleRegistration,
        driver: trip.driverName,
        customer: trip.customerName,
        origin: trip.origin,
        destination: trip.destination,
        startedAt: trip.startedAt,
        expectedArrival: trip.expectedArrival,
      },
      position: last.lat == null ? null : { ...last.toObject?.() || last, ageSeconds },
      /* NO_DATA and OFFLINE are different problems: one lorry never reported,
       * the other has stopped. The map colours them differently. */
      state:
        last.recordedAt == null
          ? "NO_DATA"
          : ageSeconds > config.offlineAfterSeconds
            ? "OFFLINE"
            : (last.speedKmh || 0) > 5
              ? "MOVING"
              : "STOPPED",
      progress: {
        plannedKm: round(trip.plannedRoute?.distanceKm || 0),
        coveredKm: round(last.coveredKm || 0),
        remainingKm: round(last.remainingKm || 0),
        percent: last.progressPercent || 0,
        drivenKm: round(trip.journey?.distanceKm || 0),
      },
      deviation: {
        hasDeviated: !!trip.hasRouteDeviation,
        isCurrentlyOffRoute: !!last.isOffRoute,
        offRouteKm: last.offRouteKm ?? null,
        thresholdKm: config.routeDeviationKm,
      },
      expectedIntervalSeconds: config.intervalSeconds,
    });
  })
);

/* ---- GET /api/v1/tracking/history/:tripId ----
 * The replay: the whole track of a trip, with its stops and its totals.
 *
 * The line is thinned before it is sent. A three-day trip on a one-minute
 * interval is four thousand points, and a map asked to draw several of those at
 * full resolution locks up the browser. `?full=true` returns every point for
 * the rare case that genuinely needs it — an export, or a dispute about where a
 * lorry actually was.
 */
router.get(
  "/history/:tripId",
  requirePermission("tracking.view"),
  handler(async (req, res) => {
    const trip = await Trip.findOne({ _id: req.params.tripId, companyId: req.companyId });
    if (!trip) throw errors.tripNotFound();

    const includeRejected = parseBoolean(req.query.includeRejected, false);
    const query = { tripId: trip._id };
    if (!includeRejected) query.accepted = true;

    const from = parseDate(req.query.from, "from");
    const to = parseDate(req.query.to, "to");
    if (from || to) {
      query.recordedAt = {};
      if (from) query.recordedAt.$gte = from;
      if (to) query.recordedAt.$lte = to;
    }

    const pings = await LocationPing.find(query)
      .select("lat lng speedKmh headingDeg recordedAt wasOffline accepted rejectReason offRouteKm")
      .sort({ recordedAt: 1 })
      .limit(50000)
      .lean();

    const full = parseBoolean(req.query.full, false);
    const summary = summarisePath(pings, {
      minStopMinutes: req.company.trackingConfig().minStopMinutes,
    });

    return res.json({
      trip: {
        id: String(trip._id),
        tripNumber: trip.tripNumber,
        status: trip.status,
        origin: trip.origin,
        destination: trip.destination,
        startedAt: trip.startedAt,
        deliveredAt: trip.deliveredAt,
      },
      points: full
        ? pings
        : simplifyPath(
            pings.map((p) => ({ lat: p.lat, lng: p.lng, recordedAt: p.recordedAt })),
            0.05
          ),
      pointCount: pings.length,
      simplified: !full,
      summary: {
        ...summary,
        drivingTime: formatDuration(summary.movingMinutes),
        totalTime: formatDuration(summary.durationMinutes),
      },
      plannedRoute: {
        distanceKm: round(trip.plannedRoute?.distanceKm || 0),
        points: simplifyPath(
          (trip.plannedRoute?.points || []).map((p) => ({ lat: p.lat, lng: p.lng })),
          0.02
        ),
      },
      /*
       * How many fixes the server would not count, and why. Surfaced rather
       * than hidden: a tracker quietly producing rubbish for a fortnight looks
       * exactly like a lorry standing still, and this is the number that tells
       * the two apart.
       */
      rejected: includeRejected
        ? pings.filter((p) => !p.accepted).length
        : await LocationPing.countDocuments({ tripId: trip._id, accepted: false }),
    });
  })
);

/* ---- POST /api/v1/tracking/history/:tripId/resummarise ----
 * Rebuild the banked distance and stop list from the stored track.
 *
 * Needed when a late backlog arrives after a trip was closed — the phone had
 * been offline since Tuesday and only reconnected on Friday. The trip's
 * distance was banked without those points, and this is what corrects it.
 */
router.post(
  "/history/:tripId/resummarise",
  requirePermission("trips.manage"),
  handler(async (req, res) => {
    const trip = await Trip.findOne({ _id: req.params.tripId, companyId: req.companyId });
    if (!trip) throw errors.tripNotFound();

    const journey = await summariseJourney(trip, {
      minStopMinutes: req.company.trackingConfig().minStopMinutes,
    });

    return res.json({
      journey,
      message: `Recalculated from ${journey.pingCount} location points: ${journey.distanceKm} km.`,
    });
  })
);

/* ---- GET /api/v1/tracking/vehicle/:vehicleId ----
 * Where one lorry is, whether or not it is on a trip. This is what the fleet
 * list opens, and the reason VehicleState exists as its own collection.
 */
router.get(
  "/vehicle/:vehicleId",
  requirePermission("tracking.view"),
  handler(async (req, res) => {
    const vehicle = await Vehicle.findOne({ _id: req.params.vehicleId, companyId: req.companyId });
    if (!vehicle) throw errors.vehicleNotFound();

    const state = await VehicleState.findOne({ vehicleId: vehicle._id }).lean();
    const [decorated] = state ? decorateStaleness([state], req.company) : [null];

    return res.json({
      vehicle: {
        id: String(vehicle._id),
        registrationNumber: vehicle.registrationNumber,
        status: vehicle.status,
      },
      state: decorated,
      tracking: resolveInterval(req.company, vehicle),
    });
  })
);

module.exports = router;
