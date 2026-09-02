const Trip = require("../models/Trip");
const TripExpense = require("../models/TripExpense");
const { round } = require("./geo");

/*
 * The profit engine. Every rupee figure the product shows comes through here,
 * so that revenue, cost, profit and margin are computed in exactly one place
 * and cannot disagree between the trip screen, the dashboard and the reports.
 */

/*
 * ---- the one accounting decision worth stating plainly ----
 *
 * Profit is measured against the pre-GST subtotal, never the invoice total.
 *
 * GST collected from a customer is not the transporter's money; it is held on
 * behalf of the government and paid over. A trip billed at ₹85,000 + 5% shows
 * ₹89,250 on the invoice, and an owner shown a profit computed from ₹89,250 is
 * being told they made ₹4,250 that they will have to hand over. On a fleet
 * doing a hundred trips a month, that is a business-ending sort of wrong.
 */
function computeRevenue(input = {}) {
  const freightCharges = num(input.freightCharges);
  const loadingCharges = num(input.loadingCharges);
  const unloadingCharges = num(input.unloadingCharges);
  const detentionCharges = num(input.detentionCharges);
  const otherCharges = num(input.otherCharges);

  const subTotal = round(
    freightCharges + loadingCharges + unloadingCharges + detentionCharges + otherCharges
  );

  const gstPercent = num(input.gstPercent);
  const gstAmount = round((subTotal * gstPercent) / 100);
  const total = round(subTotal + gstAmount);

  const advanceReceived = Math.min(num(input.advanceReceived), total);
  const balanceDue = round(total - advanceReceived);

  return {
    freightCharges,
    loadingCharges,
    unloadingCharges,
    detentionCharges,
    otherCharges,
    otherChargesNote: String(input.otherChargesNote || "").trim().slice(0, 200),
    gstPercent,
    gstAmount,
    subTotal,
    total,
    advanceReceived,
    balanceDue,
    paymentStatus: paymentStatusFor(total, advanceReceived, input.dueDate),
    invoiceNumber: String(input.invoiceNumber || "").trim().slice(0, 60),
    invoiceDate: input.invoiceDate || null,
    dueDate: input.dueDate || null,
  };
}

/*
 * Payment status is derived, never stored from the client. An owner who types
 * "PAID" on a trip with a balance outstanding has just lost that money from
 * every receivables report they will ever run.
 */
function paymentStatusFor(total, received, dueDate) {
  if (total <= 0) return "UNPAID";
  /* A rupee of tolerance. Bank transfers routinely land a few paise off after
   * charges, and a trip stuck at 99.98% paid clutters the receivables list for
   * ever. */
  if (received >= total - 1) return "PAID";
  if (received > 0) {
    if (dueDate && new Date(dueDate) < new Date()) return "OVERDUE";
    return "PARTIAL";
  }
  if (dueDate && new Date(dueDate) < new Date()) return "OVERDUE";
  return "UNPAID";
}

/* The budget the owner sets before the lorry leaves. Same categories as the
 * expense ledger, so the variance report can subtract them line for line. */
function computeEstimate(input = {}) {
  const fuel = num(input.fuel);
  const toll = num(input.toll);
  const driver = num(input.driver);
  const food = num(input.food);
  const allowance = num(input.allowance);
  const maintenance = num(input.maintenance);
  const other = num(input.other);
  return {
    fuel,
    toll,
    driver,
    food,
    allowance,
    maintenance,
    other,
    total: round(fuel + toll + driver + food + allowance + maintenance + other),
  };
}

/*
 * Which expense category rolls into which estimate line, so "estimated fuel vs
 * actual fuel" compares like with like. Anything unmapped lands in `other` —
 * including an owner's own custom category, which is the right home for it:
 * it was not budgeted for by name, so it is an overrun on the miscellaneous
 * line rather than a category the estimate silently gains.
 */
const CATEGORY_TO_ESTIMATE_LINE = {
  FUEL: "fuel",
  TOLL: "toll",
  DRIVER_FEE: "driver",
  FOOD: "food",
  ALLOWANCE: "allowance",
  REPAIR: "maintenance",
  MAINTENANCE: "maintenance",
};

