const mongoose = require("mongoose");

/*
 * Per-tenant, per-document-type sequence numbers — TRP-000102, PT-2026-000124,
 * INV-2026-001245, and the daily token number at a clinic's front desk.
 *
 * The obvious implementation is `count() + 1`, and it is wrong. Two invoices
 * raised in the same second both read the same count and both take the same
 * number, which is discovered weeks later when the books will not reconcile and
 * nobody can say which of the two a payment belongs to. At a clinic reception
 * it is worse and faster: two patients are handed token A-024 and both stand up
 * when it is called.
 *
 * A findOneAndUpdate with $inc is atomic in the database, so two concurrent
 * callers get two different numbers however close together they arrive.
 *
 * ================= tenantId, not companyId =================
 *
 * This collection is shared by both modules, so the tenant field is named for
 * what it is rather than for one product's word for it: a companyId for a
 * transport tenant, an ownerId for a clinic one. Deployments created before the
 * rename need scripts/migrate-counters.js run once — renaming the field without
 * moving the existing rows would restart every sequence at 1 and re-issue trip
 * numbers that are already on customers' invoices.
 */

const counterSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    /*
     * "trip", "estimate", "patient", "invoice", "report", and the compound keys
     * the token queue uses — "token:<clinicId>:<doctorId>:2026-09-07".
     *
     * Compounding into the key rather than adding columns is what keeps this
     * collection able to number anything: a daily token counter is just a key
     * that stops being used tomorrow, and it needs no schema change and no
     * nightly reset job to make that true.
     */
    key: { type: String, required: true, trim: true, maxlength: 120 },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

const Counter = mongoose.model("Counter", counterSchema);

/*
 * Take the next number. `upsert` means the first invoice a new clinic raises
 * does not need the counter to have been seeded at signup — one less thing that
 * can be missed when a tenant is created by hand or by a migration.
 */
async function nextSequence(tenantId, key) {
  const doc = await Counter.findOneAndUpdate(
    { tenantId, key },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
}

/*
 * Read a sequence without consuming one. For the queue display, which wants to
 * say "24 issued today" without issuing a twenty-fifth.
 */
async function peekSequence(tenantId, key) {
  const doc = await Counter.findOne({ tenantId, key }).select("seq");
  return doc ? doc.seq : 0;
}

/* TRP-000102 — zero-padded to six so the numbers sort as text in every export
 * and spreadsheet the office will inevitably make of them. */
function formatNumber(prefix, seq, width = 6) {
  return `${prefix}-${String(seq).padStart(width, "0")}`;
}

/*
 * PT-2026-000124 — the year in the middle.
 *
 * Clinics number by year, and it is not decoration: it is what makes a patient
 * id or an invoice number readable to the person holding the paper, and what
 * lets the sequence restart each January without ever colliding with last
 * year's. The year is passed in rather than read from the clock so a document
 * back-dated to December keeps December's series.
 */
function formatYearNumber(prefix, year, seq, width = 6) {
  return `${prefix}-${year}-${String(seq).padStart(width, "0")}`;
}

module.exports = Counter;
module.exports.nextSequence = nextSequence;
module.exports.peekSequence = peekSequence;
module.exports.formatNumber = formatNumber;
module.exports.formatYearNumber = formatYearNumber;
