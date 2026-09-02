const mongoose = require("mongoose");

const { ROLES, presetFor } = require("../utils/permissions");

/*
 * A login. One owner per company plus however many sub-accounts the plan
 * allows, and — from the second version — the drivers themselves, who sign in
 * to the phone app that reports the lorry's position.
 *
 * Drivers are a login here and a Driver record over in models/Driver.js. That
 * split is deliberate: a driver is an employee with a fee, a licence and a trip
 * history whether or not they ever hold a phone, and plenty never will. Tying
 * the employee record to the existence of a password would mean inventing
 * fake accounts for the drivers who only ever appear on paper.
 */

const accountSchema = new mongoose.Schema(
  {
    /*
     * The tenant. Present on every collection in the system and on the index of
     * every query — this field is the whole of the isolation guarantee.
     */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 80 },
    /*
     * Unique across the platform, not per company. One address is one person:
     * letting the same email exist in two companies makes "which company am I
     * signing in to?" a question the login form has to ask, and password resets
     * ambiguous.
     */
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, default: "", trim: true, maxlength: 20 },

    /*
     * A label, not the authorisation. What the user may actually do is the
     * `permissions` array below; the role only decides what that array starts
     * as. See utils/permissions.js for why.
     *
     * The one exception is "owner", which short-circuits every check — an owner
     * cannot lock themselves out of their own company with a bad tick box.
     */
    role: { type: String, enum: ROLES, default: "operations", index: true },

    permissions: { type: [String], default: [] },

    /*
     * Set on a login that belongs to a driver, pointing at their employee
     * record. The tracking endpoints use it to know which lorry the phone is
     * reporting for, so a driver phone cannot post a position against somebody
     * else's trip.
     */
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      default: null,
      index: true,
    },

    /* bcrypt hash. Never selected by default, so it cannot leak by accident. */
    password: { type: String, required: true, select: false },

    /*
     * Suspending rather than deleting. A dismissed manager's name has to stay
     * readable on the eight hundred expense rows they approved, and deleting
     * the row would leave those entries attributed to nobody.
     */
    isActive: { type: Boolean, default: true, index: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* Every listing screen is "this company's users, newest first". */
accountSchema.index({ companyId: 1, createdAt: -1 });

accountSchema.methods.isOwner = function isOwner() {
  return this.role === "owner";
};

/* Fill the permission list from the role preset when none was chosen. A user
 * saved with an explicitly empty list keeps it — that is a suspension by
 * another name, and silently re-granting the preset would undo it. */
accountSchema.pre("save", function applyPreset() {
  if (this.isNew && (!this.permissions || this.permissions.length === 0)) {
    this.permissions = presetFor(this.role);
  }
});

module.exports = mongoose.model("Account", accountSchema);
