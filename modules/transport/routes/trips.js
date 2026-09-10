const express = require("express");

const Trip = require("../models/Trip");
const TripExpense = require("../models/TripExpense");
const Vehicle = require("../models/Vehicle");
const Driver = require("../models/Driver");
const Customer = require("../models/Customer");
const LocationPing = require("../models/LocationPing");
const Counter = require("../../../models/Counter");
const { errors, handler } = require("../../../utils/apiError");
const {
  parseText,
  parseOptionalText,
  parseAmount,
  parseInteger,
  parseEnum,
  parseDate,
  parsePlace,
  parseLatLng,
  isNil,
} = require("../../../utils/validate");
const { requireAuth, requirePermission, requireAnyPermission } = require("../../../middleware/auth");
const { computeRevenue, computeEstimate, recalculateTrip, varianceReport, buildTimeline } =
  require("../utils/tripFinance");
const {
  legalNext,
  changeStatus,
  summariseJourney,
  reassign,
} = require("../utils/tripLifecycle");
const { round, pathDistanceKm, simplifyPath } = require("../utils/geo");
const { hasPermission } = require("../permissions");
const audit = require("../../../utils/audit");

const { TRIP_STATUSES } = Trip;

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/trips =================
 * The trip list. Every filter the office actually uses, and pagination, because
 * a fleet doing a hundred trips a month has thousands within two years.
 */
router.get(
  "/",
  requirePermission("trips.view"),
  handler(async (req, res) => {
    const query = { companyId: req.companyId };

    if (req.query.status) {
      /* Comma-separated, so the live board can ask for everything that is
       * running in one request. */
      const wanted = String(req.query.status)
        .split(",")
        .map((s) => parseEnum(s, "status", TRIP_STATUSES));
      query.status = wanted.length === 1 ? wanted[0] : { $in: wanted };
    }
    if (req.query.active === "true") {
      query.status = { $nin: ["COMPLETED", "CANCELLED", "DRAFT"] };
    }
    for (const [param, field] of [
      ["customerId", "customerId"],
      ["vehicleId", "vehicleId"],
      ["driverId", "driverId"],
    ]) {
      if (req.query[param]) query[field] = req.query[param];
    }
    if (req.query.routeKey) query.routeKey = String(req.query.routeKey).toUpperCase();

    /*
     * Date filtering is on `startedAt` when a range is asked for, because "the
     * trips of September" means the trips that RAN in September. Filtering on
     * createdAt instead would put a trip keyed in on the 30th of August into
     * August's figures even though the lorry rolled in September.
     */
    const from = parseDate(req.query.from, "from");
    const to = parseDate(req.query.to, "to");
    if (from || to) {
      query.startedAt = {};
      if (from) query.startedAt.$gte = from;
      if (to) query.startedAt.$lte = endOfDay(to);
    }

    if (req.query.q) {
      const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { tripNumber: { $regex: safe, $options: "i" } },
        { customerName: { $regex: safe, $options: "i" } },
        { vehicleRegistration: { $regex: safe, $options: "i" } },
        { "origin.name": { $regex: safe, $options: "i" } },
        { "destination.name": { $regex: safe, $options: "i" } },
      ];
    }

    const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 200, fallback: 50 });
    const page = parseInteger(req.query.page, "page", { min: 1, max: 10000, fallback: 1 });

    const [trips, total] = await Promise.all([
      Trip.find(query)
        .select(
          "tripNumber status customerName vehicleRegistration driverName origin destination " +
            "scheduledStart expectedArrival startedAt closedAt revenue actuals journey " +
            "lastPosition hasRouteDeviation plannedRoute.distanceKm createdAt"
        )
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Trip.countDocuments(query),
    ]);

    return res.json({
      trips: trips.map((t) => redactMoney(t, req.account)),
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  })
);

/* ================= POST /api/v1/trips =================
 * Create a trip. Everything except where it is going is optional — a trip is
 * usually keyed in while somebody is on the phone, and refusing to save it
 * until the driver, the price and the route are all known means it gets written
 * on paper instead.
 */
