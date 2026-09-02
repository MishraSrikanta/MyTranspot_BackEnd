const mongoose = require("mongoose");

/*
 * Money that actually moved — a customer paying an invoice, a driver drawing an
 * advance, the office settling a driver's fees.
 *
 * Both directions live in one collection with a `kind` discriminator rather
 * than in two. They are the same event seen from opposite sides, every screen
 * that lists them wants them in one date-ordered ledger, and splitting them
 * would mean two near-identical models and a union query on every cash report.
 *
 * Note what this is NOT: a trip expense. A driver spending ₹850 at a toll plaza
 * is a cost of the trip and belongs in TripExpense; the office later handing
 * that driver ₹6,000 is a settlement and belongs here. Recording a settlement
 * as an expense is the classic way to count the same rupee twice and report a
 * profit that is quietly half of what it should be.
 */

const PAYMENT_KINDS = [
  /* Customer -> company. Against a trip, or on account. */
  "CUSTOMER_RECEIPT",
  /* Company -> driver, settling fees already earned. */
  "DRIVER_PAYMENT",
  /* Company -> driver, before the work. Recovered from the settlement. */
  "DRIVER_ADVANCE",
];

const DIRECTIONS = ["IN", "OUT"];

const METHODS = ["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "CARD", "OTHER"];

const paymentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    kind: { type: String, enum: PAYMENT_KINDS, required: true, index: true },
    /* Derived from kind on save. Held as its own field so a cash-flow total is
     * a sum over one column rather than a conditional over three kinds. */
    direction: { type: String, enum: DIRECTIONS, required: true },

    amount: { type: Number, required: true, min: 0 },
    paidAt: { type: Date, required: true, index: true },
    method: { type: String, enum: METHODS, default: "CASH" },
    referenceNumber: { type: String, default: "", trim: true, maxlength: 80 },

    /* Optional on both sides. A customer paying three invoices with one
     * transfer has no single trip; a driver advance is often for the month
     * rather than for a run. */
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", default: null, index: true },
    tripNumber: { type: String, default: "" },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    customerName: { type: String, default: "" },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null, index: true },
    driverName: { type: String, default: "" },

    notes: { type: String, default: "", trim: true, maxlength: 1000 },
    receiptUrl: { type: String, default: "", trim: true, maxlength: 500 },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    recordedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

paymentSchema.index({ companyId: 1, paidAt: -1 });
paymentSchema.index({ companyId: 1, kind: 1, paidAt: -1 });

paymentSchema.pre("validate", function deriveDirection() {
  this.direction = this.kind === "CUSTOMER_RECEIPT" ? "IN" : "OUT";
});

module.exports = mongoose.model("Payment", paymentSchema);
module.exports.PAYMENT_KINDS = PAYMENT_KINDS;
module.exports.METHODS = METHODS;
