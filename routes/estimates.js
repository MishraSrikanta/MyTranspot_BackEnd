const express = require("express");

const Estimate = require("../models/Estimate");
const Customer = require("../models/Customer");
const Vehicle = require("../models/Vehicle");
const Driver = require("../models/Driver");
const Employee = require("../models/Employee");
const Trip = require("../models/Trip");
const Counter = require("../models/Counter");
const { errors, handler } = require("../utils/apiError");
const {
  parseText,
  parseOptionalText,
  parseAmount,
  parseEnum,
  parseDate,
  parseBoolean,
  parseLatLng,
  parsePhone,
  isNil,
} = require("../utils/validate");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { ratesFor } = require("../utils/standingCost");
const { buildCost, buildQuote, defaultsFor, costToTripEstimate } = require("../utils/estimateCalc");
const { pathDistanceKm, round } = require("../utils/geo");
const audit = require("../utils/audit");

const router = express.Router();
router.use(requireAuth);

/* ================= POST /api/v1/estimates/calculate =================
 * Price a job without saving anything.
 *
 * This is the endpoint the owner uses with a customer on the phone: type the
 * distance, read back a figure. It saves nothing, so it can be called on every
 * keystroke as the owner slides the margin up and down, and the answer changes
 * live.
 *
 * Every intermediate number comes back — litres of diesel, cost per line, the
 * margin both ways round — because the next thing the customer says is "why is
 * it that much?", and the owner needs to be able to answer without opening a
 * calculator.
 */
router.post(
  "/calculate",
  requirePermission("estimates.view"),
  handler(async (req, res) => {
    const { basis, cost, quote } = await priceIt(req);
    return res.json({ basis, cost, ...quote });
  })
);

/* ================= GET /api/v1/estimates ================= */
router.get(
  "/",
  requirePermission("estimates.view"),
  handler(async (req, res) => {
    const query = { companyId: req.companyId };
    if (req.query.status) {
      query.status = parseEnum(req.query.status, "status", Estimate.ESTIMATE_STATUSES);
    }
    if (req.query.customerId) query.customerId = req.query.customerId;

    const estimates = await Estimate.find(query).sort({ createdAt: -1 }).limit(200);

    return res.json({
      estimates: estimates.map((e) => ({
        ...e.toObject(),
        /* Expiry is decided at read time — see the model. A quote that lapsed at
         * midnight is expired the moment somebody looks at it, with no job to
         * run and nothing to go stale. */
        status: e.effectiveStatus(),
      })),
    });
  })
);

/* ================= GET /api/v1/estimates/:id ================= */
router.get(
  "/:id",
  requirePermission("estimates.view"),
  handler(async (req, res) => {
    const estimate = await findEstimate(req);
    return res.json({
      estimate: { ...estimate.toObject(), status: estimate.effectiveStatus() },
      /* So the quote screen can show "you expected to make ₹8,000 on this" next
       * to the price, which is the number that decides whether to discount. */
      marginOnRevenuePercent:
        estimate.quote?.subTotal > 0
          ? round((estimate.expectedProfit / estimate.quote.subTotal) * 100, 2)
          : 0,
    });
  })
);

