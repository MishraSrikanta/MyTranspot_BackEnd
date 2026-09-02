const mongoose = require("mongoose");

/*
 * A transport business. This is the tenant, and it is the reason every other
 * collection in the system carries a `companyId`.
 *
 * Multi-tenancy is here from the first commit rather than retro-fitted,
 * because retro-fitting it means backfilling every document and re-auditing
 * every query in the product at exactly the moment the second customer signs
 * up. Trip numbering is per company too: ABC Transport and XYZ Carriers can
 * both have a TRP-000102 and neither can see the other.
 */

/* The subscription tiers from the brief. Billing is not implemented — no card
 * is ever charged here — but the limits are enforced, so the day billing is
 * added nothing about the data has to change. */
const PLANS = ["trial", "basic", "professional", "enterprise"];

/*
 * What each plan allows. `null` means unlimited.
 *
 * Kept in the code rather than in the document so a pricing change applies to
 * every existing customer at once. An `enterprise` company that negotiated
 * something different gets `limitOverrides` below — the exception is recorded
 * on the account it applies to, which is where anyone looking for it will
 * think to check.
 */
const PLAN_LIMITS = {
  trial: { users: 2, vehicles: 3, tripsPerMonth: 25 },
  basic: { users: 4, vehicles: 10, tripsPerMonth: 100 },
  professional: { users: 11, vehicles: 50, tripsPerMonth: null },
  enterprise: { users: null, vehicles: null, tripsPerMonth: null },
};

/*
 * How often a driver phone should report its position.
 *
 * The default is fifteen minutes, as specified. It is a company setting rather
 * than a constant because the right answer is genuinely different per business:
 * a fleet running long trunk routes wants a low-data fifteen-minute ping, while
 * a city distribution round is useless at anything above a minute. The driver
 * app asks the server for this value and re-reads it on every upload, so the
 * owner changing it takes effect on the next ping without anybody touching a
 * phone.
 *
 * The floor exists to protect the customer from themselves: a five-second
 * interval on a three-day trip is fifty thousand documents and a phone battery
 * that dies before lunch.
 */
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 3600;
const DEFAULT_INTERVAL_SECONDS = 900;

const trackingSettingsSchema = new mongoose.Schema(
  {
    intervalSeconds: {
      type: Number,
      default: DEFAULT_INTERVAL_SECONDS,
      min: MIN_INTERVAL_SECONDS,
      max: MAX_INTERVAL_SECONDS,
    },
    /*
     * A parked lorry does not need reporting as often as a moving one, and this
     * is where most of a driver's data allowance goes. Null means "use
     * intervalSeconds for both", which is the simplest behaviour to explain.
     */
    idleIntervalSeconds: { type: Number, default: null },
    /*
     * How far off the planned route counts as having left it. Five kilometres
     * is loose on purpose: bypasses, service roads and a straight-line planned
     * route all put an honest lorry a couple of kilometres off the line, and an
     * alert the owner learns to ignore is worse than no alert.
     */
    routeDeviationKm: { type: Number, default: 5, min: 0.2, max: 100 },
    /* Fixes vaguer than this do not move the lorry on the map. */
    maxAccuracyM: { type: Number, default: 500, min: 20, max: 5000 },
    /* How long a lorry must sit still before the trip history calls it a stop. */
    minStopMinutes: { type: Number, default: 15, min: 2, max: 240 },
    /* A phone with no signal keeps its fixes and sends them in one go. This is
     * how far back that backlog may reach before the server stops accepting it. */
    maxOfflineBacklogHours: { type: Number, default: 72, min: 1, max: 720 },
    /* Beyond this with no ping, the map shows the lorry as offline rather than
     * leaving a stale marker that looks live. Defaults to three missed
     * intervals, computed at read time so it tracks a changed interval. */
    offlineAfterMissedIntervals: { type: Number, default: 3, min: 1, max: 20 },
  },
  { _id: false }
);

/* Defaults the trip form starts from, so an owner is not typing the same
 * driver fee and diesel rate into every single trip. */
const defaultsSchema = new mongoose.Schema(
  {
    currency: { type: String, default: "INR" },
    gstPercent: { type: Number, default: 0, min: 0, max: 100 },
    /* Used by the estimate builder to turn a distance into a fuel figure. */
    dieselRatePerLitre: { type: Number, default: 0, min: 0 },
    averageKmPerLitre: { type: Number, default: 0, min: 0 },
    driverFeePerTrip: { type: Number, default: 0, min: 0 },
    driverFeePerKm: { type: Number, default: 0, min: 0 },
    foodAllowancePerDay: { type: Number, default: 0, min: 0 },
    nightAllowancePerNight: { type: Number, default: 0, min: 0 },
    tollPerKm: { type: Number, default: 0, min: 0 },
    /* The margin the estimate builder adds on top of estimated cost. */
    targetMarginPercent: { type: Number, default: 25, min: 0, max: 100 },
  },
  { _id: false }
);