router.post(
  "/",
  requirePermission("trips.manage"),
  handler(async (req, res) => {
    /* The plan's monthly trip allowance, counted over the calendar month. */
    const limits = req.company.limits();
    if (limits.tripsPerMonth != null) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const used = await Trip.countDocuments({
        companyId: req.companyId,
        createdAt: { $gte: monthStart },
      });
      if (used >= limits.tripsPerMonth) {
        throw errors.planLimit(
          `Your plan includes ${limits.tripsPerMonth} trips a month. Upgrade to add more.`,
          { limit: limits.tripsPerMonth, used }
        );
      }
    }

    const origin = parsePlace(req.body.origin, "origin");
    const destination = parsePlace(req.body.destination, "destination");

    const links = await resolveLinks(req, req.body);

    /* Atomic per company — see models/Counter.js for why this is not count+1. */
    const seq = await Counter.nextSequence(req.companyId, "trip");
    const tripNumber = Counter.formatNumber(req.company.tripPrefix || "TRP", seq);

    const trip = new Trip({
      companyId: req.companyId,
      tripNumber,
      sequence: seq,
      origin,
      destination,
      ...links,
      goodsDescription: parseOptionalText(req.body.goodsDescription, "goodsDescription", 300),
      weightTons: parseAmount(req.body.weightTons, "weightTons", { max: 1000 }),
      lrNumber: parseOptionalText(req.body.lrNumber, "lrNumber", 60),
      ewayBillNumber: parseOptionalText(req.body.ewayBillNumber, "ewayBillNumber", 60),
      scheduledStart: parseDate(req.body.scheduledStart, "scheduledStart"),
      expectedArrival: parseDate(req.body.expectedArrival, "expectedArrival"),
      notes: parseOptionalText(req.body.notes, "notes", 2000),
      createdBy: req.account._id,
      status: "DRAFT",
      statusHistory: [
        { status: "DRAFT", at: new Date(), by: req.account._id, byName: req.account.name },
      ],
    });

    if (req.body.revenue) {
      requirePerm(req, "revenue.manage");
      trip.revenue = computeRevenue({
        gstPercent: req.company.defaults?.gstPercent || 0,
        ...req.body.revenue,
      });
    }
    if (req.body.estimate) {
      trip.estimate = computeEstimate(req.body.estimate);
    }
    if (req.body.route) {
      applyRoute(trip, req.body.route, req.account, "Initial route");
    }

    await trip.save();

    audit.record(req, {
      action: "trip.created",
      entityType: "Trip",
      entityId: trip._id,
      entityLabel: trip.tripNumber,
    });

    return res.status(201).json({ trip });
  })
);

/* ================= GET /api/v1/trips/:id =================
 * Everything about one trip: the ledger, the timeline, the planned-versus-
 * actual comparison, and how the route has changed.
 */
router.get(
  "/:id",
  requirePermission("trips.view"),
  handler(async (req, res) => {
    const trip = await findTrip(req);

    const expenses = await TripExpense.find({ tripId: trip._id }).sort({ spentAt: 1 }).lean();

    const canSeeProfit = hasPermission(req.account, "profit.view");
    const body = {
      trip: redactMoney(trip.toObject(), req.account),
      expenses: hasPermission(req.account, "expenses.view") ? expenses : [],
      timeline: buildTimeline(trip, expenses),
      allowedTransitions: legalNext(trip.status),
      route: await routeSummary(trip),
    };
    if (canSeeProfit) body.variance = varianceReport(trip);

    return res.json(body);
  })
);

/* ================= PUT /api/v1/trips/:id =================
 * The operational details. Money is edited through its own endpoints below, so
 * that revenue.manage can be granted without also granting the ability to move
 * a lorry.
 */
