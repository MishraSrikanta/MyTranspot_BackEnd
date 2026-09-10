const express = require("express");

const Trip = require("../models/Trip");
const TripExpense = require("../models/TripExpense");
const Driver = require("../models/Driver");
const Vehicle = require("../models/Vehicle");
const Customer = require("../models/Customer");
const { errors, handler } = require("../../../utils/apiError");
const { parseEnum, parseBoolean, parseInteger } = require("../../../utils/validate");
const { requireAuth, requireDriver } = require("../../../middleware/auth");
const { trackingRateLimit } = require("../../../middleware/rateLimit");
const { ingestPings, resolveInterval, MAX_BATCH } = require("../utils/tracking");
const { addExpense } = require("../utils/expenseEntry");
const { routeSummary } = require("./trips");
const audit = require("../../../utils/audit");

/*
 * ================= the driver's own module =================
 *
 * Everything a person who drives needs, and nothing else: the trips they are
 * on, the customer they are delivering to, the route they are meant to follow,
 * where the lorry has actually been, what they have spent, and a way to report
 * a position from a browser when the phone app is not installed.
 *
 * ================= why this is a separate router =================
 *
 * The office endpoints answer "show me the company's trips" and then filter.
 * This one answers "show me MY trips" and cannot do anything else: the driver
 * id comes from the authenticated account, never from the request, so there is
 * no parameter to tamper with and no filter to forget. A driver login carries no
 * office permission at all (see utils/permissions.js), so the two worlds do not
 * overlap even by accident.
 *
 * The consequence worth stating: nothing in here consults a permission. The
 * authorisation is the identity. That is only safe because every query below is
 * bound to \`driver._id\`, and it is the reason each one is written out in full
 * rather than delegated to a shared list endpoint that a later edit could widen.
 */

const router = express.Router();
router.use(requireAuth);
router.use(requireDriver);

/*
 * Money a driver may see, and money they may not.
 *
 * A driver is told what the trip COSTS in the entries they themselves booked,
 * and nothing about what it earns. Revenue, profit and margin are the owner's
 * business: a driver who can read the margin on the load they are carrying is
 * one negotiation away from a problem the owner never agreed to have.
 */
function tripForDriver(trip) {
  return {
    id: String(trip._id),
    tripNumber: trip.tripNumber,
    status: trip.status,
    origin: trip.origin,
    destination: trip.destination,
    goodsDescription: trip.goodsDescription || "",
    weightTons: trip.weightTons ?? null,
    lrNumber: trip.lrNumber || "",
    ewayBillNumber: trip.ewayBillNumber || "",
    customerName: trip.customerName || "",
    vehicleRegistration: trip.vehicleRegistration || "",
    scheduledStart: trip.scheduledStart,
    expectedArrival: trip.expectedArrival,
    startedAt: trip.startedAt,
    arrivedAt: trip.arrivedAt,
    deliveredAt: trip.deliveredAt,
    closedAt: trip.closedAt,
    notes: trip.notes || "",
    plannedDistanceKm: trip.plannedRoute?.distanceKm || 0,
    drivenDistanceKm: trip.journey?.distanceKm || 0,
    lastPosition: trip.lastPosition || null,
    isOffRoute: !!trip.lastPosition?.isOffRoute,
    hasRouteDeviation: !!trip.hasRouteDeviation,
  };
}

/* The driver record behind the signed-in account, or a 404 that says so. */
async function findDriver(req) {
  const driver = await Driver.findOne({
    _id: req.account.driverId,
    companyId: req.companyId,
  });
  if (!driver) throw errors.driverNotFound();
  return driver;
}

/*
 * One of this driver's trips, by id.
 *
 * The driverId in the query is what makes every endpoint below safe: a driver
 * asking for somebody else's trip id gets the same answer as one asking for a
 * trip that does not exist, which is the only answer that does not leak whether
 * it exists.
 */
async function findMyTrip(req) {
  const trip = await Trip.findOne({
    _id: req.params.id,
    companyId: req.companyId,
    driverId: req.account.driverId,
  });
  if (!trip) throw errors.tripNotFound();
  return trip;
}

/* ================= GET /api/v1/me =================
 * What the driver's home screen is built from: who they are, what they are on
 * right now, and how often their phone is expected to report.
 */
