const mongoose = require("mongoose");

/*
 * Per-company, per-document-type sequence numbers — TRP-000102, EST-000045.
 *
 * The obvious implementation is `count() + 1`, and it is wrong. Two trips
 * created in the same second both read the same count and both take the same
 * number, which is discovered weeks later when two lorries are running against
 * one number and nobody can say which one the customer is asking about.
 *
 * A findOneAndUpdate with $inc is atomic in the database, so two concurrent
 * callers get two different numbers however close together they arrive.
 */

const counterSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    /* "trip", "estimate", ... */
    key: { type: String, required: true, trim: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

counterSchema.index({ companyId: 1, key: 1 }, { unique: true });

const Counter = mongoose.model("Counter", counterSchema);

/*
 * Take the next number. `upsert` means the first trip a new company creates
 * does not need the counter to have been seeded at signup — one less thing that
 * can be missed when a tenant is created by hand or by a migration.
 */
async function nextSequence(companyId, key) {
  const doc = await Counter.findOneAndUpdate(
    { companyId, key },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
}

/* TRP-000102 — zero-padded to six so the numbers sort as text in every export
 * and spreadsheet the office will inevitably make of them. */
function formatNumber(prefix, seq, width = 6) {
  return `${prefix}-${String(seq).padStart(width, "0")}`;
}

module.exports = Counter;
module.exports.nextSequence = nextSequence;
module.exports.formatNumber = formatNumber;
