const mongoose = require("mongoose");

/*
 * A consignor — the party that pays for the load.
 *
 * Kept as its own collection rather than a name typed onto each trip, because
 * customer profitability is one of the things the product exists to answer.
 * "Which of my customers are actually worth running for?" cannot be asked of a
 * free-text field where the same firm appears as "XYZ Industries", "XYZ Inds"
 * and "xyz industries ltd".
 */

const customerSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 160 },
    contactPerson: { type: String, default: "", trim: true, maxlength: 80 },
    phone: { type: String, default: "", trim: true, maxlength: 20 },
    email: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },
    gstin: { type: String, default: "", trim: true, uppercase: true, maxlength: 20 },
    address: { type: String, default: "", trim: true, maxlength: 400 },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    state: { type: String, default: "", trim: true, maxlength: 80 },

    /*
     * How long this customer gets to pay. Not enforced anywhere yet; it is what
     * an ageing report is built from, and recording it from day one costs
     * nothing while backfilling it later means asking the office to remember
     * terms agreed two years ago.
     */
    creditDays: { type: Number, default: 0, min: 0, max: 365 },
    creditLimit: { type: Number, default: 0, min: 0 },

    notes: { type: String, default: "", trim: true, maxlength: 2000 },

    /* Archived, not deleted: their past trips are the profitability history. */
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/*
 * One name per company, case-insensitively. This is the index that stops the
 * customer profitability report splitting one firm across three rows — and it
 * is scoped to companyId, so two tenants may both have an "XYZ Industries".
 */
customerSchema.index(
  { companyId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

module.exports = mongoose.model("Customer", customerSchema);