router.put(
  "/:id",
  requirePermission("trips.manage"),
  handler(async (req, res) => {
    const trip = await findTrip(req);
    if (trip.isClosed()) {
      throw errors.badTransition("This trip is closed. Its details are final.");
    }

    if (req.body.origin !== undefined) trip.origin = parsePlace(req.body.origin, "origin");
    if (req.body.destination !== undefined) {
      trip.destination = parsePlace(req.body.destination, "destination");
    }

    /* Kept before the assignment, so a swapped-out lorry can be freed after the
     * save — see `reassign`. Without this the vehicle that came off the trip
     * stays marked ON_TRIP for ever. */
    const previous = { vehicleId: trip.vehicleId, driverId: trip.driverId };

    const links = await resolveLinks(req, req.body, { partial: true });
    Object.assign(trip, links);

    for (const [field, max] of [
      ["goodsDescription", 300],
      ["lrNumber", 60],
      ["ewayBillNumber", 60],
      ["notes", 2000],
    ]) {
      if (req.body[field] !== undefined) {
        trip[field] = parseOptionalText(req.body[field], field, max);
      }
    }
    if (req.body.weightTons !== undefined) {
      trip.weightTons = parseAmount(req.body.weightTons, "weightTons", { max: 1000 });
    }
    if (req.body.scheduledStart !== undefined) {
      trip.scheduledStart = parseDate(req.body.scheduledStart, "scheduledStart");
    }
    if (req.body.expectedArrival !== undefined) {
      trip.expectedArrival = parseDate(req.body.expectedArrival, "expectedArrival");
    }

    await trip.save();

    /* The fleet follows the trip. Only does anything if the trip is already
     * holding a lorry or a driver and one of them actually changed. */
    await reassign(trip, previous);

    return res.json({ trip, allowedTransitions: legalNext(trip.status) });
  })
);

/* ================= PUT /api/v1/trips/:id/revenue =================
 * What the customer is being charged, and how that figure is made up.
 */
router.put(
  "/:id/revenue",
  requirePermission("revenue.manage"),
  handler(async (req, res) => {
    const trip = await findTrip(req);
    if (trip.isClosed()) {
      throw errors.badTransition("This trip is closed. Its figures are final.");
    }

    const before = { ...trip.revenue.toObject() };
    trip.revenue = computeRevenue({
      gstPercent: trip.revenue?.gstPercent ?? req.company.defaults?.gstPercent ?? 0,
      ...trip.revenue.toObject(),
      ...req.body,
    });
    await trip.save();

    /* Recalculated because profit is measured against the subtotal, which has
     * just moved. Skipping this leaves the trip showing a margin computed from
     * the old price until somebody happens to touch an expense. */
    await recalculateTrip(trip);

    audit.record(req, {
      action: "trip.repriced",
      entityType: "Trip",
      entityId: trip._id,
      entityLabel: trip.tripNumber,
      changes: audit.diff(before, trip.revenue.toObject(), [
        "freightCharges",
        "loadingCharges",
        "unloadingCharges",
        "otherCharges",
        "gstPercent",
        "total",
      ]),
    });

    return res.json({ revenue: trip.revenue, actuals: trip.actuals });
  })
);

/* ================= PUT /api/v1/trips/:id/estimate =================
 * The budget, which is frozen once the lorry leaves.
 */
router.put(
  "/:id/estimate",
  requirePermission("trips.manage"),
  handler(async (req, res) => {
    const trip = await findTrip(req);

    /*
     * The lock is the whole point of having an estimate. Once a trip is
     * running, its budget is a historical fact; letting it be edited afterwards
     * turns the planned-versus-actual report into a record of what somebody
     * typed in after seeing the answer.
     */
    if (trip.estimate?.lockedAt) {
      throw errors.forbidden(
        "The estimate was locked when this trip started, so the planned-versus-actual figures stay honest."
      );
    }

    trip.estimate = { ...computeEstimate(req.body), lockedAt: null };
    await trip.save();
    await recalculateTrip(trip);

    return res.json({ estimate: trip.estimate, actuals: trip.actuals });
  })
);

/* ================= POST /api/v1/trips/:id/status =================
 * The one way a trip moves through its lifecycle.
 */
