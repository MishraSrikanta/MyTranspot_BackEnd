const mongoose = require("mongoose");

/*
 * The trip. Everything else in this system hangs off it.
 *
 * The single most important architectural decision in the product is visible in
 * the shape of this document: GPS is one field among many, not the spine. A
 * trip has a customer, a price, a cost ledger and a profit whether or not any
 * phone ever reported a position. That is what makes the business usable on a
 * day when the driver's handset is flat, and it is why `location_history` is a
 * separate collection referenced from here rather than the thing trips are
 * stored inside.
 */

/*
 * The lifecycle from the brief. The order matters: `TRIP_FLOW` is the happy
 * path, and a transition is legal if it steps forward along it.
 *
 *   DRAFT       being keyed in; nothing is committed
 *   PLANNED     customer, route and price agreed
 *   ASSIGNED    a lorry and a driver are on it
 *   READY       loaded and papers done
 *   IN_TRANSIT  wheels turning; this is when tracking counts
 *   ARRIVED     at the consignee
 *   DELIVERED   goods handed over, POD in hand
 *   COMPLETED   ledger closed, profit banked
 */
const TRIP_FLOW = [
  "DRAFT",
  "PLANNED",
  "ASSIGNED",
  "READY",
  "IN_TRANSIT",
  "ARRIVED",
  "DELIVERED",
  "COMPLETED",
];

/* States that are not a point on the line. ON_HOLD and DELAYED are situations a
 * trip is in and then comes out of; CANCELLED is the end. */
const TRIP_EXCEPTIONS = ["ON_HOLD", "DELAYED", "CANCELLED"];

const TRIP_STATUSES = [...TRIP_FLOW, ...TRIP_EXCEPTIONS];

/* Once here, the ledger is frozen and the totals are banked. */
const TRIP_CLOSED = ["COMPLETED", "CANCELLED"];

/* A trip in one of these owns its lorry and driver — neither can be given to
 * another run until it leaves this set. */
const TRIP_ACTIVE = ["ASSIGNED", "READY", "IN_TRANSIT", "ARRIVED", "DELIVERED", "ON_HOLD", "DELAYED"];

const PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID", "OVERDUE"];

/* A named place, with coordinates when the map knows them. Coordinates stay
 * optional: an owner keying in a trip at eleven at night should not have to
 * look one up before the trip can exist. */
const placeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    address: { type: String, default: "", trim: true, maxlength: 300 },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  { _id: false }
);