router.get(
  "/",
  handler(async (req, res) => {
    const driver = await findDriver(req);

    const current = driver.currentTripId
      ? await Trip.findOne({
          _id: driver.currentTripId,
          companyId: req.companyId,
          driverId: driver._id,
        })
      : null;

    const vehicle = current?.vehicleId
      ? await Vehicle.findById(current.vehicleId).select(
          "registrationNumber type trackingIntervalSeconds"
        )
      : null;

    const [activeCount, pendingExpenses] = await Promise.all([
      Trip.countDocuments({
        companyId: req.companyId,
        driverId: driver._id,
        status: { $nin: ["COMPLETED", "CANCELLED", "DRAFT"] },
      }),
      TripExpense.countDocuments({
        companyId: req.companyId,
        driverId: driver._id,
        approvalStatus: "PENDING",
      }),
    ]);

    return res.json({
      driver: {
        id: String(driver._id),
        name: driver.name,
        phone: driver.phone || "",
        licenceNumber: driver.licenceNumber || "",
        status: driver.status,
      },
      company: { name: req.company.name },
      currentTrip: current ? tripForDriver(current) : null,
      vehicle: vehicle
        ? { registrationNumber: vehicle.registrationNumber, type: vehicle.type }
        : null,
      /*
       * The interval the phone — or this browser — is expected to report on,
       * resolved per vehicle. Sent here so the tracking screen never hard-codes
       * it: an owner who changes it in the office reaches every driver on their
       * next load of this endpoint.
       */
      tracking: resolveInterval(req.company, vehicle),
      /* Tracking only runs on a trip that has actually left. Said explicitly so
       * the screen can explain itself rather than just refusing. */
      canTrack: !!current && ["IN_TRANSIT", "ARRIVED", "DELAYED", "ON_HOLD"].includes(current.status),
      activeTripCount: activeCount,
      pendingExpenseCount: pendingExpenses,
      maxBatchSize: MAX_BATCH,
    });
  })
);

/* ================= GET /api/v1/me/trips =================
 * This driver's trips, newest first. `scope=active` is what the home screen
 * asks for; `all` is the history a driver needs when an old run is queried.
 */
router.get(
  "/trips",
  handler(async (req, res) => {
    const query = { companyId: req.companyId, driverId: req.account.driverId };

    const scope = parseEnum(req.query.scope, "scope", ["active", "past", "all"], {
      fallback: "active",
    });
    if (scope === "active") query.status = { $nin: ["COMPLETED", "CANCELLED", "DRAFT"] };
    if (scope === "past") query.status = { $in: ["COMPLETED", "CANCELLED"] };
    /* DRAFT trips are hidden in every scope: a trip still being keyed in by the
     * office is not an instruction to a driver yet. */
    if (scope === "all") query.status = { $ne: "DRAFT" };

    const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 100, fallback: 30 });

    const trips = await Trip.find(query)
      .sort({ startedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ trips: trips.map(tripForDriver), scope });
  })
);

/* ================= GET /api/v1/me/trips/:id =================
 * One of this driver's trips, with the two things the office screens keep in
 * other places: who to deliver to, and what has been spent so far.
 */
router.get(
  "/trips/:id",
  handler(async (req, res) => {
    const trip = await findMyTrip(req);

    /*
     * The consignee's details, which is the whole reason a driver opens a trip
     * on the road: a name, a phone number and an address to find.
     *
     * Reached through the trip rather than through the customer list — a driver
     * has no route to /customers at all, and gets exactly the record attached
     * to the load they are carrying. The credit terms and outstanding balance on
     * that customer are not in this payload and are none of a driver's business.
     */
    const customer = trip.customerId
      ? await Customer.findOne({ _id: trip.customerId, companyId: req.companyId }).select(
          "name contactPerson phone email address city state gstin"
        )
      : null;

    const expenses = await TripExpense.find({
      companyId: req.companyId,
      tripId: trip._id,
      /* Their own entries. An expense the office booked against this trip — a
       * commission, a maintenance charge — is not something a driver needs to
       * see, and some of it is money they are not party to. */
      addedBy: req.account._id,
    })
      .sort({ spentAt: -1 })
      .select("category customCategory amount spentAt location notes approvalStatus rejectionReason paymentMethod paidBy createdAt")
      .lean();

    const spent = expenses
      .filter((e) => e.approvalStatus !== "REJECTED")
      .reduce((total, e) => total + (e.amount || 0), 0);

    return res.json({
      trip: tripForDriver(trip),
      customer: customer
        ? {
            name: customer.name,
            contactPerson: customer.contactPerson || "",
            phone: customer.phone || "",
            email: customer.email || "",
            address: [customer.address, customer.city, customer.state]
              .filter(Boolean)
              .join(", "),
            gstin: customer.gstin || "",
          }
        : null,
      expenses,
      /* What this driver has booked against the trip, which is the number they
       * are actually keeping track of on the road. */
      myExpenseTotal: Math.round(spent * 100) / 100,
    });
  })
);