/*
 * Recompute a trip's cost side from its expense ledger and bank the result on
 * the trip.
 *
 * Called after any change to an expense — added, approved, rejected, edited,
 * deleted. Recomputing the whole trip rather than adjusting the cached total by
 * the delta is deliberate: a delta that is applied twice, or missed because a
 * request failed halfway, leaves a cached number that is wrong for ever with
 * nothing to detect it. A full recount of one trip's expenses is a handful of
 * indexed documents, and it is self-healing.
 *
 * ---- pending is not cost ----
 * Only APPROVED expenses reach `profit`. A driver's unverified ₹2,000 fuel
 * claim is a real liability and is reported as `pendingCost`, but folding it
 * into the margin before anyone has seen the receipt is how a trip shows one
 * profit today and another tomorrow.
 */
async function recalculateTrip(tripOrId) {
  const trip =
    typeof tripOrId === "object" && tripOrId._id
      ? tripOrId
      : await Trip.findById(tripOrId);
  if (!trip) return null;

  const rows = await TripExpense.find({ tripId: trip._id }).select(
    "category customCategory amount approvalStatus"
  );

  const byCategory = new Map();
  let approvedCost = 0;
  let pendingCost = 0;
  let rejectedCost = 0;
  let pendingCount = 0;

  for (const row of rows) {
    const amount = num(row.amount);
    if (row.approvalStatus === "REJECTED") {
      rejectedCost += amount;
      continue;
    }
    if (row.approvalStatus === "PENDING") {
      pendingCost += amount;
      pendingCount += 1;
      continue;
    }
    approvedCost += amount;
    const key =
      row.category === "CUSTOM" && row.customCategory
        ? row.customCategory
        : row.category;
    byCategory.set(key, round(num(byCategory.get(key)) + amount));
  }

  approvedCost = round(approvedCost);
  pendingCost = round(pendingCost);

  const subTotal = num(trip.revenue?.subTotal);
  const profit = round(subTotal - approvedCost);
  const estimatedTotal = num(trip.estimate?.total);
  const estimatedProfit = round(subTotal - estimatedTotal);

  trip.actuals = {
    byCategory,
    approvedCost,
    pendingCost,
    rejectedCost: round(rejectedCost),
    expenseCount: rows.length,
    pendingCount,
    profit,
    /* Margin against revenue, not against cost. Zero revenue gives zero rather
     * than an Infinity that renders as an infinity sign on the dashboard. */
    marginPercent: subTotal > 0 ? round((profit / subTotal) * 100, 2) : 0,
    /* Positive means the trip came in UNDER budget, which is the direction an
     * owner reads as good news. */
    costVariance: round(estimatedTotal - approvedCost),
    profitVariance: round(profit - estimatedProfit),
    recalculatedAt: new Date(),
  };

  await trip.save();
  return trip;
}

/*
 * Estimated against actual, line by line — the planned-vs-actual view the brief
 * asks for. This is the screen that turns the product from bookkeeping into
 * business intelligence, so it is built to be read: every line carries both
 * figures, the difference, and which way that difference goes.
 */