/* ================= POST /api/v1/estimates ================= */
router.post(
  "/",
  requirePermission("estimates.manage"),
  handler(async (req, res) => {
    const { basis, cost, quote, routePoints } = await priceIt(req);

    let customerId = null;
    let customerName;
    if (!isNil(req.body.customerId)) {
      const customer = await Customer.findOne({
        _id: req.body.customerId,
        companyId: req.companyId,
      }).select("name phone email");
      if (!customer) throw errors.customerNotFound();
      customerId = customer._id;
      customerName = customer.name;
    } else {
      /* A quote is often given to somebody who is not yet a customer. Forcing a
       * customer record first is how an owner ends up with fifty half-filled
       * contacts from enquiries that went nowhere. */
      customerName = parseText(req.body.customerName, "customerName", {
        max: 160,
        label: "Customer name",
      });
    }

    const seq = await Counter.nextSequence(req.companyId, "estimate");
    const estimateNumber = Counter.formatNumber(req.company.estimatePrefix || "EST", seq);

    const estimate = await Estimate.create({
      companyId: req.companyId,
      estimateNumber,
      sequence: seq,
      customerId,
      customerName,
      contactPhone: parsePhone(req.body.contactPhone),
      contactEmail: parseOptionalText(req.body.contactEmail, "contactEmail", 160).toLowerCase(),
      origin: parseEndpoint(req.body.origin, "origin"),
      destination: parseEndpoint(req.body.destination, "destination"),
      routePoints,
      vehicleType: parseOptionalText(req.body.vehicleType, "vehicleType", 40) || "TRUCK",
      goodsDescription: parseOptionalText(req.body.goodsDescription, "goodsDescription", 300),
      weightTons: parseAmount(req.body.weightTons, "weightTons", { max: 1000 }),
      basis,
      cost,
      marginPercent: quote.marginPercent,
      quote: quote.quote,
      expectedProfit: quote.expectedProfit,
      validUntil:
        parseDate(req.body.validUntil, "validUntil") ||
        /* Seven days by default. A quote with no expiry is one an owner is
         * still being held to when diesel has moved twenty rupees. */
        new Date(Date.now() + 7 * 86400000),
      terms: parseOptionalText(req.body.terms, "terms", 2000),
      notes: parseOptionalText(req.body.notes, "notes", 2000),
      createdBy: req.account._id,
      createdByName: req.account.name,
    });

    return res.status(201).json({ estimate });
  })
);

/* ================= PUT /api/v1/estimates/:id ================= */
router.put(
  "/:id",
  requirePermission("estimates.manage"),
  handler(async (req, res) => {
    const estimate = await findEstimate(req);
    /* Once it has become a trip, the quote is a historical record of what the
     * customer agreed to. Editing it would rewrite the terms of a job that is
     * already running. */
    if (estimate.status === "CONVERTED") {
      throw errors.badTransition("This estimate has become a trip and cannot be changed.");
    }

    const { basis, cost, quote, routePoints } = await priceIt(req, estimate);
    estimate.basis = basis;
    estimate.cost = cost;
    estimate.marginPercent = quote.marginPercent;
    estimate.quote = quote.quote;
    estimate.expectedProfit = quote.expectedProfit;
    if (routePoints.length) estimate.routePoints = routePoints;

    if (req.body.validUntil !== undefined) {
      estimate.validUntil = parseDate(req.body.validUntil, "validUntil");
    }
    for (const [field, max] of [
      ["terms", 2000],
      ["notes", 2000],
      ["goodsDescription", 300],
    ]) {
      if (req.body[field] !== undefined) {
        estimate[field] = parseOptionalText(req.body[field], field, max);
      }
    }

    await estimate.save();
    return res.json({ estimate });
  })
);

/* ================= POST /api/v1/estimates/:id/send =================
 * Mark it as given to the customer.
 *
 * The system does not send it — there is no mail or messaging integration in
 * this build, and pretending otherwise would be worse than saying so. What this
 * does is start the clock: the quote is now outstanding, and it appears in the
 * list of things waiting on an answer.
 */
router.post(
  "/:id/send",
  requirePermission("estimates.manage"),
  handler(async (req, res) => {
    const estimate = await findEstimate(req);
    if (estimate.status !== "DRAFT" && estimate.status !== "SENT") {
      throw errors.badTransition(`An estimate that is ${estimate.status} cannot be sent.`);
    }

    estimate.status = "SENT";
    estimate.sentAt = new Date();
    await estimate.save();

    return res.json({ estimate });
  })
);