router.post(
  "/:id/status",
  requireAnyPermission("trips.manage", "trips.close"),
  handler(async (req, res) => {
    const trip = await findTrip(req);
    const next = parseEnum(req.body.status, "status", [...TRIP_STATUSES, "RESUME"], {
      label: "status",
    });

    /* Closing is its own permission: it banks the profit and freezes the
     * ledger, which is a different act from dispatching a lorry. */
    if (next === "COMPLETED" && !hasPermission(req.account, "trips.close")) {
      throw errors.permissionDenied("trips.close");
    }
    if (next === "CANCELLED") {
      trip.cancellationReason = parseOptionalText(req.body.reason, "reason", 300);
    }

    await changeStatus(trip, next, {
      account: req.account,
      note: parseOptionalText(req.body.note, "note", 300),
      /* The override for closing over an expense claim nobody will ever produce
       * a receipt for. Deliberate, audited, and never the default. */
      force: req.body.force === true && hasPermission(req.account, "expenses.approve"),
    });

    audit.record(req, {
      action: `trip.${trip.status.toLowerCase()}`,
      entityType: "Trip",
      entityId: trip._id,
      entityLabel: trip.tripNumber,
      note: req.body.note || "",
    });

    return res.json({
      trip,
      allowedTransitions: legalNext(trip.status),
      ...(trip.status === "COMPLETED"
        ? {
            summary: {
              distanceKm: trip.journey?.distanceKm || 0,
              revenue: trip.revenue?.subTotal || 0,
              cost: trip.actuals?.approvedCost || 0,
              profit: trip.actuals?.profit || 0,
              marginPercent: trip.actuals?.marginPercent || 0,
            },
          }
        : {}),
    });
  })
);

/* ================= PUT /api/v1/trips/:id/route =================
 * Set or change the planned route.
 *
 * The previous route is never overwritten — it is pushed onto `routeHistory`
 * with who changed it and why, and the revision number goes up. That is the
 * brief's "if the route changes the owner can see it", and it is the difference
 * between a system that can answer "why did this run cost two hundred more
 * kilometres than we quoted?" and one that cannot.
 */
router.put(
  "/:id/route",
  requirePermission("trips.manage"),
  handler(async (req, res) => {
    const trip = await findTrip(req);
    if (trip.isClosed()) throw errors.badTransition("This trip is closed.");

    const previousDistance = trip.plannedRoute?.distanceKm || 0;
    applyRoute(trip, req.body, req.account, parseOptionalText(req.body.reason, "reason", 300));
    await trip.save();

    audit.record(req, {
      action: "route.changed",
      entityType: "Trip",
      entityId: trip._id,
      entityLabel: trip.tripNumber,
      changes: {
        distanceKm: { from: previousDistance, to: trip.plannedRoute.distanceKm },
        revision: trip.plannedRoute.revision,
      },
      note: req.body.reason || "",
    });

    return res.json({
      route: await routeSummary(trip),
      /* Said plainly, because a route change usually means the quote is now
       * wrong and somebody has to decide whether to re-price. */
      message:
        trip.plannedRoute.revision > 1
          ? `Route updated to revision ${trip.plannedRoute.revision}. Planned distance is now ${trip.plannedRoute.distanceKm} km (was ${round(previousDistance)} km).`
          : `Route set. Planned distance ${trip.plannedRoute.distanceKm} km.`,
    });
  })
);

/* ================= GET /api/v1/trips/:id/route =================
 * The planned line, every superseded version of it, and the line the lorry
 * actually drove — which is what the map draws on top of each other.
 */
router.get(
  "/:id/route",
  requireAnyPermission("trips.view", "tracking.view"),
  handler(async (req, res) => res.json({ route: await routeSummary(await findTrip(req)) }))
);

/* ================= GET /api/v1/trips/:id/timeline ================= */
router.get(
  "/:id/timeline",
  requirePermission("trips.view"),
  handler(async (req, res) => {
    const trip = await findTrip(req);
    const expenses = hasPermission(req.account, "expenses.view")
      ? await TripExpense.find({ tripId: trip._id }).sort({ spentAt: 1 }).lean()
      : [];
    return res.json({ timeline: buildTimeline(trip, expenses) });
  })
);

