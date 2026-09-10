const mongoose = require("mongoose");

/*
 * One line in a trip's cost ledger — a tank of diesel, a toll plaza, a night
 * allowance.
 *
 * Its own collection rather than an array on the trip. Expenses are the most
 * written part of the system (a driver adds them from the roadside all day),
 * they are queried across trips constantly by the expense-analysis report, and
 * a growing array on a hot document is exactly the shape that leads to
 * conflicting writes losing somebody's fuel bill.
 */

/*
 * The categories from the brief, plus room for the owner's own. `CUSTOM` is a
 * real stored value and `customCategory` carries the name — that way an owner
 * who invents "Weighbridge" gets it grouped consistently in every report,
 * without the enum having to be edited and deployed.
 */
const EXPENSE_CATEGORIES = [
  "FUEL",
  "TOLL",
  "DRIVER_FEE",
  /* A helper's wage and food for the trip. Its own category rather than an
   * allowance: it is now quoted as its own line on every estimate, and a cost
   * that is quoted separately has to be reportable separately or the
   * planned-against-actual comparison cannot be made. */
  "HELPER",
  "FOOD",
  "ALLOWANCE",
  "PARKING",
  "REPAIR",
  "MAINTENANCE",
  "LOADING",
  "UNLOADING",
  "PERMIT",
  "TAX",
  "INSURANCE",
  "FINE",
  "COMMISSION",
  "OTHER",
  "CUSTOM",
];

/*
 * Where the entry came from. This is the audit trail the brief asks for, and it
 * is what makes the approval workflow meaningful: an owner's own entry and a
 * driver's roadside claim are not the same kind of fact, and the report has to
 * be able to say which is which.
 */
const EXPENSE_SOURCES = ["OWNER", "DRIVER", "SUB_ACCOUNT", "SYSTEM"];

const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "FUEL_CARD", "FASTAG", "BANK_TRANSFER", "CREDIT"];

/* Who actually parted with the money. It decides who is owed it back — a fuel
 * bill the driver paid in cash comes off their settlement; one on the company
 * fuel card does not. */
const PAID_BY = ["DRIVER", "OWNER", "COMPANY", "CUSTOMER", "AGENT"];

const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"];

const expenseSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      required: true,
      index: true,
    },
    /* Snapshotted so the expense report can print a trip number without
     * joining, and so a row remains readable if the trip is ever archived. */
    tripNumber: { type: String, default: "", trim: true },

    /* Denormalised from the trip. The expense-analysis report slices by lorry
     * and by driver, and copying two ids at write time is cheaper than joining
     * a million rows to trips at read time. */
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: "Vehicle", default: null, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null, index: true },

    category: { type: String, enum: EXPENSE_CATEGORIES, required: true, index: true },
    /* Only meaningful when category is CUSTOM. */
    customCategory: { type: String, default: "", trim: true, maxlength: 60 },

    amount: { type: Number, required: true, min: 0 },
    /* Quantity is optional and category-specific: litres of diesel, so the
     * report can show a rate per litre and catch a driver filling 90 litres
     * into a 60-litre tank. */
    quantity: { type: Number, default: null, min: 0 },
    unit: { type: String, default: "", trim: true, maxlength: 20 },

    /* When the money was spent, which is not when the row was created — a
     * driver enters three days of tolls on the evening they get signal back,
     * and the timeline has to show them where they happened. */
    spentAt: { type: Date, required: true, index: true },

    location: { type: String, default: "", trim: true, maxlength: 160 },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },

    paidBy: { type: String, enum: PAID_BY, default: "DRIVER" },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: "CASH" },
    referenceNumber: { type: String, default: "", trim: true, maxlength: 80 },
    receiptUrl: { type: String, default: "", trim: true, maxlength: 500 },
    notes: { type: String, default: "", trim: true, maxlength: 1000 },

    /* ================= the audit trail ================= */
    source: { type: String, enum: EXPENSE_SOURCES, default: "OWNER", index: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    addedByName: { type: String, default: "" },

    approvalStatus: {
      type: String,
      enum: APPROVAL_STATUSES,
      default: "APPROVED",
      index: true,
    },
    /*
     * The default is APPROVED, not PENDING, and that is a considered choice.
     * Most companies on day one are an owner keying in their own costs, and
     * making them approve their own entries teaches them to click through the
     * queue without reading it — which destroys the value of the queue on the
     * day it starts to matter. The route sets PENDING for entries that come
     * from a driver or from a user without expenses.approve; see
     * routes/expenses.js.
     */
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    verifiedByName: { type: String, default: "" },
    verifiedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: "", trim: true, maxlength: 300 },

    /*
     * Sent from the driver app with each entry and unique per company, so the
     * same fuel bill uploaded twice by a phone retrying over a bad connection
     * lands once. Without it, "add expense" is not safe to retry, and a driver
     * on a patchy line ends up with three copies of one ₹18,500 fill.
     */
    clientKey: { type: String, default: null },
  },
  { timestamps: true }
);

/* The trip ledger and the cost timeline. */
expenseSchema.index({ tripId: 1, spentAt: 1 });
/* The expense-analysis report: this company, this period, by category. */
expenseSchema.index({ companyId: 1, spentAt: -1, category: 1 });
/* The approval queue. */
expenseSchema.index({ companyId: 1, approvalStatus: 1, createdAt: -1 });
/* Idempotency. Partial so the vast majority of rows, which carry no key, do not
 * all collide on null. */
expenseSchema.index(
  { companyId: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: "string" } } }
);

/* What the reports group by: the owner's own name when they invented one. */
expenseSchema.virtual("categoryLabel").get(function categoryLabel() {
  if (this.category === "CUSTOM" && this.customCategory) return this.customCategory;
  return this.category;
});

expenseSchema.set("toJSON", { virtuals: true });
expenseSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("TripExpense", expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
module.exports.EXPENSE_SOURCES = EXPENSE_SOURCES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
module.exports.PAID_BY = PAID_BY;
module.exports.APPROVAL_STATUSES = APPROVAL_STATUSES;
