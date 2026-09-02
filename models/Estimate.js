const mongoose = require("mongoose");

/*
 * A quotation — what the owner tells a customer a load will cost them, before
 * anything is agreed.
 *
 * This is a first-class document rather than a calculator on a screen, and the
 * reason is the loop it closes. An estimate records what the trip was expected
 * to cost the transporter and what the customer was quoted; the trip it becomes
 * records what it actually cost and actually earned. Keeping the quote means
 * the owner can eventually answer the question that decides whether the
 * business grows: "am I pricing this lane correctly?" A quote worked out on a
 * screen and thrown away can never answer it.
 */

const ESTIMATE_STATUSES = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  /* Accepted and turned into a real trip. Terminal — an estimate cannot become
   * two trips, or the profit from one run gets counted against two quotes. */
  "CONVERTED",
];

/*
 * The cost side of the quote, in the same categories as a trip's estimate and a
 * trip's expenses. Three places, one vocabulary — that is what lets the system
 * put quoted, budgeted and actual fuel side by side in one row.
 */
const costSchema = new mongoose.Schema(
  {
    fuel: { type: Number, default: 0, min: 0 },
    toll: { type: Number, default: 0, min: 0 },
    driver: { type: Number, default: 0, min: 0 },
    food: { type: Number, default: 0, min: 0 },
    allowance: { type: Number, default: 0, min: 0 },
    /* Tyres, servicing and wear, charged per kilometre from the vehicle's own
     * running cost. Without this line a quote is short by whatever the lorry
     * actually costs to move. */
    running: { type: Number, default: 0, min: 0 },
    /* The helpers riding with the load: daily wage plus food, per day. */
    helper: { type: Number, default: 0, min: 0 },
    maintenance: { type: Number, default: 0, min: 0 },
    other: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/* How the fuel and driver lines above were arrived at. Held so the quote can be
 * re-opened and defended a month later, when diesel has moved and the customer
 * asks why the same run now costs more. */
const basisSchema = new mongoose.Schema(
  {
    distanceKm: { type: Number, default: 0, min: 0 },
    /* Round trip quotes the return leg too — an empty return still burns
     * diesel, and a quote that ignores it loses money on every lane that has no
     * back-load. */
    isRoundTrip: { type: Boolean, default: false },
    /* The distance every per-kilometre line was charged on — the one-way figure
     * doubled for a round trip. Stored so a quote re-opened in six weeks does
     * not have to re-derive it and risk deriving it differently. */
    chargeableKm: { type: Number, default: 0, min: 0 },
    tripDays: { type: Number, default: 1, min: 0 },
    nights: { type: Number, default: 0, min: 0 },
    kmPerLitre: { type: Number, default: 0, min: 0 },
    dieselRatePerLitre: { type: Number, default: 0, min: 0 },
    litresRequired: { type: Number, default: 0, min: 0 },
    tollPerKm: { type: Number, default: 0, min: 0 },
    /* From the vehicle: maintenance + tyres + other, per kilometre. */
    runningCostPerKm: { type: Number, default: 0, min: 0 },
    driverFeePerKm: { type: Number, default: 0, min: 0 },
    driverFeePerTrip: { type: Number, default: 0, min: 0 },
    /* The driver's own food and incidentals for each day of the trip — what the
     * owner hands them for the road, as opposed to what they earn for the job. */
    driverDayCost: { type: Number, default: 0, min: 0 },
    foodPerDay: { type: Number, default: 0, min: 0 },
    nightAllowance: { type: Number, default: 0, min: 0 },
    helperCount: { type: Number, default: 0, min: 0 },
    helperCostPerDay: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/* What the customer is quoted. Mirrors the trip's revenue block so accepting an
 * estimate copies straight across. */
const quoteSchema = new mongoose.Schema(
  {
    freightCharges: { type: Number, default: 0, min: 0 },
    loadingCharges: { type: Number, default: 0, min: 0 },
    unloadingCharges: { type: Number, default: 0, min: 0 },
    otherCharges: { type: Number, default: 0, min: 0 },
    gstPercent: { type: Number, default: 0, min: 0, max: 100 },
    gstAmount: { type: Number, default: 0, min: 0 },
    subTotal: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const estimateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    estimateNumber: { type: String, required: true, trim: true, uppercase: true },
    sequence: { type: Number, required: true },

    /* Optional: a quote is often given to somebody who is not yet a customer,
     * and forcing a customer record to be created first is how an owner ends up
     * with fifty half-filled contacts from enquiries that went nowhere. */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    customerName: { type: String, required: true, trim: true, maxlength: 160 },
    contactPhone: { type: String, default: "", trim: true, maxlength: 20 },
    contactEmail: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },

    origin: {
      name: { type: String, required: true, trim: true, maxlength: 160 },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    destination: {
      name: { type: String, required: true, trim: true, maxlength: 160 },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    routeKey: { type: String, default: "", index: true },
    routePoints: {
      type: [{ lat: Number, lng: Number, _id: false }],
      default: [],
    },

    vehicleType: { type: String, default: "TRUCK", trim: true, maxlength: 40 },
    goodsDescription: { type: String, default: "", trim: true, maxlength: 300 },
    weightTons: { type: Number, default: 0, min: 0 },

    basis: { type: basisSchema, default: () => ({}) },
    cost: { type: costSchema, default: () => ({}) },
    /* The markup applied to cost to reach the freight figure. Stored, not
     * inferred, so the owner can see at a glance which quotes were cut thin. */
    marginPercent: { type: Number, default: 0, min: -100, max: 1000 },
    quote: { type: quoteSchema, default: () => ({}) },

    /* Expected profit if the trip runs exactly as quoted. */
    expectedProfit: { type: Number, default: 0 },

    validUntil: { type: Date, default: null },
    status: { type: String, enum: ESTIMATE_STATUSES, default: "DRAFT", index: true },
    sentAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: "", trim: true, maxlength: 300 },

    convertedTripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", default: null },

    terms: { type: String, default: "", trim: true, maxlength: 2000 },
    notes: { type: String, default: "", trim: true, maxlength: 2000 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

estimateSchema.index({ companyId: 1, estimateNumber: 1 }, { unique: true });
estimateSchema.index({ companyId: 1, status: 1, createdAt: -1 });
estimateSchema.index({ companyId: 1, customerId: 1, createdAt: -1 });

/*
 * Expiry is read, not swept. A quote that lapsed at midnight is expired the
 * moment somebody looks at it, with no job to run and nothing to go stale; and
 * a stored EXPIRED status set by a cron would be wrong for exactly as long as
 * the cron was down.
 */
estimateSchema.methods.effectiveStatus = function effectiveStatus() {
  if (this.status === "SENT" && this.validUntil && new Date(this.validUntil) < new Date()) {
    return "EXPIRED";
  }
  return this.status;
};

estimateSchema.pre("save", function deriveRouteKey() {
  if (this.origin?.name && this.destination?.name) {
    const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, " ");
    this.routeKey = `${norm(this.origin.name)}|${norm(this.destination.name)}`;
  }
});

module.exports = mongoose.model("Estimate", estimateSchema);
module.exports.ESTIMATE_STATUSES = ESTIMATE_STATUSES;