/* ================= GET /api/v1/trips/:id/variance =================
 * Planned against actual, line by line.
 */
router.get(
  "/:id/variance",
  requirePermission("profit.view"),
  handler(async (req, res) => {
    const trip = await findTrip(req);
    return res.json({ variance: varianceReport(trip) });
  })
);

/* ================= POST /api/v1/trips/:id/recalculate =================
 * Re-derive the cost cache and the journey summary from the underlying records.
 *
 * Nothing should need this — every write path recalculates — but a repair
 * button that reads the source of truth and rebuilds the cache is worth far
 * more than the alternative on the day a cached number is wrong: a support
 * conversation, a database session, and a customer who no longer trusts the
 * figures.
 */
router.post(
  "/:id/recalculate",
  requirePermission("trips.manage"),
  handler(async (req, res) => {
    const trip = await findTrip(req);
    await summariseJourney(trip, {
      minStopMinutes: req.company.trackingConfig().minStopMinutes,
    });
    await recalculateTrip(trip);
    return res.json({ trip, variance: varianceReport(trip) });
  })
);

/* ---------------- helpers ---------------- */

async function findTrip(req) {
  const trip = await Trip.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!trip) throw errors.tripNotFound();
  return trip;
}

function requirePerm(req, permission) {
  if (!hasPermission(req.account, permission)) throw errors.permissionDenied(permission);
}

/*
 * Resolve customer, vehicle and driver, and check that the lorry and the driver
 * are actually free.
 *
 * One vehicle, one live trip, and the same for a driver. Without that check two
 * open trips end up sharing a lorry, and every location ping that arrives has
 * to be guessed at — which trip's distance does it belong to? There is no
 * correct answer once it has happened, so it is refused before it can.
 */
async function resolveLinks(req, body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.customerId !== undefined) {
    if (isNil(body.customerId)) {
      /*
       * No customer named.
       *
       * On an UPDATE that is an instruction — take the customer off this trip.
       * On a CREATE it is simply an absence: plenty of trips are keyed in before
       * anyone knows who is being billed, and the field is left at its default.
       *
       * This block used to `return out` on create, which abandoned the whole
       * function before the vehicle and driver below were ever looked at. A trip
       * created with a lorry and a driver but no customer therefore saved with
       * NEITHER, silently — and then refused to move to Assigned, because from
       * its own point of view it had nobody on it. Falling through is the fix;
       * there is nothing to set here and nothing to stop for.
       */
      if (partial) {
        out.customerId = null;
        out.customerName = "";
      }
    } else {
      const customer = await Customer.findOne({
        _id: body.customerId,
        companyId: req.companyId,
      }).select("name");
      if (!customer) throw errors.customerNotFound();
      out.customerId = customer._id;
      out.customerName = customer.name;
    }
  }

  if (body.vehicleId !== undefined) {
    if (isNil(body.vehicleId)) {
      out.vehicleId = null;
      out.vehicleRegistration = "";
    } else {
      const vehicle = await Vehicle.findOne({
        _id: body.vehicleId,
        companyId: req.companyId,
      }).select("registrationNumber status currentTripId isActive");
      if (!vehicle) throw errors.vehicleNotFound();
      if (!vehicle.isActive) {
        throw errors.validation("That vehicle has been retired.", {
          vehicleId: "is not active",
        });
      }
      if (
        vehicle.status === "ON_TRIP" &&
        String(vehicle.currentTripId || "") !== String(req.params.id || "")
      ) {
        throw errors.resourceBusy(
          `${vehicle.registrationNumber} is already on another trip.`,
          { vehicleId: String(vehicle._id), tripId: String(vehicle.currentTripId) }
        );
      }
      if (vehicle.status === "MAINTENANCE") {
        throw errors.resourceBusy(`${vehicle.registrationNumber} is in maintenance.`);
      }
      out.vehicleId = vehicle._id;
      out.vehicleRegistration = vehicle.registrationNumber;
    }
  }

  if (body.driverId !== undefined) {
    if (isNil(body.driverId)) {
      out.driverId = null;
      out.driverName = "";
    } else {
      const driver = await Driver.findOne({
        _id: body.driverId,
        companyId: req.companyId,
      }).select("name status currentTripId isActive");
      if (!driver) throw errors.driverNotFound();
      if (!driver.isActive) {
        throw errors.validation("That driver is no longer active.", { driverId: "is not active" });
      }
      if (
        driver.status === "ON_TRIP" &&
        String(driver.currentTripId || "") !== String(req.params.id || "")
      ) {
        throw errors.resourceBusy(`${driver.name} is already on another trip.`, {
          driverId: String(driver._id),
          tripId: String(driver.currentTripId),
        });
      }
      out.driverId = driver._id;
      out.driverName = driver.name;
    }
  }

  return out;
}