/* ================= POST /api/v1/estimates/:id/accept =================
 * The customer said yes — turn the quote into a trip.
 *
 * This is the join that makes the whole product worth using. The quote's cost
 * lines become the trip's BUDGET and the quote's price becomes the trip's
 * revenue, so when the trip closes the owner is comparing what actually
 * happened against what they promised — not against a second set of numbers
 * somebody typed in again.
 */
router.post(
  "/:id/accept",
  requirePermission("estimates.manage"),
  handler(async (req, res) => {
    const estimate = await findEstimate(req);
    /* Terminal on purpose: one quote, one trip. Two would count the profit from
     * one run against the same quote twice. */
    if (estimate.status === "CONVERTED") {
      throw errors.badTransition("This estimate has already become a trip.", {
        tripId: estimate.convertedTripId ? String(estimate.convertedTripId) : null,
      });
    }
    if (estimate.status === "REJECTED") {
      throw errors.badTransition("This estimate was rejected.");
    }

    /* A customer record is needed now, even though it was not needed to quote:
     * a trip has to be attributable for the customer-profitability report. */
    let customerId = estimate.customerId;
    let customerName = estimate.customerName;
    if (!customerId) {
      const existing = await Customer.findOne({
        companyId: req.companyId,
        name: estimate.customerName,
      }).collation({ locale: "en", strength: 2 });
      const customer =
        existing ||
        (await Customer.create({
          companyId: req.companyId,
          name: estimate.customerName,
          phone: estimate.contactPhone,
          email: estimate.contactEmail,
        }));
      customerId = customer._id;
      customerName = customer.name;
      estimate.customerId = customerId;
    }

    const seq = await Counter.nextSequence(req.companyId, "trip");
    const tripNumber = Counter.formatNumber(req.company.tripPrefix || "TRP", seq);

    const trip = new Trip({
      companyId: req.companyId,
      tripNumber,
      sequence: seq,
      customerId,
      customerName,
      origin: { name: estimate.origin.name, lat: estimate.origin.lat, lng: estimate.origin.lng },
      destination: {
        name: estimate.destination.name,
        lat: estimate.destination.lat,
        lng: estimate.destination.lng,
      },
      goodsDescription: estimate.goodsDescription,
      weightTons: estimate.weightTons,
      scheduledStart: parseDate(req.body.scheduledStart, "scheduledStart"),
      expectedArrival: parseDate(req.body.expectedArrival, "expectedArrival"),
      estimateId: estimate._id,
      createdBy: req.account._id,
      /* PLANNED, not DRAFT: the customer has agreed, so this is a job the yard
       * has to staff, and it belongs on the planning board immediately. */
      status: "PLANNED",
      statusHistory: [
        {
          status: "PLANNED",
          at: new Date(),
          by: req.account._id,
          byName: req.account.name,
          note: `Accepted from estimate ${estimate.estimateNumber}`,
        },
      ],
      revenue: {
        freightCharges: estimate.quote.freightCharges,
        loadingCharges: estimate.quote.loadingCharges,
        unloadingCharges: estimate.quote.unloadingCharges,
        otherCharges: estimate.quote.otherCharges,
        gstPercent: estimate.quote.gstPercent,
        gstAmount: estimate.quote.gstAmount,
        subTotal: estimate.quote.subTotal,
        total: estimate.quote.total,
        balanceDue: estimate.quote.total,
        paymentStatus: "UNPAID",
      },
      estimate: costToTripEstimate(estimate.cost),
    });

    if ((estimate.routePoints || []).length >= 2) {
      trip.plannedRoute = {
        points: estimate.routePoints.map((p) => ({ lat: p.lat, lng: p.lng })),
        distanceKm: round(estimate.basis?.distanceKm || 0),
        source: "IMPORTED",
        revision: 1,
        updatedAt: new Date(),
      };
    }

    await trip.save();

    estimate.status = "CONVERTED";
    estimate.respondedAt = new Date();
    estimate.convertedTripId = trip._id;
    await estimate.save();

    audit.record(req, {
      action: "estimate.accepted",
      entityType: "Estimate",
      entityId: estimate._id,
      entityLabel: estimate.estimateNumber,
      note: `Became trip ${trip.tripNumber}`,
    });

    return res.status(201).json({ estimate, trip });
  })
);

