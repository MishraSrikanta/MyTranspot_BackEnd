const express = require("express");

const Trip = require("../models/Trip");
const TripExpense = require("../models/TripExpense");
const { handler, errors } = require("../../../utils/apiError");
const { parseDate, parseEnum, parseInteger } = require("../../../utils/validate");
const { requireAuth, requirePermission } = require("../../../middleware/auth");
const { standingCostFor } = require("../utils/standingCost");
const { round } = require("../utils/geo");

const router = express.Router();
router.use(requireAuth, requirePermission("reports.view"));

/*
 * The reports the brief asks for: profit for a period, where the money went,
 * and profitability sliced by vehicle, driver, customer and route.
 *
 * Two decisions run through every one of them.
 *
 * ---- only closed trips count ----
 * Every report below matches `status: COMPLETED`. A trip still on the road has
 * half its fuel bills unentered and its final distance unknown; including it
 * would make last month's margin change every time a driver adds a toll. The
 * dashboard shows work in progress; the reports show what actually happened.
 *
 * ---- revenue means the pre-GST subtotal ----
 * For the reason set out at the top of utils/tripFinance.js: the tax was never
 * the transporter's money, and a margin computed from the invoice total flatters
 * every figure in this file.
 */

/* ================= GET /api/v1/reports/profit =================
 * The headline: revenue, cost, profit and margin for a period, with a month-by-
 * month series behind it.
 */
/* ================= GET /api/v1/reports/pnl =================
 *
 * Am I making money?
 *
 * ================= why this is not the profit report =================
 *
 * `/profit` answers "did the loads pay": revenue from closed trips, minus what
 * was booked against those trips. Every figure in it is real and it is still not
 * the answer to the question above, because a fleet of six lorries each turning
 * a tidy profit per run can lose money every month on EMIs and wages that appear
 * in no trip's ledger.
 *
 * This report subtracts those too. It is deliberately laid out the way an
 * accountant would read it:
 *
 *   revenue                 what the loads earned, before GST
 *   − direct trip costs     diesel, tolls, driver fees, everything booked
 *   = gross profit          what /profit already showed
 *   − standing costs        EMI, insurance, permits, parking, salaries
 *   = net profit            the number that decides whether the business works
 *
 * GST is excluded from revenue throughout, for the reason set out in
 * utils/tripFinance.js: it was never the transporter's money.
 */
