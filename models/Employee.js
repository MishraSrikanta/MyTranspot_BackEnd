const mongoose = require("mongoose");

/*
 * Everybody on the payroll who is not behind the wheel.
 *
 * ================= why this is separate from Driver =================
 *
 * A driver is a person the system tracks: they hold a licence, they are
 * assigned to a lorry, they report positions, they may have a login. A helper
 * loading steel coils is none of those things, and forcing them into the Driver
 * collection would mean every trip-assignment dropdown, every licence-expiry
 * report and the whole driver-app login path had to learn to ignore half its
 * own rows.
 *
 * What the two DO share is the thing this module exists for: they cost the
 * owner money every month whether a lorry moves or not. That is the `pay` block
 * below, and it is deliberately identical on both models so the payroll total
 * and the profit-and-loss report can add them up without caring which
 * collection a person came from.
 */

const EMPLOYEE_ROLES = [
  /* Rides with the lorry and loads it. Paid a salary plus a daily allowance on
   * the road, which is why both live in `pay`. */
  "HELPER",
  /* Hired for loading and unloading, often by the day rather than the month. */
  "LABOUR",
  "MECHANIC",
  "SUPERVISOR",
  "OFFICE",
  "OTHER",
];

/*
 * What a person costs, per month and per day.
 *
 * ================= the distinction that matters =================
 *
 * `monthlySalary` is a STANDING cost: it is owed on a month when the lorry sat
 * in the yard, and that is precisely why a transport business can look
 * profitable trip by trip and still lose money. Every trip-level profit figure
 * in this product excludes it, so the profit-and-loss report apportions it
 * across the period instead — see utils/standingCost.js.
 *
 * `foodPerDay` and `otherPerDay` are INCURRED costs: they only happen when the
 * person is actually out on a run, so they belong in a trip's estimate and in
 * its expenses.
 *
 * Keeping the two apart is the whole point. Adding a driver's salary to a trip
 * as though it were a trip cost double-counts it the moment the same driver
 * runs a second trip that month.
 */
const paySchema = new mongoose.Schema(
  {
    /* Owed every month regardless of work done. */
    monthlySalary: { type: Number, default: 0, min: 0 },
    /* Paid for each day the person is out on a trip. */
    foodPerDay: { type: Number, default: 0, min: 0 },
    otherPerDay: { type: Number, default: 0, min: 0 },
    /* For people hired by the day rather than salaried — a labour gang taken on
     * for one loading. Left at zero for salaried staff. */
    dailyWage: { type: Number, default: 0, min: 0 },
    /* A one-off amount for a completed trip, on top of anything above. */
    perTripBonus: { type: Number, default: 0, min: 0 },
    /* What the owner actually paid out, advanced when a payment is recorded.
     * Kept here so "what do I still owe this person" does not need a scan of
     * the payment ledger on every screen. */
    paidToDate: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const employeeSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 80 },
    role: { type: String, enum: EMPLOYEE_ROLES, default: "HELPER", index: true },
    phone: { type: String, default: "", trim: true, maxlength: 20 },
    address: { type: String, default: "", trim: true, maxlength: 400 },
    /* Aadhaar, PAN, a works number — whatever the office files them under. Not
     * validated, because it is different in every yard. */
    idNumber: { type: String, default: "", trim: true, maxlength: 60 },

    pay: { type: paySchema, default: () => ({}) },

    /*
     * A helper who always rides with the same lorry.
     *
     * Optional, and useful for exactly one thing: when the owner asks what a
     * particular lorry costs to run, the helper who never leaves it is part of
     * that answer. A helper attached to no vehicle is a company overhead
     * instead.
     */
    assignedVehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      default: null,
      index: true,
    },

    joinedOn: { type: Date, default: null },
    leftOn: { type: Date, default: null },

    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    /* Archived, not deleted: they appear in months that are already closed. */
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

employeeSchema.index({ companyId: 1, isActive: 1, role: 1 });
employeeSchema.index({ companyId: 1, name: 1 });

/*
 * What this person costs the business in a month, all in.
 *
 * `daysOnRoad` is passed by the caller rather than inferred, because only the
 * trip records know it and this model has no business querying them. A salaried
 * office clerk is called with zero and costs their salary; a labour gang hired
 * for six days costs six daily wages and nothing else.
 */
employeeSchema.methods.monthlyCost = function monthlyCost(daysOnRoad = 0) {
  const pay = this.pay || {};
  const salary = pay.monthlySalary || 0;
  const daily = (pay.dailyWage || 0) * daysOnRoad;
  const onRoad = ((pay.foodPerDay || 0) + (pay.otherPerDay || 0)) * daysOnRoad;
  return Math.round((salary + daily + onRoad) * 100) / 100;
};

/* What a day of this person's time costs on a trip — the incurred part only,
 * which is what an estimate should carry. */
employeeSchema.methods.costPerDayOnTrip = function costPerDayOnTrip() {
  const pay = this.pay || {};
  return Math.round(((pay.dailyWage || 0) + (pay.foodPerDay || 0) + (pay.otherPerDay || 0)) * 100) / 100;
};

const Employee = mongoose.model("Employee", employeeSchema);

module.exports = Employee;
module.exports.EMPLOYEE_ROLES = EMPLOYEE_ROLES;
/* Shared with the Driver model so payroll can add the two together. */
module.exports.paySchema = paySchema;
