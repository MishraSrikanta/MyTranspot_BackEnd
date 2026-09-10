const mongoose = require("mongoose");

/*
 * Who did what. Written for the handful of actions where the answer matters —
 * approving an expense, cancelling an invoice, signing a report, granting
 * somebody a permission, and signing in and out.
 *
 * Deliberately NOT a log of every write. An audit trail nobody can read is the
 * same as no audit trail, and a table with a row for every field a clerk tabbed
 * through is unreadable within a week. The rule applied throughout the routes
 * is: log it if somebody might one day have to be answerable for it.
 */

const auditSchema = new mongoose.Schema(
  {
    /* Which product the row belongs to, so one clinic's audit screen never has
     * to filter a haulage company's rows out of its own query. */
    module: { type: String, default: "transport", index: true },

    /*
     * The tenant: a companyId for transport, an ownerId for clinic. Named for
     * what it is, because this collection is shared and the audit writer has no
     * business knowing which product it is serving.
     */
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    /*
     * The second level of clinic tenancy. Null for a transport row and for an
     * owner-level clinic action — creating a clinic is not an action INSIDE
     * one, and filing it under the clinic it created would hide it from the
     * owner's own activity list.
     */
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Clinic",
      default: null,
      index: true,
    },

    /* "expense.approved", "invoice.cancel", "auth.login", "report.version" */
    action: { type: String, required: true, trim: true, maxlength: 60, index: true },

    entityType: { type: String, required: true, trim: true, maxlength: 40 },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    /* The invoice number or the patient id, so the log reads without a join. */
    entityLabel: { type: String, default: "", trim: true, maxlength: 120 },

    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    /* Snapshotted: a dismissed receptionist's name must stay readable on the
     * rows they created, and their login may be gone. */
    actorName: { type: String, default: "" },
    actorRole: { type: String, default: "" },

    /*
     * Before and after, but only for the fields that moved, and only for the
     * fields worth keeping. Storing whole documents here would double the
     * storage of the busiest collections and put a patient's details in a
     * second place that has to be redacted if they ever ask.
     */
    changes: { type: mongoose.Schema.Types.Mixed, default: null },
    note: { type: String, default: "", trim: true, maxlength: 500 },

    ip: { type: String, default: "", trim: true, maxlength: 60 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/* The three ways it is ever read: a tenant's recent activity, one clinic's, and
 * the history of one particular invoice or patient. */
auditSchema.index({ tenantId: 1, createdAt: -1 });
auditSchema.index({ tenantId: 1, clinicId: 1, createdAt: -1 });
auditSchema.index({ entityId: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditSchema);