const subscriptionSchema = new mongoose.Schema(
  {
    plan: { type: String, enum: PLANS, default: "trial" },
    startedAt: { type: Date, default: Date.now },
    /* null means no expiry. */
    expiresAt: { type: Date, default: null },
    /* Per-company exceptions to PLAN_LIMITS. Only set by hand. */
    limitOverrides: {
      users: { type: Number, default: null },
      vehicles: { type: Number, default: null },
      tripsPerMonth: { type: Number, default: null },
    },
  },
  { _id: false }
);

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /* Shown on estimates and invoices. */
    legalName: { type: String, default: "", trim: true, maxlength: 160 },
    gstin: { type: String, default: "", trim: true, uppercase: true, maxlength: 20 },
    pan: { type: String, default: "", trim: true, uppercase: true, maxlength: 15 },
    phone: { type: String, default: "", trim: true, maxlength: 20 },
    email: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },
    address: { type: String, default: "", trim: true, maxlength: 400 },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    state: { type: String, default: "", trim: true, maxlength: 80 },
    /*
     * Reporting is done in the company's own working day. A fleet in Odisha
     * closing a trip at half past eleven at night must see it in that day's
     * figures, not tomorrow's, which is what happens if the server's UTC day is
     * used for the month boundary.
     */
    timezone: { type: String, default: "Asia/Kolkata" },
    /* Prefix for generated trip numbers: TRP-000102. */
    tripPrefix: { type: String, default: "TRP", trim: true, uppercase: true, maxlength: 6 },
    estimatePrefix: { type: String, default: "EST", trim: true, uppercase: true, maxlength: 6 },

    tracking: { type: trackingSettingsSchema, default: () => ({}) },
    defaults: { type: defaultsSchema, default: () => ({}) },
    subscription: { type: subscriptionSchema, default: () => ({}) },

    /* Soft off-switch for the whole tenant. Never delete a company: its trips
     * are somebody's accounts. */
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/* A dated plan is active until it expires; a plan with no expiry always is.
 * Kept as a method rather than a stored flag so it cannot go stale. */
companySchema.methods.subscriptionIsActive = function subscriptionIsActive() {
  if (!this.isActive) return false;
  const sub = this.subscription || {};
  if (!sub.expiresAt) return true;
  return new Date(sub.expiresAt).getTime() > Date.now();
};

/* The limits in force, negotiated exceptions included. */
companySchema.methods.limits = function limits() {
  const sub = this.subscription || {};
  const base = PLAN_LIMITS[sub.plan] || PLAN_LIMITS.trial;
  const over = sub.limitOverrides || {};
  return {
    users: over.users ?? base.users,
    vehicles: over.vehicles ?? base.vehicles,
    tripsPerMonth: over.tripsPerMonth ?? base.tripsPerMonth,
  };
};

/*
 * The tracking configuration a driver phone is handed. Everything the app needs
 * to decide when to wake up, what to keep, and when to give up is resolved here
 * rather than left to the app to work out — one interval, decided in one place,
 * is what makes "the owner changed it" reliable.
 */
companySchema.methods.trackingConfig = function trackingConfig() {
  const t = this.tracking || {};
  const intervalSeconds = t.intervalSeconds || DEFAULT_INTERVAL_SECONDS;
  return {
    intervalSeconds,
    idleIntervalSeconds: t.idleIntervalSeconds || intervalSeconds,
    routeDeviationKm: t.routeDeviationKm ?? 5,
    maxAccuracyM: t.maxAccuracyM ?? 500,
    minStopMinutes: t.minStopMinutes ?? 15,
    maxOfflineBacklogHours: t.maxOfflineBacklogHours ?? 72,
    /* Derived, so shortening the interval also tightens what counts as
     * offline — an owner who moves to one-minute pings expects a lorry to go
     * grey in minutes, not in three quarters of an hour. */
    offlineAfterSeconds: intervalSeconds * (t.offlineAfterMissedIntervals ?? 3),
    minIntervalSeconds: MIN_INTERVAL_SECONDS,
    maxIntervalSeconds: MAX_INTERVAL_SECONDS,
  };
};

module.exports = mongoose.model("Company", companySchema);
module.exports.PLANS = PLANS;
module.exports.PLAN_LIMITS = PLAN_LIMITS;
module.exports.MIN_INTERVAL_SECONDS = MIN_INTERVAL_SECONDS;
module.exports.MAX_INTERVAL_SECONDS = MAX_INTERVAL_SECONDS;
module.exports.DEFAULT_INTERVAL_SECONDS = DEFAULT_INTERVAL_SECONDS;
