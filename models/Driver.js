const mongoose = require("mongoose");

/* Shared with Employee so a driver and a helper cost money the same way. */
const { paySchema } = require("./Employee");

/*
 * An employee who drives. Separate from the Account that a driver may or may
 * not hold — see models/Account.js for why.
 *
 * The running totals at the bottom (trips, kilometres, fees) are maintained
 * when a trip closes rather than counted on every read. A driver profile opened
 * from the fleet list would otherwise scan that driver's entire trip history to
 * print one number, and the history only grows.
 */

/*
 * What the driver is doing right now. Held here as well as being derivable from
 * the trips, because "who is free on Thursday?" is asked constantly and must
 * not require reading every open trip to answer.
 */
const DRIVER_STATUSES = ["AVAILABLE", "ON_TRIP", "ON_LEAVE", "INACTIVE"];

const driverSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    altPhone: { type: String, default: "", trim: true, maxlength: 20 },
    address: { type: String, default: "", trim: true, maxlength: 400 },

    licenceNumber: { type: String, default: "", trim: true, uppercase: true, maxlength: 40 },
    licenceExpiry: { type: Date, default: null },
    /*
     * A driver whose licence expires next week should turn up on a dashboard,
     * not be discovered at a check post. The date is what the reminder is built
     * from; nothing here blocks assigning them, because a real yard sometimes
     * has to move a lorry anyway and a system that refuses just gets worked
     * around.
     */

    joinedOn: { type: Date, default: null },

    /* Defaults the trip form starts from for this particular driver — some
     * drivers are simply paid more. Overridable per trip. */
    defaultTripFee: { type: Number, default: 0, min: 0 },
    defaultFeePerKm: { type: Number, default: 0, min: 0 },

    /*
     * The salaried side of what a driver costs.
     *
     * The two fee fields above are what a driver earns FROM A TRIP, booked
     * against that trip and settled from its ledger. This block is what they
     * cost the business every month whether a lorry moves or not — and it is
     * the same shape as a helper's or a labourer's, deliberately, so payroll
     * and the profit-and-loss report can add the whole workforce together
     * without knowing which collection anybody came from.
     *
     * See models/Employee.js for why standing and incurred costs are kept
     * apart; getting that wrong double-counts a salary the moment a driver runs
     * a second trip in the same month.
     */
    pay: { type: paySchema, default: () => ({}) },

    status: { type: String, enum: DRIVER_STATUSES, default: "AVAILABLE", index: true },

    /* The lorry this driver usually takes. Not a lock — the trip records who
     * actually drove. */
    assignedVehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      default: null,
      index: true,
    },
    currentTripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
      index: true,
    },

    /* The login this driver uses on the phone, if they have one. */
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },

    /* ================= running totals =================
     * Advanced when a trip is closed. `feesPaid` moves when a payment is
     * recorded, so `feesEarned - feesPaid` is what the driver is still owed —
     * the number the yard actually argues about on a Saturday.
     */
    totals: {
      trips: { type: Number, default: 0 },
      distanceKm: { type: Number, default: 0 },
      feesEarned: { type: Number, default: 0 },
      feesPaid: { type: Number, default: 0 },
      advances: { type: Number, default: 0 },
    },

    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

driverSchema.index({ companyId: 1, status: 1 });
driverSchema.index({ companyId: 1, name: 1 });
/* Sparse, because most companies leave the licence field blank at first and a
 * plain unique index would then reject the second driver for colliding on "". */
driverSchema.index(
  { companyId: 1, licenceNumber: 1 },
  { unique: true, sparse: true, partialFilterExpression: { licenceNumber: { $type: "string", $ne: "" } } }
);

/* What the driver is still owed. */
driverSchema.virtual("outstandingFee").get(function outstandingFee() {
  const t = this.totals || {};
  return Math.round(((t.feesEarned || 0) - (t.feesPaid || 0)) * 100) / 100;
});

driverSchema.set("toJSON", { virtuals: true });
driverSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Driver", driverSchema);
module.exports.DRIVER_STATUSES = DRIVER_STATUSES;
