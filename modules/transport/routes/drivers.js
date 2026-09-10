const express = require("express");

const Driver = require("../models/Driver");
const Trip = require("../models/Trip");
const Payment = require("../models/Payment");
const Account = require("../../../models/Account");
const { errors, handler } = require("../../../utils/apiError");
const {
  parseText,
  parseOptionalText,
  parsePhone,
  parseAmount,
  parseDate,
  parseEnum,
  parseBoolean,
} = require("../../../utils/validate");
const { requireAuth, requirePermission } = require("../../../middleware/auth");
const { round } = require("../utils/geo");
const audit = require("../../../utils/audit");

const { DRIVER_STATUSES } = Driver;

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/drivers ================= */
router.get(
  "/",
  requirePermission("drivers.view"),
  handler(async (req, res) => {
    const query = { companyId: req.companyId };
    if (req.query.active !== "all") query.isActive = req.query.active !== "false";
    if (req.query.status) query.status = parseEnum(req.query.status, "status", DRIVER_STATUSES);
    if (req.query.q) {
      const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.name = { $regex: safe, $options: "i" };
    }

    const drivers = await Driver.find(query).sort({ name: 1 }).limit(500).lean();

    /* The virtual does not survive .lean(), and the yard wants this column. */
    const rows = drivers.map((d) => ({
      ...d,
      outstandingFee: round((d.totals?.feesEarned || 0) - (d.totals?.feesPaid || 0)),
    }));

    return res.json({
      drivers: rows,
      summary: {
        total: rows.length,
        available: rows.filter((d) => d.status === "AVAILABLE").length,
        onTrip: rows.filter((d) => d.status === "ON_TRIP").length,
        onLeave: rows.filter((d) => d.status === "ON_LEAVE").length,
      },
    });
  })
);

/* ================= GET /api/v1/drivers/:id =================
 * The profile from the brief: trips, distance, fees, what is still owed, and
 * the trips they have run.
 */
router.get(
  "/:id",
  requirePermission("drivers.view"),
  handler(async (req, res) => {
    const driver = await Driver.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!driver) throw errors.driverNotFound();

    const canSeeMoney =
      req.account.role === "owner" ||
      (req.account.permissions || []).some((p) => p === "profit.view" || p === "drivers.payments");

    const [recentTrips, currentTrip] = await Promise.all([
      Trip.find({ companyId: req.companyId, driverId: driver._id })
        .select("tripNumber status origin destination startedAt closedAt journey.distanceKm")
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      driver.currentTripId
        ? Trip.findById(driver.currentTripId)
            .select("tripNumber status origin destination vehicleRegistration lastPosition")
            .lean()
        : null,
    ]);

    const t = driver.totals || {};
    return res.json({
      driver,
      currentTrip,
      recentTrips,
      stats: {
        trips: t.trips || 0,
        distanceKm: round(t.distanceKm || 0),
        ...(canSeeMoney
          ? {
              feesEarned: round(t.feesEarned || 0),
              feesPaid: round(t.feesPaid || 0),
              advances: round(t.advances || 0),
              /*
               * What the yard actually argues about on a Saturday: earned, less
               * what has been handed over, less anything drawn in advance.
               */
              outstanding: round((t.feesEarned || 0) - (t.feesPaid || 0) - (t.advances || 0)),
            }
          : {}),
      },
      licence: driver.licenceExpiry
        ? {
            number: driver.licenceNumber,
            expiresOn: driver.licenceExpiry,
            daysRemaining: Math.ceil((new Date(driver.licenceExpiry) - Date.now()) / 86400000),
            isExpired: new Date(driver.licenceExpiry) < new Date(),
          }
        : null,
    });
  })
);

/* ================= POST /api/v1/drivers ================= */
router.post(
  "/",
  requirePermission("drivers.manage"),
  handler(async (req, res) => {
    const doc = readBody(req);
    try {
      const driver = await Driver.create({ companyId: req.companyId, ...doc });
      audit.record(req, {
        action: "driver.created",
        entityType: "Driver",
        entityId: driver._id,
        entityLabel: driver.name,
      });
      return res.status(201).json({ driver });
    } catch (err) {
      if (err.code === 11000) {
        throw errors.duplicate("A driver with that licence number already exists.", {
          licenceNumber: "must be unique within your company",
        });
      }
      throw err;
    }
  })
);

/* ================= PUT /api/v1/drivers/:id ================= */
router.put(
  "/:id",
  requirePermission("drivers.manage"),
  handler(async (req, res) => {
    const driver = await Driver.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!driver) throw errors.driverNotFound();

    Object.assign(driver, readBody(req, { partial: true }));

    /* Same rule as a vehicle: ON_TRIP belongs to the trip, and clearing it here
     * would offer the dispatcher a driver who is currently in Nagpur. */
    if (req.body.status !== undefined) {
      const next = parseEnum(req.body.status, "status", DRIVER_STATUSES);
      if (driver.status === "ON_TRIP" && next !== "ON_TRIP") {
        throw errors.resourceBusy("This driver is on a trip. Close or cancel it first.", {
          tripId: driver.currentTripId ? String(driver.currentTripId) : null,
        });
      }
      if (next === "ON_TRIP") {
        throw errors.validation("A driver is put on a trip by starting a trip, not here.");
      }
      driver.status = next;
    }

    if (req.body.isActive !== undefined) driver.isActive = parseBoolean(req.body.isActive, true);

    await driver.save();
    return res.json({ driver });
  })
);

/* ================= GET /api/v1/drivers/:id/payments =================
 * The settlement ledger for one driver.
 */
