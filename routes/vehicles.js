const express = require("express");

const Vehicle = require("../models/Vehicle");
const VehicleState = require("../models/VehicleState");
const Trip = require("../models/Trip");
const { errors, handler } = require("../utils/apiError");
const {
  parseRegistration,
  parseText,
  parseOptionalText,
  parseEnum,
  parseAmount,
  parseInteger,
  parseDate,
  parseBoolean,
} = require("../utils/validate");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { round } = require("../utils/geo");
const audit = require("../utils/audit");

const { VEHICLE_TYPES, VEHICLE_STATUSES } = Vehicle;

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/vehicles =================
 * The fleet list, with the status counters the brief puts at the top of the
 * vehicle dashboard.
 */
router.get(
  "/",
  requirePermission("vehicles.view"),
  handler(async (req, res) => {
    const query = { companyId: req.companyId };
    if (req.query.active !== "all") query.isActive = req.query.active !== "false";
    if (req.query.status) {
      query.status = parseEnum(req.query.status, "status", VEHICLE_STATUSES);
    }
    if (req.query.q) {
      const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.registrationNumber = { $regex: safe, $options: "i" };
    }

    const [vehicles, counts] = await Promise.all([
      Vehicle.find(query).sort({ registrationNumber: 1 }).limit(500).lean(),
      Vehicle.aggregate([
        { $match: { companyId: req.companyId, isActive: true } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const summary = { total: 0, AVAILABLE: 0, ON_TRIP: 0, MAINTENANCE: 0, OFFLINE: 0 };
    for (const c of counts) {
      summary[c._id] = c.count;
      summary.total += c.count;
    }

    return res.json({ vehicles, summary });
  })
);

/* ================= GET /api/v1/vehicles/:id ================= */
router.get(
  "/:id",
  requirePermission("vehicles.view"),
  handler(async (req, res) => {
    const vehicle = await Vehicle.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!vehicle) throw errors.vehicleNotFound();

    const [state, currentTrip] = await Promise.all([
      VehicleState.findOne({ vehicleId: vehicle._id }).lean(),
      vehicle.currentTripId
        ? Trip.findById(vehicle.currentTripId)
            .select("tripNumber status origin destination driverName lastPosition")
            .lean()
        : null,
    ]);

    const t = vehicle.totals || {};
    return res.json({
      vehicle,
      currentTrip,
      lastPosition: state || null,
      stats: {
        trips: t.trips || 0,
        distanceKm: round(t.distanceKm || 0),
        revenue: round(t.revenue || 0),
        cost: round(t.cost || 0),
        profit: round((t.revenue || 0) - (t.cost || 0)),
        marginPercent:
          (t.revenue || 0) > 0
            ? round((((t.revenue || 0) - (t.cost || 0)) / t.revenue) * 100, 2)
            : 0,
      },
      /* The papers the office should be chasing. Computed here rather than left
       * to the client, so the same 30-day window applies everywhere it is
       * shown. */
      expiringDocuments: expiringSoon(vehicle.documents),
    });
  })
);

/* ================= POST /api/v1/vehicles ================= */
router.post(
  "/",
  requirePermission("vehicles.manage"),
  handler(async (req, res) => {
    const limits = req.company.limits();
    if (limits.vehicles != null) {
      const count = await Vehicle.countDocuments({ companyId: req.companyId, isActive: true });
      if (count >= limits.vehicles) {
        throw errors.planLimit(
          `Your plan covers ${limits.vehicles} vehicles. Upgrade to add more.`,
          { limit: limits.vehicles, current: count }
        );
      }
    }

    const doc = readBody(req);
    try {
      const vehicle = await Vehicle.create({ companyId: req.companyId, ...doc });
      audit.record(req, {
        action: "vehicle.created",
        entityType: "Vehicle",
        entityId: vehicle._id,
        entityLabel: vehicle.registrationNumber,
      });
      return res.status(201).json({ vehicle });
    } catch (err) {
      if (err.code === 11000) {
        throw errors.duplicate("That registration number is already in your fleet.", {
          registrationNumber: "must be unique within your company",
        });
      }
      throw err;
    }
  })
);

/* ================= PUT /api/v1/vehicles/:id ================= */
router.put(
  "/:id",
  requirePermission("vehicles.manage"),
  handler(async (req, res) => {
    const vehicle = await Vehicle.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!vehicle) throw errors.vehicleNotFound();

    Object.assign(vehicle, readBody(req, { partial: true }));

    /*
     * The status is settable by hand — a lorry going in for repair is not a
     * trip event and nothing else would ever set MAINTENANCE. But it cannot be
     * moved off ON_TRIP that way: the trip owns that state, and clearing it
     * here would leave the dispatcher offered a lorry that is currently in
     * Nagpur.
     */
    if (req.body.status !== undefined) {
      const next = parseEnum(req.body.status, "status", VEHICLE_STATUSES);
      if (vehicle.status === "ON_TRIP" && next !== "ON_TRIP") {
        throw errors.resourceBusy(
          "This vehicle is on a trip. Close or cancel the trip to free it.",
          { tripId: vehicle.currentTripId ? String(vehicle.currentTripId) : null }
        );
      }
      if (next === "ON_TRIP") {
        throw errors.validation("A vehicle is put on a trip by starting a trip, not here.");
      }
      vehicle.status = next;
    }

    if (req.body.isActive !== undefined) vehicle.isActive = parseBoolean(req.body.isActive, true);

    try {
      await vehicle.save();
    } catch (err) {
      if (err.code === 11000) throw errors.duplicate("That registration number is already in your fleet.");
      throw err;
    }
    return res.json({ vehicle });
  })
);

/* ================= POST /api/v1/vehicles/:id/documents ================= */
router.post(
  "/:id/documents",
  requirePermission("vehicles.manage"),
  handler(async (req, res) => {
    const vehicle = await Vehicle.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!vehicle) throw errors.vehicleNotFound();

    vehicle.documents.push({
      type: parseText(req.body.type, "type", { max: 60, label: "Document type" }),
      number: parseOptionalText(req.body.number, "number", 80),
      issuedOn: parseDate(req.body.issuedOn, "issuedOn"),
      expiresOn: parseDate(req.body.expiresOn, "expiresOn"),
      fileUrl: parseOptionalText(req.body.fileUrl, "fileUrl", 500),
      notes: parseOptionalText(req.body.notes, "notes", 500),
    });

    await vehicle.save();
    return res.status(201).json({ documents: vehicle.documents });
  })
);

/* ================= DELETE /api/v1/vehicles/:id/documents/:docId ================= */
router.delete(
  "/:id/documents/:docId",
  requirePermission("vehicles.manage"),
  handler(async (req, res) => {
    const vehicle = await Vehicle.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!vehicle) throw errors.vehicleNotFound();

    const doc = vehicle.documents.id(req.params.docId);
    if (!doc) throw errors.notFound("That document is not on this vehicle.");
    doc.deleteOne();

    await vehicle.save();
    return res.json({ documents: vehicle.documents });
  })
);

/* ================= GET /api/v1/vehicles/documents/expiring =================
 * Every paper in the fleet lapsing inside a window. This is the screen that
 * stops a lorry being turned back at a check post.
 */
router.get(
  "/documents/expiring",
  requirePermission("vehicles.view"),
  handler(async (req, res) => {
    const days = parseInteger(req.query.days, "days", { min: 1, max: 365, fallback: 30 });
    const cutoff = new Date(Date.now() + days * 86400000);

    const vehicles = await Vehicle.find({
      companyId: req.companyId,
      isActive: true,
      "documents.expiresOn": { $ne: null, $lte: cutoff },
    })
      .select("registrationNumber documents")
      .lean();

    const rows = [];
    for (const v of vehicles) {
      for (const d of v.documents || []) {
        if (!d.expiresOn || new Date(d.expiresOn) > cutoff) continue;
        rows.push({
          vehicleId: String(v._id),
          registrationNumber: v.registrationNumber,
          type: d.type,
          number: d.number,
          expiresOn: d.expiresOn,
          daysRemaining: Math.ceil((new Date(d.expiresOn) - Date.now()) / 86400000),
          /* Already lapsed is a different urgency from lapsing on Friday, and
           * the list has to sort them together. */
          isExpired: new Date(d.expiresOn) < new Date(),
        });
      }
    }
    rows.sort((a, b) => new Date(a.expiresOn) - new Date(b.expiresOn));

    return res.json({ days, documents: rows });
  })
);

/* ================= DELETE /api/v1/vehicles/:id =================
 * Retire, never delete: the lorry's trips are the fleet's history.
 */
router.delete(
  "/:id",
  requirePermission("vehicles.manage"),
  handler(async (req, res) => {
    const vehicle = await Vehicle.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!vehicle) throw errors.vehicleNotFound();
    if (vehicle.status === "ON_TRIP") {
      throw errors.resourceBusy("This vehicle is on a trip and cannot be retired yet.");
    }

    vehicle.isActive = false;
    vehicle.status = "OFFLINE";
    await vehicle.save();

    audit.record(req, {
      action: "vehicle.retired",
      entityType: "Vehicle",
      entityId: vehicle._id,
      entityLabel: vehicle.registrationNumber,
    });

    return res.json({ message: "Vehicle retired. Its trip history is kept.", vehicle });
  })
);