/*
 * Replace the planned route, keeping the old one.
 *
 * The distance is measured here from the points rather than taken from the
 * client. A client-supplied figure is what the driver fee and the fuel estimate
 * are calculated from, and a wrong one is not detectable later.
 */
function applyRoute(trip, body, account, reason) {
  const rawPoints = Array.isArray(body.points) ? body.points : [];
  if (rawPoints.length < 2) {
    throw errors.validation("A route needs at least two points.", {
      points: "must contain at least 2 coordinates",
    });
  }
  if (rawPoints.length > 5000) {
    throw errors.payloadTooLarge("That route has too many points. Simplify it before saving.", {
      points: "must contain at most 5000 coordinates",
    });
  }

  const points = rawPoints.map((p, i) => parseLatLng(p.lat, p.lng, `points[${i}]`));

  /* Push the outgoing route into the history before it is replaced. Nothing
   * else in the system records what the route used to be. */
  const current = trip.plannedRoute;
  if (current && (current.points || []).length >= 2) {
    trip.routeHistory.push({
      revision: current.revision || 1,
      points: current.points,
      distanceKm: current.distanceKm,
      reason: reason || "",
      changedBy: account?._id || null,
      changedByName: account?.name || "",
      changedAt: new Date(),
    });
  }

  const distanceKm = pathDistanceKm(points);
  trip.plannedRoute = {
    points,
    distanceKm: round(distanceKm),
    estimatedDurationMinutes: parseAmount(
      body.estimatedDurationMinutes,
      "estimatedDurationMinutes",
      { max: 100000 }
    ),
    waypoints: Array.isArray(body.waypoints)
      ? body.waypoints.map((w, i) => parsePlace(w, `waypoints[${i}]`))
      : current?.waypoints || [],
    source: parseEnum(body.source, "source", ["MANUAL", "MAP", "IMPORTED"], {
      fallback: "MANUAL",
    }),
    revision: (current?.revision || 0) + 1,
    updatedAt: new Date(),
  };
}

/*
 * What the map needs to draw a trip: the plan, the versions of the plan that
 * came before, and the line actually driven.
 *
 * The planned line is thinned before it goes out for the same reason the driven
 * one is — a route imported from a map provider can be several thousand points,
 * and thirty of those on one screen is what makes a fleet map stutter.
 */