router.get(
  "/:id/payments",
  requirePermission("drivers.payments"),
  handler(async (req, res) => {
    const driver = await Driver.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!driver) throw errors.driverNotFound();

    const payments = await Payment.find({
      companyId: req.companyId,
      driverId: driver._id,
      kind: { $in: ["DRIVER_PAYMENT", "DRIVER_ADVANCE"] },
    })
      .sort({ paidAt: -1 })
      .limit(200)
      .lean();

    const t = driver.totals || {};
    return res.json({
      driver: { id: String(driver._id), name: driver.name },
      payments,
      summary: {
        feesEarned: round(t.feesEarned || 0),
        feesPaid: round(t.feesPaid || 0),
        advances: round(t.advances || 0),
        outstanding: round((t.feesEarned || 0) - (t.feesPaid || 0) - (t.advances || 0)),
      },
    });
  })
);

/* ================= POST /api/v1/drivers/:id/payments =================
 * Record a settlement or an advance.
 *
 * Deliberately NOT a trip expense. The driver's fee became a cost of the trip
 * when it was booked into the expense ledger; this is the office handing over
 * the money. Recording it as an expense as well is the classic way to count the
 * same rupee twice and report half the profit the business actually made.
 */
router.post(
  "/:id/payments",
  requirePermission("drivers.payments"),
  handler(async (req, res) => {
    const driver = await Driver.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!driver) throw errors.driverNotFound();

    const kind = parseEnum(req.body.kind, "kind", ["DRIVER_PAYMENT", "DRIVER_ADVANCE"], {
      fallback: "DRIVER_PAYMENT",
    });
    const amount = parseAmount(req.body.amount, "amount", { required: true });
    if (amount <= 0) {
      throw errors.validation("A payment must be more than zero.", { amount: "must be positive" });
    }

    let tripId = null;
    let tripNumber = "";
    if (req.body.tripId) {
      const trip = await Trip.findOne({ _id: req.body.tripId, companyId: req.companyId }).select(
        "tripNumber"
      );
      if (!trip) throw errors.tripNotFound();
      tripId = trip._id;
      tripNumber = trip.tripNumber;
    }

    const payment = await Payment.create({
      companyId: req.companyId,
      kind,
      amount,
      paidAt: parseDate(req.body.paidAt, "paidAt", { fallback: new Date() }),
      method: parseEnum(req.body.method, "method", Payment.METHODS, { fallback: "CASH" }),
      referenceNumber: parseOptionalText(req.body.referenceNumber, "referenceNumber", 80),
      driverId: driver._id,
      driverName: driver.name,
      tripId,
      tripNumber,
      notes: parseOptionalText(req.body.notes, "notes", 1000),
      recordedBy: req.account._id,
      recordedByName: req.account.name,
    });

    await Driver.updateOne(
      { _id: driver._id },
      {
        $inc:
          kind === "DRIVER_ADVANCE"
            ? { "totals.advances": amount }
            : { "totals.feesPaid": amount },
      }
    );

    audit.record(req, {
      action: "driver.payment",
      entityType: "Driver",
      entityId: driver._id,
      entityLabel: driver.name,
      changes: { kind, amount },
    });

    return res.status(201).json({ payment });
  })
);

/* ================= DELETE /api/v1/drivers/:id ================= */
router.delete(
  "/:id",
  requirePermission("drivers.manage"),
  handler(async (req, res) => {
    const driver = await Driver.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!driver) throw errors.driverNotFound();
    if (driver.status === "ON_TRIP") {
      throw errors.resourceBusy("This driver is on a trip and cannot be deactivated yet.");
    }

    driver.isActive = false;
    driver.status = "INACTIVE";
    await driver.save();

    /* A driver who has left should not be able to sign in to the phone app.
     * Their trip history and their unpaid balance stay exactly as they were. */
    if (driver.accountId) {
      await Account.updateOne({ _id: driver.accountId }, { $set: { isActive: false } });
    }

    return res.json({ message: "Driver deactivated. Their trip history is kept.", driver });
  })
);

function readBody(req, { partial = false } = {}) {
  const body = req.body || {};
  const out = {};

  if (!partial || body.name !== undefined) {
    out.name = parseText(body.name, "name", { max: 80, label: "Driver name" });
  }
  if (!partial || body.phone !== undefined) {
    out.phone = parsePhone(body.phone, "phone", { required: !partial });
  }
  if (body.altPhone !== undefined) out.altPhone = parsePhone(body.altPhone, "altPhone");

  /*
   * The salaried side of what a driver costs — the same block a helper carries,
   * so the payroll can add them together. See models/Employee.js for why a
   * salary is kept apart from the per-trip fee fields below.
   */
  if (body.pay !== undefined && body.pay !== null) {
    const pay = {};
    for (const field of [
      "monthlySalary",
      "foodPerDay",
      "otherPerDay",
      "dailyWage",
      "perTripBonus",
      "paidToDate",
    ]) {
      if (body.pay[field] !== undefined) {
        pay[field] = parseAmount(body.pay[field], `pay.${field}`, { max: 1e7 });
      }
    }
    out.pay = pay;
  }
  for (const [field, max] of [
    ["address", 400],
    ["notes", 2000],
  ]) {
    if (body[field] !== undefined) out[field] = parseOptionalText(body[field], field, max);
  }
  if (body.licenceNumber !== undefined) {
    out.licenceNumber = parseOptionalText(body.licenceNumber, "licenceNumber", 40).toUpperCase();
  }
  if (body.licenceExpiry !== undefined) {
    out.licenceExpiry = parseDate(body.licenceExpiry, "licenceExpiry");
  }
  if (body.joinedOn !== undefined) out.joinedOn = parseDate(body.joinedOn, "joinedOn");
  for (const field of ["defaultTripFee", "defaultFeePerKm"]) {
    if (body[field] !== undefined) out[field] = parseAmount(body[field], field, { max: 1e6 });
  }
  return out;
}

module.exports = router;