/* ================= POST /api/v1/estimates/:id/reject =================
 * The customer said no. Worth recording rather than deleting: a lane that is
 * quoted ten times and won twice is telling the owner their rate is wrong.
 */
router.post(
  "/:id/reject",
  requirePermission("estimates.manage"),
  handler(async (req, res) => {
    const estimate = await findEstimate(req);
    if (estimate.status === "CONVERTED") {
      throw errors.badTransition("This estimate has already become a trip.");
    }

    estimate.status = "REJECTED";
    estimate.respondedAt = new Date();
    estimate.rejectionReason = parseOptionalText(req.body.reason, "reason", 300);
    await estimate.save();

    return res.json({ estimate });
  })
);

/* ---------------- helpers ---------------- */

async function findEstimate(req) {
  const estimate = await Estimate.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!estimate) throw errors.estimateNotFound();
  return estimate;
}

/*
 * Work out the cost and the price from whatever the caller supplied.
 *
 * The rates fall back through three levels: what was sent with this request,
 * then the chosen lorry's own figures, then the company defaults. That order is
 * what lets an owner quote a one-off at a special diesel rate without changing
 * the fleet settings, and still get a sensible answer when they send nothing at
 * all but a distance.
 */
async function priceIt(req, existing = null) {
  const body = req.body || {};

  let vehicle = null;
  if (!isNil(body.vehicleId)) {
    /*
     * The whole runningCost block is needed, not just the mileage: the quote's
     * per-kilometre wear line comes from this vehicle, so a trailer and an LCV
     * price differently for the same lane. `wearPerKm()` is a document method,
     * which is why this is no longer a lean projection.
     */
    vehicle = await Vehicle.findOne({ _id: body.vehicleId, companyId: req.companyId }).select(
      "averageKmPerLitre registrationNumber runningCost"
    );
    if (!vehicle) throw errors.vehicleNotFound();
  }

  /*
   * The driver's own daily cost, and the helpers riding with the load.
   *
   * Read from the people rather than typed into the quote, because an owner who
   * has already recorded what each driver gets for food should not key it again
   * per quote — and because a quote built from the actual roster is one that can
   * be defended when the margin turns out to be wrong.
   */
  let driver = null;
  if (!isNil(body.driverId)) {
    driver = await Driver.findOne({ _id: body.driverId, companyId: req.companyId }).select(
      "pay defaultTripFee defaultFeePerKm name"
    );
  }
  let helpers = [];
  if (Array.isArray(body.helperIds) && body.helperIds.length) {
    helpers = await Employee.find({
      _id: { $in: body.helperIds },
      companyId: req.companyId,
    }).select("name role pay");
  }

  const defaults = defaultsFor(req.company, vehicle);
  /* Vehicle- and person-specific rates, which beat the company defaults. */
  const rates = ratesFor({ company: req.company, vehicle, driver, helpers });

  /*
   * The distance can be given directly or measured from a drawn route. Measured
   * wins when both are present: a route the owner drew on the map is a stronger
   * statement about the job than a number typed into a box.
   */
  const routePoints = Array.isArray(body.routePoints)
    ? body.routePoints.map((p, i) => parseLatLng(p.lat, p.lng, `routePoints[${i}]`))
    : [];
  const measuredKm = routePoints.length >= 2 ? pathDistanceKm(routePoints) : 0;
  const distanceKm = measuredKm || parseAmount(body.distanceKm, "distanceKm", { max: 100000 }) ||
    existing?.basis?.distanceKm || 0;

  if (!distanceKm) {
    throw errors.validation(
      "Enter the distance, or draw the route, so the cost can be worked out.",
      { distanceKm: "is required" }
    );
  }

  /*
   * Precedence, and it matters: what the owner typed on this quote, then what
   * the quote already held, then the rate for this actual vehicle or driver,
   * then the company default. A zero anywhere in that chain means "not known"
   * and falls through rather than meaning "free".
   */
  const pick = (field, fallbackKey) =>
    body[field] !== undefined
      ? parseAmount(body[field], field, { max: 1e7 })
      : existing?.basis?.[field] ?? rates[field] ?? defaults[fallbackKey ?? field] ?? 0;

  const { cost, basis } = buildCost({
    distanceKm,
    isRoundTrip: parseBoolean(body.isRoundTrip, existing?.basis?.isRoundTrip ?? false),
    tripDays: body.tripDays !== undefined
      ? parseAmount(body.tripDays, "tripDays", { max: 365 })
      : existing?.basis?.tripDays ?? estimateDays(distanceKm),
    nights: body.nights !== undefined
      ? parseAmount(body.nights, "nights", { max: 365 })
      : existing?.basis?.nights ?? Math.max(0, estimateDays(distanceKm) - 1),
    kmPerLitre: pick("kmPerLitre"),
    dieselRatePerLitre: pick("dieselRatePerLitre"),
    tollPerKm: pick("tollPerKm"),
    /* Tyres, servicing and wear — the line that was missing entirely. */
    runningCostPerKm: pick("runningCostPerKm"),
    driverFeePerKm: pick("driverFeePerKm"),
    driverFeePerTrip: pick("driverFeePerTrip"),
    driverDayCost: pick("driverDayCost"),
    foodPerDay: pick("foodPerDay"),
    nightAllowance: pick("nightAllowance"),
    helperCount:
      body.helperCount !== undefined
        ? parseAmount(body.helperCount, "helperCount", { max: 20 })
        : helpers.length || existing?.basis?.helperCount || 0,
    helperCostPerDay: pick("helperCostPerDay"),
    maintenance: parseAmount(body.maintenance, "maintenance", { max: 1e7 }),
    other: parseAmount(body.other, "other", { max: 1e7 }),
  });

  const quote = buildQuote(cost, {
    distanceKm,
    marginPercent:
      body.marginPercent !== undefined
        ? Number(body.marginPercent)
        : existing?.marginPercent ?? defaults.marginPercent,
    freightCharges: body.freightCharges,
    loadingCharges: parseAmount(body.loadingCharges, "loadingCharges", { max: 1e7 }),
    unloadingCharges: parseAmount(body.unloadingCharges, "unloadingCharges", { max: 1e7 }),
    otherCharges: parseAmount(body.otherCharges, "otherCharges", { max: 1e7 }),
    gstPercent:
      body.gstPercent !== undefined
        ? parseAmount(body.gstPercent, "gstPercent", { max: 100 })
        : defaults.gstPercent,
  });

  return { basis, cost, quote, routePoints, rates };
}

/*
 * A rough number of days on the road, used only as the default when the owner
 * has not said. 400 km a day is a realistic Indian long-haul average once
 * check posts, meal stops and a night halt are counted — a figure taken from
 * motorway speed would put a Bhubaneswar-Delhi run at a day and a half and
 * under-budget the driver's food by two thirds.
 */
function estimateDays(distanceKm) {
  return Math.max(1, Math.ceil(distanceKm / 400));
}

function parseEndpoint(raw, field) {
  if (isNil(raw)) throw errors.validation(`${field} is required.`, { [field]: "is required" });
  const value = typeof raw === "string" ? { name: raw } : raw;
  const out = { name: parseText(value.name, `${field}.name`, { max: 160, label: field }) };
  if (!isNil(value.lat) && !isNil(value.lng)) {
    const { lat, lng } = parseLatLng(value.lat, value.lng, field);
    out.lat = lat;
    out.lng = lng;
  }
  return out;
}

module.exports = router;
