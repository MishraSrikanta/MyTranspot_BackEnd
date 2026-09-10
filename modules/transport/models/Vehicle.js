const mongoose = require("mongoose");

/*
 * A lorry. Kept firmly separate from the trips it runs: a vehicle outlives any
 * one trip, carries documents that expire on their own schedule, and is the
 * unit the owner judges profitability by.
 */

const VEHICLE_STATUSES = ["AVAILABLE", "ON_TRIP", "MAINTENANCE", "OFFLINE"];
/*
 * What the yard actually holds.
 *
 * The first six are goods carriers. The rest are plant — a JCB, a hydra, a
 * crane — and they belong in the same fleet for a reason that is not obvious
 * until you own one: they are financed on the same EMI, they burn the same
 * diesel, they are hired out by the hour or the day, and the owner asks exactly
 * the same question about them ("is that machine paying for itself?"). Keeping
 * them in a separate list would mean a second set of every screen in this
 * product to answer it.
 */
const VEHICLE_TYPES = [
  /* goods carriers */
  "TRUCK",
  "TRAILER",
  "TANKER",
  "CONTAINER",
  "TIPPER",
  "DUMPER",
  "LCV",
  "PICKUP",
  "TEMPO",
  /* earth-moving and lifting plant, hired by the hour or the day */
  "JCB",
  "HYDRA",
  "CRANE",
  "EXCAVATOR",
  "LOADER",
  "BULLDOZER",
  "ROLLER",
  "TRACTOR",
  /* everything else the business runs */
  "BUS",
  "CAR",
  "OTHER",
];

/*
 * The papers that get a lorry stopped at a check post if they have lapsed.
 * Modelled as a list rather than fixed fields because the set differs by state
 * and by cargo, and a fixed schema means a migration every time a customer
 * carries something new.
 */
const documentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true, maxlength: 60 },
    number: { type: String, default: "", trim: true, maxlength: 80 },
    issuedOn: { type: Date, default: null },
    /* What the expiry dashboard is built from. */
    expiresOn: { type: Date, default: null, index: true },
    fileUrl: { type: String, default: "", trim: true, maxlength: 500 },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

/*
 * What this vehicle costs to run, and what it costs to own.
 *
 * ================= the two kinds of cost =================
 *
 * PER KILOMETRE is what a kilometre wears out: tyres, servicing, the greasing
 * and the brake shoes. Diesel is not here — it is derived from `averageKmPerLitre`
 * and the day's diesel rate, because it is the one input that changes weekly and
 * an owner should not have to re-key a rate per lorry when the pump price moves.
 *
 * PER MONTH is what the vehicle costs while it is parked: the EMI, the
 * insurance, the permits, the yard. This is the money that decides whether a
 * business is actually profitable, and it appears in no trip's ledger. A fleet
 * of lorries each turning a tidy profit per run can still lose money every
 * month, and until these figures exist the product cannot say so.
 *
 * Everything defaults to zero and contributes nothing until it is filled in, so
 * an owner who only knows their EMI gets a truthful — if partial — answer from
 * the day they type it.
 */