router.get(
  "/pnl",
  handler(async (req, res) => {
    const { from, to } = period(req);

    const [totals] = await Trip.aggregate([
      { $match: closedIn(req.companyId, from, to) },
      {
        $group: {
          _id: null,
          trips: { $sum: 1 },
          revenue: { $sum: "$revenue.subTotal" },
          invoiced: { $sum: "$revenue.total" },
          cost: { $sum: "$actuals.approvedCost" },
          distanceKm: { $sum: "$journey.distanceKm" },
        },
      },
    ]);

    /* Where the direct money went, so a loss can be explained rather than only
     * reported. Approved rows only, so this reconciles with the cost above. */
    const byCategory = await TripExpense.aggregate([
      {
        $match: {
          companyId: req.companyId,
          approvalStatus: "APPROVED",
          spentAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: "$category", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]);

    /* Per vehicle, so the owner can see WHICH lorry is the problem — the whole
     * reason a fleet report beats a company total. */
    const perVehicle = await Trip.aggregate([
      { $match: { ...closedIn(req.companyId, from, to), vehicleId: { $ne: null } } },
      {
        $group: {
          _id: "$vehicleId",
          registrationNumber: { $first: "$vehicleRegistration" },
          trips: { $sum: 1 },
          revenue: { $sum: "$revenue.subTotal" },
          cost: { $sum: "$actuals.approvedCost" },
          distanceKm: { $sum: "$journey.distanceKm" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const standing = await standingCostFor(req.companyId, { from, to });

    const revenue = round(totals?.revenue || 0);
    const directCost = round(totals?.cost || 0);
    const grossProfit = round(revenue - directCost);
    const netProfit = round(grossProfit - standing.total);
    const distanceKm = round(totals?.distanceKm || 0);

    /*
     * A vehicle carries its own standing cost — its EMI, its insurance, and any
     * helper permanently attached to it. What is left over (the office, the
     * mechanic, floating labour) is spread across the fleet by share of revenue:
     * arbitrary, unavoidable, and labelled as such so nobody mistakes it for a
     * measured figure.
     */
    const attributed = new Map(standing.byVehicle.map((row) => [row.vehicleId, row]));
    const overhead = standing.unattributedPayroll;
    const revenueTotal = perVehicle.reduce((sum, row) => sum + (row.revenue || 0), 0);

    const vehicles = perVehicle.map((row) => {
      const own = attributed.get(String(row._id))?.total || 0;
      const overheadShare =
        revenueTotal > 0 ? round((overhead * (row.revenue || 0)) / revenueTotal) : 0;
      const vehicleRevenue = round(row.revenue || 0);
      const vehicleDirect = round(row.cost || 0);
      const vehicleNet = round(vehicleRevenue - vehicleDirect - own - overheadShare);
      return {
        vehicleId: String(row._id),
        registrationNumber: row.registrationNumber || "",
        trips: row.trips,
        distanceKm: round(row.distanceKm || 0),
        revenue: vehicleRevenue,
        directCost: vehicleDirect,
        standingCost: round(own + overheadShare),
        ownStandingCost: round(own),
        overheadShare,
        grossProfit: round(vehicleRevenue - vehicleDirect),
        netProfit: vehicleNet,
        /* The two figures a transporter actually compares lorries on. */
        profitPerKm: row.distanceKm ? round(vehicleNet / row.distanceKm, 2) : 0,
        profitPerTrip: row.trips ? round(vehicleNet / row.trips) : 0,
        marginPercent: pct(vehicleNet, vehicleRevenue),
        isLoss: vehicleNet < 0,
      };
    });

    return res.json({
      period: { from, to, days: standing.days },
      summary: {
        trips: totals?.trips || 0,
        distanceKm,
        revenue,
        invoiced: round(totals?.invoiced || 0),
        directCost,
        grossProfit,
        grossMarginPercent: pct(grossProfit, revenue),
        standingCost: standing.total,
        vehicleFixedCost: standing.vehicleFixed,
        payrollCost: standing.payroll,
        netProfit,
        netMarginPercent: pct(netProfit, revenue),
        /* Said plainly, because it is the one thing the owner opened this
         * screen to find out. */
        isLoss: netProfit < 0,
        /*
         * What the fleet has to earn to break even over this period. An owner
         * staring at a loss needs to know how far off they are, and "you needed
         * ₹4.1 lakh and did ₹3.6" is a target in a way that a negative number
         * is not.
         */
        breakEvenRevenue: round(directCost + standing.total),
        revenuePerKm: distanceKm ? round(revenue / distanceKm, 2) : 0,
        netProfitPerKm: distanceKm ? round(netProfit / distanceKm, 2) : 0,
      },
      directByCategory: byCategory.map((row) => ({
        category: row._id,
        amount: round(row.amount),
        count: row.count,
        percent: pct(row.amount, directCost),
      })),
      standing: {
        days: standing.days,
        monthShare: standing.monthShare,
        daysPerMonth: standing.daysPerMonth,
        vehicleFixed: standing.vehicleFixed,
        payroll: standing.payroll,
        total: standing.total,
        vehicles: standing.vehicles,
        people: standing.payrollPeople,
      },
      vehicles,
    });
  })
);

router.get(
  "/profit",
  handler(async (req, res) => {
    const { from, to } = period(req);

    const [totals] = await Trip.aggregate([
      { $match: closedIn(req.companyId, from, to) },
      {
        $group: {
          _id: null,
          trips: { $sum: 1 },
          revenue: { $sum: "$revenue.subTotal" },
          invoiced: { $sum: "$revenue.total" },
          cost: { $sum: "$actuals.approvedCost" },
          estimatedCost: { $sum: "$estimate.total" },
          distanceKm: { $sum: "$journey.distanceKm" },
        },
      },
    ]);

    const byMonth = await Trip.aggregate([
      { $match: closedIn(req.companyId, from, to) },
      {
        $group: {
          _id: { year: { $year: "$closedAt" }, month: { $month: "$closedAt" } },
          trips: { $sum: 1 },
          revenue: { $sum: "$revenue.subTotal" },
          cost: { $sum: "$actuals.approvedCost" },
          distanceKm: { $sum: "$journey.distanceKm" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const revenue = round(totals?.revenue || 0);
    const cost = round(totals?.cost || 0);

    return res.json({
      period: { from, to },
      summary: {
        trips: totals?.trips || 0,
        revenue,
        invoiced: round(totals?.invoiced || 0),
        cost,
        profit: round(revenue - cost),
        marginPercent: pct(revenue - cost, revenue),
        distanceKm: round(totals?.distanceKm || 0),
        /* What the fleet earns per kilometre — the number transporters
         * actually compare periods with. */
        revenuePerKm: totals?.distanceKm ? round(revenue / totals.distanceKm, 2) : 0,
        costPerKm: totals?.distanceKm ? round(cost / totals.distanceKm, 2) : 0,
        /* Budget against outturn across the whole period. Positive means the
         * fleet came in under what it planned to spend. */
        estimatedCost: round(totals?.estimatedCost || 0),
        costVariance: round((totals?.estimatedCost || 0) - cost),
      },
      byMonth: byMonth.map((m) => ({
        year: m._id.year,
        month: m._id.month,
        label: `${String(m._id.month).padStart(2, "0")}/${m._id.year}`,
        trips: m.trips,
        revenue: round(m.revenue),
        cost: round(m.cost),
        profit: round(m.revenue - m.cost),
        marginPercent: pct(m.revenue - m.cost, m.revenue),
        distanceKm: round(m.distanceKm),
      })),
    });
  })
);

/* ================= GET /api/v1/reports/expenses =================
 * Where the money went, by category.
 *
 * Read from the expense ledger rather than from the trips' cached totals: the
 * cache holds a per-trip breakdown but cannot be sliced by vehicle, driver or
 * payment method, and those are the cuts that find the problem. Only APPROVED
 * rows are counted, so the total here reconciles exactly with the profit report.
 */
router.get(
  "/expenses",
  handler(async (req, res) => {
    const { from, to } = period(req);
    const match = {
      companyId: req.companyId,
      approvalStatus: "APPROVED",
      spentAt: { $gte: from, $lte: to },
    };
    if (req.query.vehicleId) match.vehicleId = req.query.vehicleId;
    if (req.query.driverId) match.driverId = req.query.driverId;

    const [byCategory, byMethod, totals] = await Promise.all([
      TripExpense.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $cond: [
                { $eq: ["$category", "CUSTOM"] },
                "$customCategory",
                "$category",
              ],
            },
            amount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { amount: -1 } },
      ]),
      TripExpense.aggregate([
        { $match: match },
        { $group: { _id: "$paymentMethod", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { amount: -1 } },
      ]),
      TripExpense.aggregate([
        { $match: match },
        { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const total = round(totals[0]?.amount || 0);

    return res.json({
      period: { from, to },
      total,
      count: totals[0]?.count || 0,
      byCategory: byCategory.map((c) => ({
        category: c._id,
        amount: round(c.amount),
        count: c.count,
        /* The share is what makes the report readable: "fuel is 48% of your
         * costs" is actionable in a way that a column of rupees is not. */
        percent: pct(c.amount, total),
      })),
      byPaymentMethod: byMethod.map((m) => ({
        method: m._id,
        amount: round(m.amount),
        count: m.count,
        percent: pct(m.amount, total),
      })),
    });
  })
);

/* ================= GET /api/v1/reports/vehicles =================
 * Profitability by lorry.
 */
router.get(
  "/vehicles",
  handler(async (req, res) => res.json(await groupedProfit(req, "$vehicleId", "vehicleRegistration")))
);

/* ================= GET /api/v1/reports/drivers =================
 * Profitability by driver.
 *
 * The brief makes a point that is worth honouring in the API and not only in
 * the UI: a driver does not generate the revenue, so this is not "driver
 * profit". It is the profitability of the trips they ran, and the response says
 * so in its own field name — because whatever the screen is called, somebody
 * will eventually read this JSON and draw a conclusion about a person's worth
 * from it.
 */
router.get(
  "/drivers",
  handler(async (req, res) => {
    const data = await groupedProfit(req, "$driverId", "driverName");
    return res.json({
      ...data,
      basis:
        "Profitability of the trips each driver ran. Drivers do not generate revenue independently; " +
        "these figures reflect the loads they were assigned.",
    });
  })
);

/* ================= GET /api/v1/reports/customers =================
 * Which customers are actually worth running for.
 */
router.get(
  "/customers",
  handler(async (req, res) => res.json(await groupedProfit(req, "$customerId", "customerName")))
);

/* ================= GET /api/v1/reports/routes =================
 * Lane profitability — the comparison that decides which work to chase.
 */
router.get(
  "/routes",
  handler(async (req, res) => {
    const data = await groupedProfit(req, "$routeKey", "routeKey");
    return res.json({
      ...data,
      rows: data.rows.map((r) => {
        /* routeKey is stored as "ORIGIN|DESTINATION" so two spellings of the
         * same lane cannot become two rows. Split for display. */
        const [origin, destination] = String(r.label || "").split("|");
        return { ...r, origin: origin || "", destination: destination || "" };
      }),
    });
  })
);

/* ================= GET /api/v1/reports/variance =================
 * Estimated against actual across every closed trip in the period — the
 * planned-versus-actual picture at fleet scale rather than per trip.
 */
router.get(
  "/variance",
  handler(async (req, res) => {
    const { from, to } = period(req);

    const trips = await Trip.find(closedIn(req.companyId, from, to))
      .select("tripNumber customerName vehicleRegistration estimate actuals revenue closedAt")
      .sort({ closedAt: -1 })
      .limit(1000)
      .lean();

    const rows = trips.map((t) => {
      const estimatedCost = round(t.estimate?.total || 0);
      const actualCost = round(t.actuals?.approvedCost || 0);
      const revenue = round(t.revenue?.subTotal || 0);
      return {
        tripId: String(t._id),
        tripNumber: t.tripNumber,
        customer: t.customerName,
        vehicle: t.vehicleRegistration,
        closedAt: t.closedAt,
        revenue,
        estimatedCost,
        actualCost,
        costVariance: round(estimatedCost - actualCost),
        estimatedProfit: round(revenue - estimatedCost),
        actualProfit: round(revenue - actualCost),
      };
    });

    /* Trips with no budget are excluded from the accuracy figures rather than
     * counted as a perfect estimate. Counting them would let a fleet that never
     * budgets anything report flawless forecasting. */
    const budgeted = rows.filter((r) => r.estimatedCost > 0);

    return res.json({
      period: { from, to },
      rows,
      summary: {
        trips: rows.length,
        budgetedTrips: budgeted.length,
        estimatedCost: round(sum(budgeted, "estimatedCost")),
        actualCost: round(sum(budgeted, "actualCost")),
        costVariance: round(sum(budgeted, "costVariance")),
        overBudget: budgeted.filter((r) => r.costVariance < 0).length,
        underBudget: budgeted.filter((r) => r.costVariance > 0).length,
        /* How wrong the budgets are on average, in both directions. Averaging
         * the signed variance would net a fleet that is wildly over on half its
         * trips and wildly under on the other half to a comfortable zero. */
        averageAbsoluteVariancePercent: budgeted.length
          ? round(
              budgeted.reduce(
                (acc, r) => acc + Math.abs(r.costVariance) / r.estimatedCost,
                0
              ) / budgeted.length * 100,
              2
            )
          : 0,
      },
    });
  })
);

/* ================= GET /api/v1/reports/receivables =================
 * What customers still owe. Not a profitability report, but the one an owner
 * opens on a Monday.
 */
router.get(
  "/receivables",
  handler(async (req, res) => {
    const trips = await Trip.find({
      companyId: req.companyId,
      status: { $ne: "CANCELLED" },
      "revenue.paymentStatus": { $in: ["UNPAID", "PARTIAL", "OVERDUE"] },
      "revenue.total": { $gt: 0 },
    })
      .select("tripNumber customerId customerName revenue closedAt deliveredAt")
      .sort({ deliveredAt: 1 })
      .limit(2000)
      .lean();

    const byCustomer = new Map();
    for (const t of trips) {
      const key = String(t.customerId || t.customerName || "unknown");
      const row = byCustomer.get(key) || {
        customerId: t.customerId ? String(t.customerId) : null,
        customer: t.customerName,
        trips: 0,
        invoiced: 0,
        received: 0,
        outstanding: 0,
        oldestDue: null,
      };
      row.trips += 1;
      row.invoiced += t.revenue?.total || 0;
      row.received += t.revenue?.advanceReceived || 0;
      row.outstanding += t.revenue?.balanceDue || 0;
      const due = t.revenue?.dueDate || t.deliveredAt;
      if (due && (!row.oldestDue || new Date(due) < new Date(row.oldestDue))) {
        row.oldestDue = due;
      }
      byCustomer.set(key, row);
    }

    const rows = [...byCustomer.values()]
      .map((r) => ({
        ...r,
        invoiced: round(r.invoiced),
        received: round(r.received),
        outstanding: round(r.outstanding),
        daysOutstanding: r.oldestDue
          ? Math.floor((Date.now() - new Date(r.oldestDue).getTime()) / 86400000)
          : null,
      }))
      .sort((a, b) => b.outstanding - a.outstanding);

    return res.json({
      rows,
      total: round(rows.reduce((s, r) => s + r.outstanding, 0)),
      tripCount: trips.length,
    });
  })
);

/* ---------------- helpers ---------------- */

/*
 * One aggregation behind the four profitability reports.
 *
 * They differ only in what they group by, so writing them out four times would
 * mean four places for the margin formula to drift apart — and a customer
 * report that disagrees with the vehicle report about the same trip is a
 * product nobody trusts twice.
 */
async function groupedProfit(req, groupBy, labelField) {
  const { from, to } = period(req);
  const limit = parseInteger(req.query.limit, "limit", { min: 1, max: 200, fallback: 50 });
  const sortBy = parseEnum(req.query.sortBy, "sortBy", ["PROFIT", "REVENUE", "MARGIN", "TRIPS"], {
    fallback: "PROFIT",
  });

  const rows = await Trip.aggregate([
    { $match: closedIn(req.companyId, from, to) },
    {
      $group: {
        _id: groupBy,
        /* $last, not $first: a customer renamed mid-period should appear under
         * the name they go by now. */
        label: { $last: `$${labelField}` },
        trips: { $sum: 1 },
        revenue: { $sum: "$revenue.subTotal" },
        cost: { $sum: "$actuals.approvedCost" },
        estimatedCost: { $sum: "$estimate.total" },
        distanceKm: { $sum: "$journey.distanceKm" },
      },
    },
    { $limit: 500 },
  ]);

  const mapped = rows
    .filter((r) => r._id != null)
    .map((r) => {
      const revenue = round(r.revenue || 0);
      const cost = round(r.cost || 0);
      const profit = round(revenue - cost);
      return {
        id: String(r._id),
        label: r.label || "",
        trips: r.trips,
        revenue,
        cost,
        profit,
        marginPercent: pct(profit, revenue),
        distanceKm: round(r.distanceKm || 0),
        profitPerTrip: r.trips ? round(profit / r.trips) : 0,
        profitPerKm: r.distanceKm ? round(profit / r.distanceKm, 2) : 0,
        costVariance: round((r.estimatedCost || 0) - cost),
      };
    });

  const key = {
    PROFIT: "profit",
    REVENUE: "revenue",
    MARGIN: "marginPercent",
    TRIPS: "trips",
  }[sortBy];
  mapped.sort((a, b) => b[key] - a[key]);

  const totalRevenue = round(sum(mapped, "revenue"));
  const totalCost = round(sum(mapped, "cost"));

  return {
    period: { from, to },
    sortBy,
    rows: mapped.slice(0, limit),
    totals: {
      trips: mapped.reduce((s, r) => s + r.trips, 0),
      revenue: totalRevenue,
      cost: totalCost,
      profit: round(totalRevenue - totalCost),
      marginPercent: pct(totalRevenue - totalCost, totalRevenue),
    },
  };
}

const closedIn = (companyId, from, to) => ({
  companyId,
  status: "COMPLETED",
  closedAt: { $gte: from, $lte: to },
});

/*
 * The reporting window. Defaults to the current calendar month, which is what
 * an owner opening the reports screen means by "how are we doing".
 *
 * A range wider than two years is refused: the aggregations here scan trips
 * rather than a pre-built rollup, and an unbounded range on a fleet with five
 * years of history is a query that ties up the database while the office waits.
 */
function period(req) {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const from = parseDate(req.query.from, "from", { fallback: defaultFrom });
  const to = parseDate(req.query.to, "to", { fallback: now });

  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  if (end < from) {
    throw errors.validation("The end of the period is before the start.", {
      to: "must be after from",
    });
  }
  if (end - from > 2 * 366 * 86400000) {
    throw errors.validation("Reports cover at most two years at a time.", {
      from: "range must be 2 years or less",
    });
  }
  return { from, to: end };
}

const pct = (part, whole) => (whole > 0 ? round((part / whole) * 100, 2) : 0);
const sum = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0);

module.exports = router;
