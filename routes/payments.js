const express = require("express");

const Payment = require("../models/Payment");
const Trip = require("../models/Trip");
const Customer = require("../models/Customer");
const { errors, handler } = require("../utils/apiError");
const {
  parseAmount,
  parseDate,
  parseEnum,
  parseOptionalText,
  parseInteger,
  isNil,
} = require("../utils/validate");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { paymentStatusFor } = require("../utils/tripFinance");
const { round } = require("../utils/geo");
const audit = require("../utils/audit");

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/payments =================
 * The cash ledger, both directions in one date-ordered list.
 */
router.get(
  "/",
  requirePermission("revenue.view"),
  handler(async (req, res) => {
    const query = { companyId: req.companyId };
    if (req.query.kind) query.kind = parseEnum(req.query.kind, "kind", Payment.PAYMENT_KINDS);
    if (req.query.tripId) query.tripId = req.query.tripId;
    if (req.query.customerId) query.customerId = req.query.customerId;

    const from = parseDate(req.query.from, "from");
    const to = parseDate(req.query.to, "to");
    if (from || to) {
      query.paidAt = {};
      if (from) query.paidAt.$gte = from;
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        query.paidAt.$lte = end;
      }
    }

    const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 500, fallback: 100 });
    const [payments, totals] = await Promise.all([
      Payment.find(query).sort({ paidAt: -1 }).limit(limit).lean(),
      Payment.aggregate([
        { $match: query },
        { $group: { _id: "$direction", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const inAmount = round(totals.find((t) => t._id === "IN")?.amount || 0);
    const outAmount = round(totals.find((t) => t._id === "OUT")?.amount || 0);

    return res.json({
      payments,
      summary: { received: inAmount, paidOut: outAmount, net: round(inAmount - outAmount) },
    });
  })
);

/* ================= POST /api/v1/payments =================
 * Record a customer receipt.
 *
 * Driver settlements go through /api/v1/drivers/:id/payments instead: they move
 * a driver's balance rather than a trip's, and keeping the two entry points
 * apart is what stops somebody recording a driver payout against a customer
 * invoice.
 */
router.post(
  "/",
  requirePermission("payments.manage"),
  handler(async (req, res) => {
    const amount = parseAmount(req.body.amount, "amount", { required: true });
    if (amount <= 0) {
      throw errors.validation("A payment must be more than zero.", { amount: "must be positive" });
    }

    let trip = null;
    if (!isNil(req.body.tripId)) {
      trip = await Trip.findOne({ _id: req.body.tripId, companyId: req.companyId });
      if (!trip) throw errors.tripNotFound();
    }

    let customer = null;
    if (!isNil(req.body.customerId)) {
      customer = await Customer.findOne({
        _id: req.body.customerId,
        companyId: req.companyId,
      }).select("name");
      if (!customer) throw errors.customerNotFound();
    }
    if (!trip && !customer) {
      throw errors.validation("A receipt must be against a trip or a customer.", {
        tripId: "one of tripId or customerId is required",
      });
    }

    const payment = await Payment.create({
      companyId: req.companyId,
      kind: "CUSTOMER_RECEIPT",
      amount,
      paidAt: parseDate(req.body.paidAt, "paidAt", { fallback: new Date() }),
      method: parseEnum(req.body.method, "method", Payment.METHODS, { fallback: "BANK_TRANSFER" }),
      referenceNumber: parseOptionalText(req.body.referenceNumber, "referenceNumber", 80),
      tripId: trip?._id || null,
      tripNumber: trip?.tripNumber || "",
      customerId: customer?._id || trip?.customerId || null,
      customerName: customer?.name || trip?.customerName || "",
      notes: parseOptionalText(req.body.notes, "notes", 1000),
      recordedBy: req.account._id,
      recordedByName: req.account.name,
    });

    /*
     * The trip's own balance is advanced here rather than being recomputed from
     * the payment ledger on every read. `advanceReceived` is capped at the
     * invoice total so an overpayment — which happens, and is usually a
     * customer settling two invoices with one transfer — cannot push a trip
     * into a negative balance and out of every receivables report.
     */
    if (trip) {
      const received = Math.min(
        round((trip.revenue.advanceReceived || 0) + amount),
        trip.revenue.total || 0
      );
      trip.revenue.advanceReceived = received;
      trip.revenue.balanceDue = round((trip.revenue.total || 0) - received);
      trip.revenue.paymentStatus = paymentStatusFor(
        trip.revenue.total || 0,
        received,
        trip.revenue.dueDate
      );
      await trip.save();
    }

    audit.record(req, {
      action: "payment.received",
      entityType: "Payment",
      entityId: payment._id,
      entityLabel: trip?.tripNumber || customer?.name || "",
      changes: { amount },
    });

    return res.status(201).json({
      payment,
      ...(trip ? { trip: { id: String(trip._id), revenue: trip.revenue } } : {}),
    });
  })
);

module.exports = router;
