const express = require("express");

const TripExpense = require("../models/TripExpense");
const Trip = require("../models/Trip");
const { errors, handler } = require("../utils/apiError");
const {
  parseAmount,
  parseEnum,
  parseDate,
  parseText,
  parseOptionalText,
  parseInteger,
} = require("../utils/validate");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { recalculateTrip } = require("../utils/tripFinance");
const { hasPermission } = require("../utils/permissions");
const { round } = require("../utils/geo");
const { addExpense } = require("../utils/expenseEntry");
const audit = require("../utils/audit");

const {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  PAID_BY,
  APPROVAL_STATUSES,
} = TripExpense;

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/expenses =================
 * The expense ledger across trips — what the expense-analysis report and the
 * approval queue are both drawn from.
 */
router.get(
  "/",
  requirePermission("expenses.view"),
  handler(async (req, res) => {
    const query = { companyId: req.companyId };

    if (req.query.tripId) query.tripId = req.query.tripId;
    if (req.query.vehicleId) query.vehicleId = req.query.vehicleId;
    if (req.query.driverId) query.driverId = req.query.driverId;
    if (req.query.category) {
      query.category = parseEnum(req.query.category, "category", EXPENSE_CATEGORIES);
    }
    if (req.query.approvalStatus) {
      query.approvalStatus = parseEnum(
        req.query.approvalStatus,
        "approvalStatus",
        APPROVAL_STATUSES
      );
    }
    if (req.query.source) {
      query.source = parseEnum(req.query.source, "source", TripExpense.EXPENSE_SOURCES);
    }

    const from = parseDate(req.query.from, "from");
    const to = parseDate(req.query.to, "to");
    if (from || to) {
      query.spentAt = {};
      if (from) query.spentAt.$gte = from;
      if (to) query.spentAt.$lte = endOfDay(to);
    }

    const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 500, fallback: 100 });
    const page = parseInteger(req.query.page, "page", { min: 1, max: 10000, fallback: 1 });

    const [expenses, total, totals] = await Promise.all([
      TripExpense.find(query).sort({ spentAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      TripExpense.countDocuments(query),
      TripExpense.aggregate([
        { $match: query },
        { $group: { _id: "$approvalStatus", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const summary = { approved: 0, pending: 0, rejected: 0, pendingCount: 0 };
    for (const row of totals) {
      if (row._id === "APPROVED") summary.approved = round(row.amount);
      if (row._id === "REJECTED") summary.rejected = round(row.amount);
      if (row._id === "PENDING") {
        summary.pending = round(row.amount);
        summary.pendingCount = row.count;
      }
    }

    return res.json({ expenses, summary, page, limit, total, pages: Math.ceil(total / limit) });
  })
);

/* ================= GET /api/v1/expenses/pending =================
 * The approval queue — the accountant's working screen.
 */
router.get(
  "/pending",
  requirePermission("expenses.approve"),
  handler(async (req, res) => {
    const expenses = await TripExpense.find({
      companyId: req.companyId,
      approvalStatus: "PENDING",
    })
      .sort({ spentAt: 1 })
      .limit(500)
      .lean();

    return res.json({
      expenses,
      count: expenses.length,
      totalAmount: round(expenses.reduce((sum, e) => sum + (e.amount || 0), 0)),
    });
  })
);

/* ================= POST /api/v1/expenses =================
 * Add a line to a trip's cost ledger.
 *
 * This is the most-used write in the whole product — a driver at a fuel pump,
 * an owner at a desk — so it is deliberately forgiving about everything except
 * the two things that must be right: which trip, and how much.
 */
router.post(
  "/",
  requirePermission("expenses.manage"),
  handler(async (req, res) => {
    const trip = await Trip.findOne({ _id: req.body.tripId, companyId: req.companyId });
    if (!trip) throw errors.tripNotFound();

    /* Every rule about what an expense is, who has to approve it and what is
     * safe to retry lives in utils/expenseEntry.js, because the driver's own
     * route adds expenses too and the two must not drift apart. */
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
      changes: {
        amount: result.amount,
        category: result.category,
        approvalStatus: result.expense.approvalStatus,
      },
    });

    return res.status(201).json({
      expense: result.expense,
      trip: { id: String(trip._id), actuals: result.trip.actuals },
      ...(result.message ? { message: result.message } : {}),
    });
  })
);

/* ================= PUT /api/v1/expenses/:id ================= */
router.put(
  "/:id",
  requirePermission("expenses.manage"),
  handler(async (req, res) => {
    const expense = await TripExpense.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!expense) throw errors.expenseNotFound();

    const trip = await Trip.findById(expense.tripId);
    if (trip?.isClosed()) {
      throw errors.badTransition("That trip is closed and its costs are final.");
    }

    /*
     * An approved expense cannot be quietly edited by whoever entered it —
     * that would let a driver book ₹500 for approval and then raise it to
     * ₹5,000 afterwards. Editing one is an approver's act, and it drops back
     * into the queue.
     */
    if (expense.approvalStatus === "APPROVED" && !hasPermission(req.account, "expenses.approve")) {
      throw errors.forbidden("This expense has been approved. Ask an approver to change it.");
    }

    const before = { amount: expense.amount, category: expense.category };

    if (req.body.amount !== undefined) {
      expense.amount = parseAmount(req.body.amount, "amount", { required: true, max: 1e8 });
    }
    if (req.body.category !== undefined) {
      expense.category = parseEnum(req.body.category, "category", EXPENSE_CATEGORIES);
      if (expense.category === "CUSTOM") {
        expense.customCategory = parseText(req.body.customCategory, "customCategory", { max: 60 });
      }
    }
    if (req.body.spentAt !== undefined) {
      expense.spentAt = parseDate(req.body.spentAt, "spentAt", { required: true });
    }
    for (const [field, max] of [
      ["location", 160],
      ["referenceNumber", 80],
      ["receiptUrl", 500],
      ["notes", 1000],
      ["unit", 20],
    ]) {
      if (req.body[field] !== undefined) {
        expense[field] = parseOptionalText(req.body[field], field, max);
      }
    }
    if (req.body.paidBy !== undefined) {
      expense.paidBy = parseEnum(req.body.paidBy, "paidBy", PAID_BY);
    }
    if (req.body.paymentMethod !== undefined) {
      expense.paymentMethod = parseEnum(req.body.paymentMethod, "paymentMethod", PAYMENT_METHODS);
    }

    /* An amount that changed after approval has to be looked at again. */
    if (expense.approvalStatus === "APPROVED" && before.amount !== expense.amount) {
      expense.approvalStatus = "PENDING";
      expense.verifiedBy = null;
      expense.verifiedByName = "";
      expense.verifiedAt = null;
    }

    await expense.save();
    const updated = trip ? await recalculateTrip(trip) : null;

    audit.record(req, {
      action: "expense.updated",
      entityType: "TripExpense",
      entityId: expense._id,
      entityLabel: expense.tripNumber,
      changes: audit.diff(before, expense.toObject(), ["amount", "category"]),
    });

    return res.json({ expense, trip: updated ? { actuals: updated.actuals } : null });
  })
);

/* ================= POST /api/v1/expenses/:id/approve =================
 * The audit gate. Approving is what moves an entry into the trip cost, so it is
 * a permission of its own and never bundled with being able to add one.
 */
router.post(
  "/:id/approve",
  requirePermission("expenses.approve"),
  handler(async (req, res) => {
    const expense = await TripExpense.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!expense) throw errors.expenseNotFound();

    /*
     * Nobody approves their own claim. Without this the workflow is decoration:
     * a driver with the approve permission simply ticks their own fuel bill,
     * and the queue proves nothing to anyone.
     */
    if (String(expense.addedBy || "") === String(req.account._id)) {
      throw errors.forbidden("An expense cannot be approved by the person who entered it.");
    }

    expense.approvalStatus = "APPROVED";
    expense.verifiedBy = req.account._id;
    expense.verifiedByName = req.account.name;
    expense.verifiedAt = new Date();
    expense.rejectionReason = "";
    await expense.save();

    const trip = await Trip.findById(expense.tripId);
    const updated = trip ? await recalculateTrip(trip) : null;

    audit.record(req, {
      action: "expense.approved",
      entityType: "TripExpense",
      entityId: expense._id,
      entityLabel: `${expense.tripNumber} ${expense.category} ${expense.amount}`,
    });

    return res.json({ expense, trip: updated ? { actuals: updated.actuals } : null });
  })
);

/* ================= POST /api/v1/expenses/:id/reject ================= */
router.post(
  "/:id/reject",
  requirePermission("expenses.approve"),
  handler(async (req, res) => {
    const expense = await TripExpense.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!expense) throw errors.expenseNotFound();

    /* A reason is required. A rejection with no explanation is one the driver
     * will simply enter again tomorrow. */
    const reason = parseText(req.body.reason, "reason", {
      max: 300,
      label: "A reason for the rejection",
    });

    expense.approvalStatus = "REJECTED";
    expense.verifiedBy = req.account._id;
    expense.verifiedByName = req.account.name;
    expense.verifiedAt = new Date();
    expense.rejectionReason = reason;
    await expense.save();

    const trip = await Trip.findById(expense.tripId);
    const updated = trip ? await recalculateTrip(trip) : null;

    audit.record(req, {
      action: "expense.rejected",
      entityType: "TripExpense",
      entityId: expense._id,
      entityLabel: `${expense.tripNumber} ${expense.category} ${expense.amount}`,
      note: reason,
    });

    return res.json({ expense, trip: updated ? { actuals: updated.actuals } : null });
  })
);

/* ================= DELETE /api/v1/expenses/:id =================
 * A real delete, and the only one in the system.
 *
 * An expense is not a historical record in the way a trip is — a duplicated
 * fuel entry is a mistake, not an event, and leaving it as a rejected row
 * clutters every ledger it appears in for ever. The audit log keeps what it was
 * and who removed it, which is what a query six months later needs.
 */
router.delete(
  "/:id",
  requirePermission("expenses.manage"),
  handler(async (req, res) => {
    const expense = await TripExpense.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!expense) throw errors.expenseNotFound();

    const trip = await Trip.findById(expense.tripId);
    if (trip?.isClosed()) {
      throw errors.badTransition("That trip is closed and its costs are final.");
    }
    if (expense.approvalStatus === "APPROVED" && !hasPermission(req.account, "expenses.approve")) {
      throw errors.forbidden("This expense has been approved. Ask an approver to remove it.");
    }

    audit.record(req, {
      action: "expense.deleted",
      entityType: "TripExpense",
      entityId: expense._id,
      entityLabel: expense.tripNumber,
      changes: {
        amount: expense.amount,
        category: expense.category,
        spentAt: expense.spentAt,
        addedByName: expense.addedByName,
      },
    });

    await expense.deleteOne();
    const updated = trip ? await recalculateTrip(trip) : null;

    return res.json({
      message: "Expense removed.",
      trip: updated ? { actuals: updated.actuals } : null,
    });
  })
);

function endOfDay(d) {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}

module.exports = router;
