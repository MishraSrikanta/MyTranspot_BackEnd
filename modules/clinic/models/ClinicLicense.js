const mongoose = require("mongoose");

/*
 * A clinic's licence to use the product — the record behind its login ID.
 *
 * ================= why a row and not a flag =================
 *
 * The alternative is a boolean on the clinic, and it stops being enough the
 * first time somebody asks an ordinary question: when does this expire, when
 * was it issued, which login does it authorise, and was it suspended or has it
 * simply run out?
 *
 * None of that fits in a flag, so the licence is a record. It is created with
 * the clinic at signup and is what a renewal, a suspension or an expiry is
 * written onto — without touching the clinic itself, which the public booking
 * page is served from.
 *
 * Note what it does NOT gate: the public booking pages. A clinic whose licence
 * lapses should not have its patients told the practice does not exist, and
 * cancelling an appointment somebody already holds is not a paid feature. The
 * licence gates the clinic's own console.
 */

const STATUSES = ["active", "suspended", "expired"];

const licenseSchema = new mongoose.Schema(
  {
    /*
     * No `index: true` here, deliberately.
     *
     * The unique index is declared once, below. Declaring the field as indexed
     * AND calling schema.index() for it creates a race Mongoose resolves the
     * wrong way: it builds the plain index first, then finds the name taken and
     * silently drops the unique option — so the constraint the model appears to
     * promise does not exist. Run scripts/check-indexes.js to see this class of
     * mistake rather than discovering it when a clinic has two licences.
     */
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
    },

    /* The identity this licence authorises — "SUN-01". Denormalised from the
     * account so the licence list reads without a join. */
    loginId: { type: String, default: "", uppercase: true, trim: true, maxlength: 40 },

    /* The Account the login ID signs in as. Kept so that suspending the licence
     * can bump that account's tokenVersion and end its live sessions — a
     * suspension that leaves the desk signed in until tomorrow is not a
     * suspension. */
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },

    status: { type: String, enum: STATUSES, default: "active", index: true },

    /*
     * Null means a licence that does not lapse, which is what public signup
     * creates. Checked together with `status` rather than by a nightly job that
     * flips expired rows: the job is one more thing that can fail to run, and
     * the day it does is the day an expired licence keeps working.
     */
    expiresAt: { type: Date, default: null },

    issuedAt: { type: Date, default: Date.now },
    note: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

/* One licence per clinic. */
licenseSchema.index({ clinicId: 1 }, { unique: true });
licenseSchema.index({ loginId: 1 }, { unique: true, sparse: true });

licenseSchema.methods.isUsable = function isUsable() {
  if (this.status !== "active") return false;
  if (this.expiresAt && new Date(this.expiresAt).getTime() <= Date.now()) return false;
  return true;
};

module.exports = mongoose.model("ClinicLicense", licenseSchema);
module.exports.STATUSES = STATUSES;
