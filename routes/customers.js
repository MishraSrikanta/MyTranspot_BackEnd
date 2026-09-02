const express = require("express");

const Customer = require("../models/Customer");
const Trip = require("../models/Trip");
const { errors, handler } = require("../utils/apiError");
const {
  parseText,
  parseOptionalText,
  parsePhone,
  parseInteger,
  parseAmount,
  parseBoolean,
} = require("../utils/validate");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { round } = require("../utils/geo");

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/customers ================= */
router.get(
  "/",
  requirePermission("customers.view"),
  handler(async (req, res) => {
    const query = { companyId: req.companyId };
    if (req.query.active !== "all") query.isActive = req.query.active !== "false";
    if (req.query.q) {
      /* Escaped before it reaches the regex. An unescaped search box is a way
       * to hand the database a pattern that never terminates. */
      const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.name = { $regex: safe, $options: "i" };
    }

    const customers = await Customer.find(query).sort({ name: 1 }).limit(500).lean();
    return res.json({ customers });
  })
);

/* ================= GET /api/v1/customers/:id =================
 * The profile, with the profitability figures the brief asks for.
 */
router.get(
  "/:id",
  requirePermission("customers.view"),
  handler(async (req, res) => {
    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!customer) throw errors.customerNotFound();

    /*
     * Profitability is aggregated on demand rather than cached on the customer.
     * Unlike a vehicle's lifetime distance, this figure has to respond to a
     * date range — "are they profitable THIS quarter" is the question that
     * actually gets asked — and a cached lifetime total cannot answer it.
     */
    const canSeeMoney = req.account.role === "owner" ||
      (req.account.permissions || []).includes("profit.view");

    const [summary] = await Trip.aggregate([
      {
        $match: {
          companyId: customer.companyId,
          customerId: customer._id,
          status: "COMPLETED",
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
    ]);

    const openBalance = await Trip.aggregate([
      {
        $match: {
          companyId: customer.companyId,
          customerId: customer._id,
          "revenue.paymentStatus": { $in: ["UNPAID", "PARTIAL", "OVERDUE"] },
        },
      },
      { $group: { _id: null, balance: { $sum: "$revenue.balanceDue" } } },
    ]);

    const revenue = round(summary?.revenue || 0);
    const cost = round(summary?.cost || 0);

    return res.json({
      customer,
      stats: {
        trips: summary?.trips || 0,
        distanceKm: round(summary?.distanceKm || 0),
        outstanding: round(openBalance[0]?.balance || 0),
        /* Money is withheld from a user without profit.view rather than the
         * whole endpoint being refused: the dispatcher legitimately needs the
         * customer's phone number and address. */
        ...(canSeeMoney
          ? {
              revenue,
              cost,
              profit: round(revenue - cost),
              marginPercent: revenue > 0 ? round(((revenue - cost) / revenue) * 100, 2) : 0,
            }
          : {}),
      },
    });
  })
);

/* ================= POST /api/v1/customers ================= */
router.post(
  "/",
  requirePermission("customers.manage"),
  handler(async (req, res) => {
    const doc = readBody(req);
    try {
      const customer = await Customer.create({ companyId: req.companyId, ...doc });
      return res.status(201).json({ customer });
    } catch (err) {
      /* The unique index is case-insensitive on purpose — see the model. This
       * is the message that explains why "xyz industries" was refused when the
       * list shows "XYZ Industries". */
      if (err.code === 11000) {
        throw errors.duplicate("A customer with that name already exists.", {
          name: "must be unique within your company",
        });
      }
      throw err;
    }
  })
);

/* ================= PUT /api/v1/customers/:id ================= */
router.put(
  "/:id",
  requirePermission("customers.manage"),
  handler(async (req, res) => {
    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!customer) throw errors.customerNotFound();

    Object.assign(customer, readBody(req, { partial: true }));
    if (req.body.isActive !== undefined) {
      customer.isActive = parseBoolean(req.body.isActive, true);
    }

    try {
      await customer.save();
    } catch (err) {
      if (err.code === 11000) {
        throw errors.duplicate("A customer with that name already exists.");
      }
      throw err;
    }
    return res.json({ customer });
  })
);

/* ================= DELETE /api/v1/customers/:id =================
 * Archive, never delete. The customer's past trips are the profitability
 * history, and a trip whose customer row has vanished cannot be reported on by
 * customer at all.
 */
router.delete(
  "/:id",
  requirePermission("customers.manage"),
  handler(async (req, res) => {
    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!customer) throw errors.customerNotFound();

    const open = await Trip.countDocuments({
      companyId: req.companyId,
      customerId: customer._id,
      status: { $nin: ["COMPLETED", "CANCELLED"] },
    });
    if (open > 0) {
      throw errors.resourceBusy(
        `${customer.name} has ${open} trip(s) still running. Close them before archiving.`,
        { openTrips: open }
      );
    }

    customer.isActive = false;
    await customer.save();
    return res.json({ message: "Customer archived.", customer });
  })
);

function readBody(req, { partial = false } = {}) {
  const body = req.body || {};
  const out = {};

  if (!partial || body.name !== undefined) {
    out.name = parseText(body.name, "name", { max: 160, label: "Customer name" });
  }
  for (const [field, max] of [
    ["contactPerson", 80],
    ["email", 160],
    ["gstin", 20],
    ["address", 400],
    ["city", 80],
    ["state", 80],
    ["notes", 2000],
  ]) {
    if (body[field] !== undefined) out[field] = parseOptionalText(body[field], field, max);
  }
  if (body.phone !== undefined) out.phone = parsePhone(body.phone);
  if (body.creditDays !== undefined) {
    out.creditDays = parseInteger(body.creditDays, "creditDays", { min: 0, max: 365, fallback: 0 });
  }
  if (body.creditLimit !== undefined) {
    out.creditLimit = parseAmount(body.creditLimit, "creditLimit");
  }
  return out;
}

module.exports = router;
