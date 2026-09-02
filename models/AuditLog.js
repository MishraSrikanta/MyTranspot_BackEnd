const mongoose = require("mongoose");

/*
 * Who did what. Written for the handful of actions where the answer matters
 * money-wise: approving an expense, changing a trip's price, redrawing a route,
 * closing a trip, granting somebody a permission.
 *
 * Deliberately NOT a log of every write. An audit trail nobody can read is the
 * same as no audit trail, and a table with a row for every field a clerk
 * tabbed through is unreadable within a week. The rule applied throughout the
 * routes is: log it if somebody might one day have to be answerable for it.
 */

const auditSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    /* "expense.approved", "trip.closed", "route.changed", "user.permissions" */
    action: { type: String, required: true, trim: true, maxlength: 60, index: true },

    entityType: { type: String, required: true, trim: true, maxlength: 40 },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    /* The trip number or plate, so the log reads without a join. */
    entityLabel: { type: String, default: "", trim: true, maxlength: 120 },

    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    /* Snapshotted: a dismissed manager's name must stay readable on the eight
     * hundred rows they approved, and their login may be gone. */
    actorName: { type: String, default: "" },
    actorRole: { type: String, default: "" },

    /*
     * Before and after, but only for the fields that changed, and only for the
     * fields worth keeping. Storing whole documents here would double the
     * storage of the busiest collections and put a customer's details in a
     * second place that has to be redacted if they ever ask.
     */
    changes: { type: mongoose.Schema.Types.Mixed, default: null },
    note: { type: String, default: "", trim: true, maxlength: 500 },

    ip: { type: String, default: "", trim: true, maxlength: 60 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/* The two ways it is ever read: a company's recent activity, and the history of
 * one particular trip or expense. */
auditSchema.index({ companyId: 1, createdAt: -1 });
auditSchema.index({ entityId: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditSchema);