function varianceReport(trip) {
  const est = trip.estimate || {};
  const actual = mapToObject(trip.actuals?.byCategory);

  const lines = [
    { key: "fuel", label: "Fuel" },
    { key: "toll", label: "Toll" },
    { key: "driver", label: "Driver fee" },
    { key: "food", label: "Food" },
    { key: "allowance", label: "Allowances" },
    { key: "maintenance", label: "Repair & maintenance" },
    { key: "other", label: "Other" },
  ].map((line) => {
    const estimated = num(est[line.key]);
    let spent = 0;
    for (const [category, amount] of Object.entries(actual)) {
      if ((CATEGORY_TO_ESTIMATE_LINE[category] || "other") === line.key) {
        spent += num(amount);
      }
    }
    spent = round(spent);
    const variance = round(estimated - spent);
    return {
      ...line,
      estimated,
      actual: spent,
      variance,
      /* "under" is good news, "over" is not. Naming it here rather than letting
       * each screen work out which sign is which is what keeps the colour
       * coding consistent across the app. */
      direction: variance > 0 ? "under" : variance < 0 ? "over" : "on",
    };
  });

  const subTotal = num(trip.revenue?.subTotal);
  const estimatedCost = num(est.total);
  const actualCost = num(trip.actuals?.approvedCost);

  return {
    lines,
    estimatedCost,
    actualCost,
    costVariance: round(estimatedCost - actualCost),
    estimatedProfit: round(subTotal - estimatedCost),
    actualProfit: round(subTotal - actualCost),
    profitVariance: round((subTotal - actualCost) - (subTotal - estimatedCost)),
  };
}

/*
 * The trip cost timeline — revenue at the top, then every event and every
 * rupee in the order it happened, then the profit.
 *
 * Expenses are ordered by `spentAt`, not by when the row was created. A driver
 * who logs three days of tolls on the evening the signal comes back must see
 * them at the plazas where they happened, otherwise the timeline says the lorry
 * paid every toll on the Thursday.
 */
function buildTimeline(trip, expenses = []) {
  const events = [];

  for (const ev of trip.statusHistory || []) {
    events.push({
      type: "STATUS",
      at: ev.at,
      title: statusLabel(ev.status),
      status: ev.status,
      by: ev.byName || "",
      note: ev.note || "",
      amount: null,
    });
  }

  for (const ex of expenses) {
    events.push({
      type: "EXPENSE",
      at: ex.spentAt,
      title: ex.category === "CUSTOM" && ex.customCategory ? ex.customCategory : ex.category,
      amount: num(ex.amount),
      category: ex.category,
      location: ex.location || "",
      paidBy: ex.paidBy,
      source: ex.source,
      approvalStatus: ex.approvalStatus,
      by: ex.addedByName || "",
      id: String(ex._id),
    });
  }

  if (trip.hasRouteDeviation && trip.routeDeviationAt) {
    events.push({
      type: "ALERT",
      at: trip.routeDeviationAt,
      title: "Left the planned route",
      amount: null,
      note: `${round(num(trip.maxOffRouteKm))} km off route at the furthest point`,
    });
  }

  for (const rev of trip.routeHistory || []) {
    events.push({
      type: "ROUTE",
      at: rev.changedAt,
      title: `Route changed (revision ${rev.revision + 1})`,
      amount: null,
      by: rev.changedByName || "",
      note: rev.reason || "",
    });
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const subTotal = num(trip.revenue?.subTotal);
  const cost = num(trip.actuals?.approvedCost);
  return {
    revenue: subTotal,
    invoiceTotal: num(trip.revenue?.total),
    events,
    totalCost: cost,
    profit: round(subTotal - cost),
    marginPercent: subTotal > 0 ? round(((subTotal - cost) / subTotal) * 100, 2) : 0,
  };
}

const STATUS_LABELS = {
  DRAFT: "Trip created",
  PLANNED: "Trip planned",
  ASSIGNED: "Vehicle and driver assigned",
  READY: "Loaded and ready",
  IN_TRANSIT: "Trip started",
  ARRIVED: "Arrived at destination",
  DELIVERED: "Delivery completed",
  COMPLETED: "Trip closed",
  ON_HOLD: "Put on hold",
  DELAYED: "Marked delayed",
  CANCELLED: "Trip cancelled",
};

const statusLabel = (s) => STATUS_LABELS[s] || s;

function mapToObject(m) {
  if (!m) return {};
  if (m instanceof Map) return Object.fromEntries(m);
  if (typeof m.toObject === "function") return m.toObject();
  return { ...m };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  computeRevenue,
  computeEstimate,
  paymentStatusFor,
  recalculateTrip,
  varianceReport,
  buildTimeline,
  statusLabel,
  mapToObject,
  CATEGORY_TO_ESTIMATE_LINE,
};