function expiringSoon(documents, days = 30) {
  const cutoff = Date.now() + days * 86400000;
  return (documents || [])
    .filter((d) => d.expiresOn && new Date(d.expiresOn).getTime() <= cutoff)
    .map((d) => ({
      type: d.type,
      number: d.number,
      expiresOn: d.expiresOn,
      daysRemaining: Math.ceil((new Date(d.expiresOn) - Date.now()) / 86400000),
      isExpired: new Date(d.expiresOn) < new Date(),
    }))
    .sort((a, b) => new Date(a.expiresOn) - new Date(b.expiresOn));
}

function readBody(req, { partial = false } = {}) {
  const body = req.body || {};
  const out = {};

  if (!partial || body.registrationNumber !== undefined) {
    out.registrationNumber = parseRegistration(body.registrationNumber);
  }
  if (body.type !== undefined) {
    out.type = parseEnum(body.type, "type", VEHICLE_TYPES, { fallback: "TRUCK" });
  }
  if (body.ownership !== undefined) {
    out.ownership = parseEnum(body.ownership, "ownership", ["OWNED", "LEASED", "ATTACHED"], {
      fallback: "OWNED",
    });
  }
  for (const [field, max] of [
    ["make", 60],
    ["model", 60],
    ["ownerName", 120],
    ["notes", 2000],
  ]) {
    if (body[field] !== undefined) out[field] = parseOptionalText(body[field], field, max);
  }
  if (body.year !== undefined) {
    out.year = parseInteger(body.year, "year", { min: 1950, max: 2100, fallback: null });
  }
  /*
   * What the vehicle costs to run and to own.
   *
   * Nested rather than flattened onto the vehicle because the two halves are
   * read together by everything that uses them — the quote builder wants the
   * per-kilometre figures, the profit-and-loss report wants the monthly ones —
   * and because a flat vehicle document with fourteen more money fields on it
   * becomes impossible to read.
   */
  if (body.runningCost !== undefined && body.runningCost !== null) {
    const rc = {};
    for (const field of [
      "maintenancePerKm",
      "tyresPerKm",
      "otherPerKm",
      "tollPerKm",
      "emiPerMonth",
      "insurancePerMonth",
      "permitPerMonth",
      "parkingPerMonth",
      "otherPerMonth",
    ]) {
      if (body.runningCost[field] !== undefined) {
        rc[field] = parseAmount(body.runningCost[field], `runningCost.${field}`, { max: 1e7 });
      }
    }
    if (body.runningCost.emiEndsOn !== undefined) {
      rc.emiEndsOn = parseDate(body.runningCost.emiEndsOn, "runningCost.emiEndsOn");
    }
    out.runningCost = rc;
  }

  for (const field of ["capacityTons", "averageKmPerLitre", "fuelTankLitres", "odometerKm"]) {
    if (body[field] !== undefined) out[field] = parseAmount(body[field], field, { max: 1e7 });
  }
  if (body.axles !== undefined) {
    out.axles = parseInteger(body.axles, "axles", { min: 0, max: 20, fallback: 0 });
  }
  return out;
}

module.exports = router;