const pointSchema = new mongoose.Schema(
  { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
  { _id: false }
);

/*
 * The line the lorry is supposed to follow.
 *
 * `points` is the drawn route — either the owner's own waypoints or a polyline
 * pulled from a map provider by the frontend and posted here. The server stores
 * and measures it but never fetches it, so the trip works with a route the
 * owner sketched by hand.
 */
const plannedRouteSchema = new mongoose.Schema(
  {
    points: { type: [pointSchema], default: [] },
    /* Distance along the drawn line. Held rather than recomputed on every read
     * because the estimate and the driver fee are calculated from it. */
    distanceKm: { type: Number, default: 0, min: 0 },
    estimatedDurationMinutes: { type: Number, default: 0, min: 0 },
    /* Human-readable via points the owner named: Bhubaneswar - Cuttack - ... */
    waypoints: { type: [placeSchema], default: [] },
    source: { type: String, enum: ["MANUAL", "MAP", "IMPORTED"], default: "MANUAL" },
    /*
     * Bumped every time the route is replaced. The revision is what the owner
     * sees on the map when they ask "has this changed since I planned it?", and
     * what the location pings are stamped with so a ping can be told which
     * route it was judged against.
     */
    revision: { type: Number, default: 1 },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/*
 * Every superseded route, kept in full.
 *
 * The brief asks that the owner can see it when the route changes. Overwriting
 * `plannedRoute` would answer "what is the route now" and destroy the answer to
 * "who changed it, when, and what was it before" — which is the question that
 * actually gets asked, on the day a run comes in two hundred kilometres longer
 * than it was quoted at.
 */
const routeRevisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true },
    points: { type: [pointSchema], default: [] },
    distanceKm: { type: Number, default: 0 },
    reason: { type: String, default: "", trim: true, maxlength: 300 },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    changedByName: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/*
 * What the customer pays, broken down. The brief is explicit that the total is
 * not enough — the owner has to be able to say how the figure was arrived at
 * when the customer queries it three weeks later.
 */
const revenueSchema = new mongoose.Schema(
  {
    freightCharges: { type: Number, default: 0, min: 0 },
    loadingCharges: { type: Number, default: 0, min: 0 },
    unloadingCharges: { type: Number, default: 0, min: 0 },
    detentionCharges: { type: Number, default: 0, min: 0 },
    otherCharges: { type: Number, default: 0, min: 0 },
    otherChargesNote: { type: String, default: "", trim: true, maxlength: 200 },

    /* Kept as a percentage and an amount. The percentage is what the office
     * sets; the amount is what appears on the invoice, and rounding it once
     * here stops the invoice and the report disagreeing by a rupee. */
    gstPercent: { type: Number, default: 0, min: 0, max: 100 },
    gstAmount: { type: Number, default: 0, min: 0 },

    /* Charges before tax — this is the figure profit is measured against, since
     * GST is collected on behalf of the government and was never the
     * transporter's money. */
    subTotal: { type: Number, default: 0, min: 0 },
    /* What the customer is actually billed. */
    total: { type: Number, default: 0, min: 0 },

    advanceReceived: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: "UNPAID", index: true },
    invoiceNumber: { type: String, default: "", trim: true, maxlength: 60 },
    invoiceDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
  },
  { _id: false }
);

/*
 * What the owner expected the trip to cost, keyed in before the lorry leaves.
 *
 * This is the field that turns the product from bookkeeping into something
 * worth paying for. Without it the system can say a trip made ₹52,550; with it
 * the system can say the trip made ₹1,550 more than it was supposed to, and
 * that the fuel came in under while the repairs came in over. The categories
 * mirror the expense categories so the variance report can subtract them
 * line for line.
 */
const estimateSchema = new mongoose.Schema(
  {
    fuel: { type: Number, default: 0, min: 0 },
    toll: { type: Number, default: 0, min: 0 },
    driver: { type: Number, default: 0, min: 0 },
    food: { type: Number, default: 0, min: 0 },
    allowance: { type: Number, default: 0, min: 0 },
    maintenance: { type: Number, default: 0, min: 0 },
    other: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    /* Locked when the trip leaves DRAFT/PLANNED. An estimate that can be edited
     * after the fact is not an estimate, it is a way of making every trip look
     * like it came in on budget. */
    lockedAt: { type: Date, default: null },
  },
  { _id: false }
);

/*
 * The cost side, recomputed from the expense ledger whenever it changes.
 *
 * This is a cache of TripExpense rows and is never written to directly by a
 * route — utils/tripFinance.js owns it. Caching it is what lets the dashboard
 * and the reports read a trip's profit without aggregating its expenses.
 *
 * `pending` is deliberately kept apart from `approved`. A driver's ₹2,000 fuel
 * claim that the accountant has not yet checked is a real liability but not yet
 * a cost, and folding it into the profit before anyone has seen the receipt is
 * how a trip shows one margin today and a different one tomorrow.
 */
const actualsSchema = new mongoose.Schema(
  {
    byCategory: { type: Map, of: Number, default: () => new Map() },
    approvedCost: { type: Number, default: 0 },
    pendingCost: { type: Number, default: 0 },
    rejectedCost: { type: Number, default: 0 },
    expenseCount: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },

    /* subTotal (ex-GST) minus approvedCost. */
    profit: { type: Number, default: 0 },
    marginPercent: { type: Number, default: 0 },
    /* estimate.total minus approvedCost: positive means the trip came in under
     * budget. */
    costVariance: { type: Number, default: 0 },
    profitVariance: { type: Number, default: 0 },
    recalculatedAt: { type: Date, default: null },
  },
  { _id: false }
);

/* What actually happened on the road, filled in from the location history. */
const journeySchema = new mongoose.Schema(
  {
    /* The number the driver is paid against and the customer is billed for. */
    distanceKm: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, default: 0, min: 0 },
    movingMinutes: { type: Number, default: 0, min: 0 },
    stoppedMinutes: { type: Number, default: 0, min: 0 },
    stopCount: { type: Number, default: 0 },
    averageKmh: { type: Number, default: 0 },
    maxKmh: { type: Number, default: 0 },
    pingCount: { type: Number, default: 0 },
    /*
     * The thinned line drawn on the trip-history map. The full-resolution track
     * stays in the location history; this is the shape of it, small enough to
     * hand to a browser with fifty other trips on screen.
     */
    simplifiedPath: { type: [pointSchema], default: [] },
    summarisedAt: { type: Date, default: null },
  },
  { _id: false }
);

/* Where the lorry was last seen, denormalised onto the trip.
 *
 * The live map draws every running trip at once. Reading the newest ping per
 * trip out of a location history with millions of rows, on every map refresh,
 * for every lorry, is the query that eventually takes the product down. One
 * embedded document per trip, overwritten in place, makes that screen a single
 * indexed find. */
const lastPositionSchema = new mongoose.Schema(
  {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    speedKmh: { type: Number, default: 0 },
    headingDeg: { type: Number, default: null },
    accuracyM: { type: Number, default: null },
    recordedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    /* How far off the planned route this fix was, and whether that counts as
     * having left it under the company threshold. */
    offRouteKm: { type: Number, default: null },
    isOffRoute: { type: Boolean, default: false },
    /* True when this position came from a fix too coarse to measure with — a
     * browser positioning by Wi-Fi rather than a GPS. It shows on the map and
     * counts towards nothing. */
    isApproximate: { type: Boolean, default: false },
    coveredKm: { type: Number, default: 0 },
    remainingKm: { type: Number, default: 0 },
    progressPercent: { type: Number, default: 0 },
  },
  { _id: false }
);

const statusEventSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    byName: { type: String, default: "" },
    note: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { _id: false }
);

const tripSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    /* TRP-000102. Unique within the company, never across it — two tenants may
     * hold the same visible number and neither can see the other. */
    tripNumber: { type: String, required: true, trim: true, uppercase: true },
    sequence: { type: Number, required: true },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },
    /*
     * Names are snapshotted alongside the ids throughout this document. A trip
     * closed in 2026 must still print the customer, lorry and driver it
     * actually ran with, even after the customer is renamed or the driver
     * leaves. The id is what the reports join on; the snapshot is what the
     * paperwork shows.
     */
    customerName: { type: String, default: "", trim: true, maxlength: 160 },

    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      default: null,
      index: true,
    },
    vehicleRegistration: { type: String, default: "", trim: true, uppercase: true },

    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      default: null,
      index: true,
    },
    driverName: { type: String, default: "", trim: true, maxlength: 80 },

    origin: { type: placeSchema, required: true },
    destination: { type: placeSchema, required: true },
    /* "BHUBANESWAR|DELHI" — the key the route-profitability report groups by.
     * Derived on save so the report never has to normalise two spellings of the
     * same lane at query time. */
    routeKey: { type: String, default: "", index: true },

    plannedRoute: { type: plannedRouteSchema, default: () => ({}) },
    routeHistory: { type: [routeRevisionSchema], default: [] },

    goodsDescription: { type: String, default: "", trim: true, maxlength: 300 },
    weightTons: { type: Number, default: 0, min: 0 },
    lrNumber: { type: String, default: "", trim: true, maxlength: 60 },
    ewayBillNumber: { type: String, default: "", trim: true, maxlength: 60 },

    scheduledStart: { type: Date, default: null },
    expectedArrival: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },

    status: { type: String, enum: TRIP_STATUSES, default: "DRAFT", index: true },
    /* Where the trip was on the main line before an exception took it aside, so
     * coming off ON_HOLD resumes rather than guesses. */
    statusBeforeException: { type: String, default: null },
    statusHistory: { type: [statusEventSchema], default: [] },
    cancellationReason: { type: String, default: "", trim: true, maxlength: 300 },

    revenue: { type: revenueSchema, default: () => ({}) },
    estimate: { type: estimateSchema, default: () => ({}) },
    actuals: { type: actualsSchema, default: () => ({}) },
    journey: { type: journeySchema, default: () => ({}) },
    lastPosition: { type: lastPositionSchema, default: () => ({}) },

    /* Raised the first time a ping lands further off the route than the company
     * allows, and left raised: the owner wants to know it happened, not only
     * that it is still happening now. */
    hasRouteDeviation: { type: Boolean, default: false },
    routeDeviationAt: { type: Date, default: null },
    maxOffRouteKm: { type: Number, default: 0 },

    /* Set when the trip was created by accepting an estimate, so a quote can be
     * followed all the way through to what the run actually made. */
    estimateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Estimate",
      default: null,
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    notes: { type: String, default: "", trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

/* One trip number per company. */
tripSchema.index({ companyId: 1, tripNumber: 1 }, { unique: true });
/* The trip list, and the dashboard's "what is running now". */
tripSchema.index({ companyId: 1, status: 1, createdAt: -1 });
/* Every report in the product is "this company, this date range", so the month
 * boundary has to be indexed rather than scanned. */
tripSchema.index({ companyId: 1, startedAt: -1 });
tripSchema.index({ companyId: 1, closedAt: -1 });
tripSchema.index({ companyId: 1, customerId: 1, closedAt: -1 });
tripSchema.index({ companyId: 1, vehicleId: 1, closedAt: -1 });
tripSchema.index({ companyId: 1, driverId: 1, closedAt: -1 });
tripSchema.index({ companyId: 1, routeKey: 1, closedAt: -1 });

/* Normalise the lane key. Case and stray spaces are the difference between one
 * route row and three in the profitability table. */
tripSchema.pre("save", function deriveRouteKey() {
  if (this.origin?.name && this.destination?.name) {
    const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, " ");
    this.routeKey = `${norm(this.origin.name)}|${norm(this.destination.name)}`;
  }
});

tripSchema.methods.isClosed = function isClosed() {
  return TRIP_CLOSED.includes(this.status);
};

tripSchema.methods.isActive = function isActive() {
  return TRIP_ACTIVE.includes(this.status);
};

tripSchema.set("toJSON", { virtuals: true });
tripSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Trip", tripSchema);
module.exports.TRIP_FLOW = TRIP_FLOW;
module.exports.TRIP_EXCEPTIONS = TRIP_EXCEPTIONS;
module.exports.TRIP_STATUSES = TRIP_STATUSES;
module.exports.TRIP_CLOSED = TRIP_CLOSED;
module.exports.TRIP_ACTIVE = TRIP_ACTIVE;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