const runningCostSchema = new mongoose.Schema(
  {
    /* ---- per kilometre ---- */
    maintenancePerKm: { type: Number, default: 0, min: 0 },
    tyresPerKm: { type: Number, default: 0, min: 0 },
    /* Anything else a kilometre costs — greasing, washing, small repairs. */
    otherPerKm: { type: Number, default: 0, min: 0 },
    /*
     * This vehicle's own toll rate, overriding the company default.
     *
     * Worth having per vehicle rather than per company: a multi-axle trailer
     * pays roughly three times what an LCV pays at the same plaza, so one
     * company-wide figure is wrong for both.
     */
    tollPerKm: { type: Number, default: 0, min: 0 },

    /* ---- per month, whether it moves or not ---- */
    emiPerMonth: { type: Number, default: 0, min: 0 },
    /* When the loan finishes, so the standing cost stops on its own rather than
     * quietly overstating the fleet's overhead for years. */
    emiEndsOn: { type: Date, default: null },
    insurancePerMonth: { type: Number, default: 0, min: 0 },
    permitPerMonth: { type: Number, default: 0, min: 0 },
    parkingPerMonth: { type: Number, default: 0, min: 0 },
    /* Fitness, road tax, tracker subscription — the small standing charges. */
    otherPerMonth: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const vehicleSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    /* Stored normalised — no spaces, upper case — so "OD 02 AB 1234" and
     * "od02ab1234" are one lorry and not three. */
    registrationNumber: { type: String, required: true, trim: true, uppercase: true },
    type: { type: String, enum: VEHICLE_TYPES, default: "TRUCK" },
    make: { type: String, default: "", trim: true, maxlength: 60 },
    model: { type: String, default: "", trim: true, maxlength: 60 },
    year: { type: Number, default: null, min: 1950, max: 2100 },
    capacityTons: { type: Number, default: 0, min: 0 },
    axles: { type: Number, default: 0, min: 0, max: 20 },

    /* Whose lorry it is. Hired lorries run alongside owned ones in most fleets
     * and their economics are completely different, so the report has to be
     * able to tell them apart. */
    ownership: {
      type: String,
      enum: ["OWNED", "LEASED", "ATTACHED"],
      default: "OWNED",
    },
    ownerName: { type: String, default: "", trim: true, maxlength: 120 },

    /* Feeds the estimate builder: the fuel line on a quote is distance divided
     * by this, times the diesel rate. Falls back to the company default when
     * left at zero. */
    averageKmPerLitre: { type: Number, default: 0, min: 0 },
    fuelTankLitres: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: VEHICLE_STATUSES, default: "AVAILABLE", index: true },

    currentDriverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      default: null,
      index: true,
    },
    currentTripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
      index: true,
    },

    /*
     * A per-vehicle override of the company reporting interval. Null means
     * follow the company. It exists because one lorry in a fleet is often
     * different — a high-value load the owner wants pinged every minute — and
     * the alternative is turning the whole fleet up and paying for it in data.
     */
    trackingIntervalSeconds: { type: Number, default: null, min: 10, max: 3600 },

    odometerKm: { type: Number, default: 0, min: 0 },

    documents: { type: [documentSchema], default: [] },

    /* See runningCostSchema above: per-kilometre wear, and the monthly cost of
     * owning the thing at all. */
    runningCost: { type: runningCostSchema, default: () => ({}) },

    /* ================= running totals =================
     * Advanced when a trip closes, for the same reason as the driver totals:
     * the vehicle profitability table must not read every trip ever run.
     */
    totals: {
      trips: { type: Number, default: 0 },
      distanceKm: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },
      cost: { type: Number, default: 0 },
    },

    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/* One plate per company. Scoped to companyId, so an attached lorry that later
 * works for a second tenant on the platform is not blocked. */
vehicleSchema.index({ companyId: 1, registrationNumber: 1 }, { unique: true });
vehicleSchema.index({ companyId: 1, status: 1 });
/* The document-expiry dashboard: every lorry in the company with a paper
 * lapsing before a date. */
vehicleSchema.index({ companyId: 1, "documents.expiresOn": 1 });

vehicleSchema.virtual("profit").get(function profit() {
  const t = this.totals || {};
  return Math.round(((t.revenue || 0) - (t.cost || 0)) * 100) / 100;
});

vehicleSchema.set("toJSON", { virtuals: true });
vehicleSchema.set("toObject", { virtuals: true });

/*
 * What a kilometre costs, excluding diesel and tolls.
 *
 * Those two are excluded on purpose: diesel is computed from the vehicle's
 * mileage and the current pump rate, and tolls are a distance charge with their
 * own line on every quote. Rolling either into one blended "cost per km" is how
 * an owner loses the ability to see which of them moved when the number
 * changes.
 */
vehicleSchema.methods.wearPerKm = function wearPerKm() {
  const r = this.runningCost || {};
  return round2((r.maintenancePerKm || 0) + (r.tyresPerKm || 0) + (r.otherPerKm || 0));
};

/*
 * The monthly standing cost of owning this vehicle.
 *
 * `on` is the month being asked about, which matters only for the EMI: a loan
 * that finished in March must not still be charged against April, and an owner
 * who has to remember to zero the field themselves will not.
 */
vehicleSchema.methods.fixedMonthlyCost = function fixedMonthlyCost(on = new Date()) {
  const r = this.runningCost || {};
  const emiRunning = !r.emiEndsOn || new Date(r.emiEndsOn).getTime() >= new Date(on).getTime();
  return round2(
    (emiRunning ? r.emiPerMonth || 0 : 0) +
      (r.insurancePerMonth || 0) +
      (r.permitPerMonth || 0) +
      (r.parkingPerMonth || 0) +
      (r.otherPerMonth || 0)
  );
};

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

module.exports = mongoose.model("Vehicle", vehicleSchema);
module.exports.VEHICLE_STATUSES = VEHICLE_STATUSES;
module.exports.VEHICLE_TYPES = VEHICLE_TYPES;
