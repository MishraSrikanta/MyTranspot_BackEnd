const express = require("express");

const Trip = require("../models/Trip");
const Vehicle = require("../models/Vehicle");
const Driver = require("../models/Driver");
const TripExpense = require("../models/TripExpense");
const VehicleState = require("../models/VehicleState");
const { handler } = require("../../../utils/apiError");
const { requireAuth, requirePermission } = require("../../../middleware/auth");
const { hasPermission } = require("../permissions");
const { decorateStaleness } = require("../utils/tracking");
const { round } = require("../utils/geo");

const router = express.Router();
router.use(requireAuth, requirePermission("dashboard.view"));

/* ================= GET /api/v1/dashboard =================
 * The screen the owner opens first.
 *
 * The brief is explicit that this should show the BUSINESS, not the GPS: what
 * is running, what it is earning, and what needs attention today. The map is
 * one panel on it, not the point of it.
 *
 * Everything here reads cached figures — `trip.actuals`, `vehicle.totals`,
 * `VehicleState` — rather than aggregating ledgers. This endpoint is polled
 * every minute by every user in the company, all day; it is the one screen
 * where a lazy query becomes a production problem.
 */
router.get(
  "/",
  handler(async (req, res) => {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const canSeeMoney = hasPermission(req.account, "profit.view");
    const canSeeRevenue = hasPermission(req.account, "revenue.view") || canSeeMoney;

    const [
      activeTrips,
      fleetCounts,
      driverCounts,
      monthTotals,
      todayTotals,
      pendingExpenses,
      liveStates,
      attention,
    ] = await Promise.all([
      Trip.find({
        companyId: req.companyId,
        status: { $in: ["ASSIGNED", "READY", "IN_TRANSIT", "ARRIVED", "ON_HOLD", "DELAYED"] },
      })
        .select(
          "tripNumber status customerName vehicleRegistration driverName origin destination " +
            "startedAt expectedArrival lastPosition hasRouteDeviation revenue.subTotal " +
            "plannedRoute.distanceKm journey.distanceKm"
        )
        .sort({ startedAt: -1 })
        .limit(100)
        .lean(),

      Vehicle.aggregate([
        { $match: { companyId: req.companyId, isActive: true } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      Driver.aggregate([
        { $match: { companyId: req.companyId, isActive: true } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      Trip.aggregate([
        {
          $match: {
            companyId: req.companyId,
            status: "COMPLETED",
            closedAt: { $gte: monthStart },
          },
        },
        {
          $group: {
            _id: null,
            trips: { $sum: 1 },
            revenue: { $sum: "$revenue.subTotal" },
            cost: { $sum: "$actuals.approvedCost" },
            distanceKm: { $sum: "$journey.distanceKm" },
          },
        },
      ]),

      Trip.aggregate([
        {
          $match: {
            companyId: req.companyId,
            status: "COMPLETED",
            closedAt: { $gte: todayStart },
          },
        },
        {
          $group: {
            _id: null,
            trips: { $sum: 1 },
            revenue: { $sum: "$revenue.subTotal" },
            cost: { $sum: "$actuals.approvedCost" },
          },
        },
      ]),

      TripExpense.aggregate([
        { $match: { companyId: req.companyId, approvalStatus: "PENDING" } },
        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
      ]),

      hasPermission(req.account, "tracking.view")
        ? VehicleState.find({ companyId: req.companyId })
            .select(
              "vehicleId registrationNumber tripNumber driverName lat lng speedKmh headingDeg " +
                "movementState recordedAt isOffRoute coveredKm remainingKm intervalSeconds"
            )
            .sort({ recordedAt: -1 })
            .limit(200)
            .lean()
        : [],

      needsAttention(req),
    ]);

    const fleet = { total: 0, AVAILABLE: 0, ON_TRIP: 0, MAINTENANCE: 0, OFFLINE: 0 };
    for (const f of fleetCounts) {
      fleet[f._id] = f.count;
      fleet.total += f.count;
    }
    const drivers = { total: 0, AVAILABLE: 0, ON_TRIP: 0, ON_LEAVE: 0, INACTIVE: 0 };
    for (const d of driverCounts) {
      drivers[d._id] = d.count;
      drivers.total += d.count;
    }

    const month = monthTotals[0] || {};
    const today = todayTotals[0] || {};
    const live = decorateStaleness(liveStates, req.company);

    const map = { MOVING: 0, IDLE: 0, STOPPED: 0, OFFLINE: 0, NO_DATA: 0 };
    for (const v of live) map[v.movementState] = (map[v.movementState] || 0) + 1;

    return res.json({
      headline: {
        activeTrips: activeTrips.length,
        vehicles: fleet.total,
        vehiclesOnTrip: fleet.ON_TRIP,
        driversAvailable: drivers.AVAILABLE,
        /* The money tiles are omitted entirely rather than zeroed for a user
         * without the permission: a zero on a dashboard reads as "we earned
         * nothing this month", which is a worse answer than not showing it. */
        ...(canSeeRevenue
          ? {
              revenueToday: round(today.revenue || 0),
              revenueThisMonth: round(month.revenue || 0),
            }
          : {}),
        ...(canSeeMoney
          ? {
              profitToday: round((today.revenue || 0) - (today.cost || 0)),
              profitThisMonth: round((month.revenue || 0) - (month.cost || 0)),
              marginThisMonth:
                (month.revenue || 0) > 0
                  ? round((((month.revenue || 0) - (month.cost || 0)) / month.revenue) * 100, 2)
                  : 0,
            }
          : {}),
      },

      month: {
        from: monthStart,
        trips: month.trips || 0,
        distanceKm: round(month.distanceKm || 0),
        ...(canSeeRevenue ? { revenue: round(month.revenue || 0) } : {}),
        ...(canSeeMoney
          ? {
              cost: round(month.cost || 0),
              profit: round((month.revenue || 0) - (month.cost || 0)),
            }
          : {}),
      },

      fleet,
      drivers,

      activeTrips: activeTrips.map((t) => ({
        id: String(t._id),
        tripNumber: t.tripNumber,
        status: t.status,
        customer: t.customerName,
        vehicle: t.vehicleRegistration,
        driver: t.driverName,
        from: t.origin?.name,
        to: t.destination?.name,
        startedAt: t.startedAt,
        expectedArrival: t.expectedArrival,
        /* Amber when the lorry has left its route or is past its promised
         * arrival — the two things worth a phone call. */
        isLate: !!(t.expectedArrival && new Date(t.expectedArrival) < now && t.status !== "ARRIVED"),
        hasRouteDeviation: !!t.hasRouteDeviation,
        plannedKm: round(t.plannedRoute?.distanceKm || 0),
        drivenKm: round(t.journey?.distanceKm || 0),
        progressPercent: t.lastPosition?.progressPercent || 0,
        position:
          t.lastPosition?.lat == null
            ? null
            : {
                lat: t.lastPosition.lat,
                lng: t.lastPosition.lng,
                speedKmh: t.lastPosition.speedKmh,
                recordedAt: t.lastPosition.recordedAt,
              },
        ...(canSeeRevenue ? { revenue: round(t.revenue?.subTotal || 0) } : {}),
      })),

      map: { vehicles: live, summary: map },

      /* The queue, and the things that will cost money if nobody looks at
       * them. This is the panel that makes the dashboard worth opening twice. */
      alerts: {
        pendingExpenses: {
          count: pendingExpenses[0]?.count || 0,
          amount: round(pendingExpenses[0]?.amount || 0),
          canApprove: hasPermission(req.account, "expenses.approve"),
        },
        ...attention,
      },

      serverTime: now.toISOString(),
      tracking: req.company.trackingConfig(),
    });
  })
);

/*
 * The things that need somebody to do something: papers about to lapse, trips
 * running late or off route, and licences expiring.
 *
 * Deliberately a small, fixed set. A dashboard that surfaces forty kinds of
 * warning trains its owner to ignore all of them.
 */
async function needsAttention(req) {
  const soon = new Date(Date.now() + 30 * 86400000);
  const now = new Date();

  const [expiringDocs, expiringLicences, offRoute, late, unpriced] = await Promise.all([
    Vehicle.countDocuments({
      companyId: req.companyId,
      isActive: true,
      "documents.expiresOn": { $ne: null, $lte: soon },
    }),
    Driver.countDocuments({
      companyId: req.companyId,
      isActive: true,
      licenceExpiry: { $ne: null, $lte: soon },
    }),
    Trip.countDocuments({
      companyId: req.companyId,
      status: { $in: ["IN_TRANSIT", "ARRIVED"] },
      "lastPosition.isOffRoute": true,
    }),
    Trip.countDocuments({
      companyId: req.companyId,
      status: { $in: ["IN_TRANSIT", "READY", "ASSIGNED"] },
      expectedArrival: { $ne: null, $lt: now },
    }),
    /* A running trip with no price on it. Common — rates get agreed after
     * loading — and expensive to forget about, because after delivery the
     * customer has no reason to hurry. */
    Trip.countDocuments({
      companyId: req.companyId,
      status: { $in: ["IN_TRANSIT", "ARRIVED", "DELIVERED"] },
      "revenue.subTotal": { $lte: 0 },
    }),
  ]);

  return {
    expiringDocuments: expiringDocs,
    expiringLicences,
    tripsOffRoute: offRoute,
    tripsLate: late,
    tripsWithoutPrice: unpriced,
  };
}

module.exports = router;