async function routeSummary(trip) {
  const planned = trip.plannedRoute || {};
  const driven = await drivenPath(trip);
  return {
    planned: {
      revision: planned.revision || 0,
      distanceKm: round(planned.distanceKm || 0),
      estimatedDurationMinutes: planned.estimatedDurationMinutes || 0,
      source: planned.source || "MANUAL",
      updatedAt: planned.updatedAt || null,
      waypoints: planned.waypoints || [],
      points: simplifyPath(
        (planned.points || []).map((p) => ({ lat: p.lat, lng: p.lng })),
        0.02
      ),
    },
    /* Superseded versions, newest first, so the owner sees the most recent
     * change at the top of the list. */
    history: (trip.routeHistory || [])
      .slice()
      .reverse()
      .map((h) => ({
        revision: h.revision,
        distanceKm: round(h.distanceKm || 0),
        reason: h.reason,
        changedBy: h.changedByName,
        changedAt: h.changedAt,
        points: simplifyPath(
          (h.points || []).map((p) => ({ lat: p.lat, lng: p.lng })),
          0.05
        ),
      })),
    actual: {
      distanceKm: round(trip.journey?.distanceKm || 0),
      durationMinutes: trip.journey?.durationMinutes || 0,
      stopCount: trip.journey?.stopCount || 0,
      pingCount: driven.pingCount,
      points: driven.points,
      /* Null while the trip is still running: the caller can tell a live track
       * from the final one, and the final one is the only one that will not
       * change again. */
      summarisedAt: trip.journey?.summarisedAt || null,
    },
    deviation: {
      /* Raised once and left raised — the owner wants to know it happened, not
       * only whether it is happening at this second. */
      hasDeviated: !!trip.hasRouteDeviation,
      at: trip.routeDeviationAt,
      maxOffRouteKm: round(trip.maxOffRouteKm || 0),
      currentOffRouteKm: trip.lastPosition?.offRouteKm ?? null,
      isCurrentlyOffRoute: !!trip.lastPosition?.isOffRoute,
    },
    /* Planned against driven, which is the comparison that decides whether a
     * lane was quoted correctly. */
    varianceKm: round((trip.journey?.distanceKm || 0) - (planned.distanceKm || 0)),
  };
}

/*
 * The line the lorry has actually driven.
 *
 * ================= why this is not just journey.simplifiedPath =================
 *
 * `journey` is written by `summariseJourney`, which runs when a trip is closed.
 * That is the right place for the FINAL figures — they are banked onto the lorry
 * and the driver and must never drift afterwards — but it meant the driven line
 * did not exist until the trip was over. The trip screen showed a distance
 * climbing on a live run with no track next to it, which is the one thing an
 * owner opens that screen to see.
 *
 * So a running trip's line is read from the fixes themselves. A closed trip
 * keeps using the banked path: it is authoritative, already thinned, and costs
 * no query.
 *
 * The ping query is skipped entirely unless something has actually reported —
 * `lastPosition.recordedAt` is set by the first accepted fix — so a yard full of
 * planned trips does not pay for a collection scan each time one is opened.
 */
async function drivenPath(trip) {
  const banked = trip.journey?.simplifiedPath || [];
  if (banked.length >= 2) {
    return { points: banked, pingCount: trip.journey?.pingCount || banked.length };
  }
  if (!trip.lastPosition?.recordedAt) {
    return { points: [], pingCount: trip.journey?.pingCount || 0 };
  }

  const pings = await LocationPing.find({ tripId: trip._id, accepted: true })
    .select("lat lng")
    .sort({ recordedAt: 1 })
    .lean();

  return {
    /* The same 50 m tolerance the closing summary uses, so the line does not
     * visibly change shape at the moment a trip is closed. */
    points: simplifyPath(pings.map((ping) => ({ lat: ping.lat, lng: ping.lng })), 0.05),
    pingCount: pings.length,
  };
}

/*
 * Strip the money from a trip for a user without profit.view.
 *
 * Applied to the serialised object rather than by selecting fewer fields,
 * because the dispatcher still needs everything else on the same document —
 * refusing the whole trip would make the operations screen unusable to the
 * people it is for.
 */
function redactMoney(trip, account) {
  if (hasPermission(account, "profit.view")) return trip;
  const out = { ...trip };
  if (out.actuals) {
    out.actuals = {
      ...out.actuals,
      profit: undefined,
      marginPercent: undefined,
      profitVariance: undefined,
    };
  }
  if (!hasPermission(account, "revenue.view")) delete out.revenue;
  return out;
}

function endOfDay(d) {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}

module.exports = router;
module.exports.routeSummary = routeSummary;