/* ================= GET /api/v1/me/trips/:id/route =================
 * The planned line, the line driven so far, and how far off it the lorry has
 * been. The same summary the office map draws, for the same trip.
 */
router.get(
  "/trips/:id/route",
  handler(async (req, res) => {
    const trip = await findMyTrip(req);
    return res.json({ route: await routeSummary(trip) });
  })
);

/* ================= POST /api/v1/me/trips/:id/expenses =================
 * A cost booked from the road.
 */
router.post(
  "/trips/:id/expenses",
  handler(async (req, res) => {
    const trip = await findMyTrip(req);

    if (!["ASSIGNED", "READY", "IN_TRANSIT", "ARRIVED", "DELIVERED", "ON_HOLD", "DELAYED"].includes(trip.status)) {
      throw errors.badTransition(
        `Trip ${trip.tripNumber} is ${trip.status.toLowerCase()}. You can only add costs to a trip you are on.`
      );
    }

    const result = await addExpense(
      { account: req.account, company: req.company, companyId: req.companyId, trip },
      req.body
    );

    if (result.duplicate) return res.json({ expense: result.expense, duplicate: true });

    audit.record(req, {
      action: "expense.added",
      entityType: "TripExpense",
      entityId: result.expense._id,
      entityLabel: `${trip.tripNumber} ${result.category} ${result.amount}`,
      changes: { amount: result.amount, category: result.category, source: "DRIVER" },
    });

    return res.status(201).json({
      expense: result.expense,
      message: result.message || "Saved.",
    });
  })
);

/* ================= POST /api/v1/me/location =================
 * A position, or a queue of them, from the browser.
 *
 * ================= why this exists next to /tracking/pings =================
 *
 * The phone app posts to /tracking/pings with a 90-day `driver-app` token. Not
 * every driver has the app: some have a browser and a signed-in session, and an
 * owner who cannot see that lorry has no tracking at all — which is worse than
 * a browser tab reporting every few minutes.
 *
 * So this is the same ingest, reached with an ordinary web session. The trip is
 * still resolved from the driver's own record and never from the request, the
 * same rate limit applies, and the same duplicate rules make a retry safe. What
 * a browser cannot promise is background sampling: the tab has to be open. The
 * screen says so rather than implying a coverage it does not have.
 */
router.post(
  "/location",
  trackingRateLimit,
  handler(async (req, res) => {
    const driver = await findDriver(req);

    const trip = driver.currentTripId
      ? await Trip.findOne({
          _id: driver.currentTripId,
          companyId: req.companyId,
          driverId: driver._id,
        })
      : null;

    if (!trip) {
      throw errors.resourceBusy(
        "You are not on an active trip, so there is nothing to track.",
        { action: "STOP_TRACKING" }
      );
    }
    if (!["IN_TRANSIT", "ARRIVED", "DELAYED", "ON_HOLD"].includes(trip.status)) {
      throw errors.resourceBusy(
        `Trip ${trip.tripNumber} is ${trip.status.toLowerCase()}. Tracking starts when the trip does.`,
        { action: "STOP_TRACKING", tripStatus: trip.status }
      );
    }

    const vehicle = await Vehicle.findById(trip.vehicleId);
    if (!vehicle) throw errors.vehicleNotFound();

    /* One fix, `{ pings: [...] }`, or a bare array — the same three shapes the
     * app endpoint accepts, for the same reason. */
    const pings = Array.isArray(req.body) ? req.body : req.body.pings || [req.body];

    const result = await ingestPings(
      { company: req.company, trip, vehicle, driver },
      pings,
      { wasOffline: parseBoolean(req.body.wasOffline, pings.length > 1) }
    );

    return res.json({
      ...result,
      trip: { tripNumber: trip.tripNumber, status: trip.status },
    });
  })
);

module.exports = router;
