const mongoose = require("mongoose");

const { ALL_ROLES, MODULES, DEFAULT_MODULE, presetFor } = require("../utils/permissions");

/*
 * A login — for either product.
 *
 * ================= one account table, two products =================
 *
 * This backend serves MyTransport and MyClinic from one deployment, and the
 * account table is shared. One email is one person across the platform, one
 * password, one place where "is this login suspended?" is answered.
 *
 * What it does NOT mean is one set of fields. A transport account is scoped by
 * a company and is the whole product's front door: every screen in MyTransport
 * is behind one. A clinic account is a much smaller thing — see below — and
 * `module` says which of the two this row is.
 *
 * ================= how little the clinic side needs =================
 *
 * The clinic product keeps its patients, billing and reports in a workbook on
 * its own machines — but the CONSOLE is a real signed-in application, and the
 * server owns accounts, staff, appointments and the token queue outright.
 *
 * So a clinic account carries a two-level scope: the practice it belongs to
 * (`ownerId`) and the branches it may open (`clinicIds`). The owner has no
 * branch pin at all, which is what lets them read across every clinic they own.
 *
 * The unattended sync — a reception PC publishing slots on a timer with nobody
 * logged in — still authenticates with the clinic's API key instead. Two
 * schemes, because they answer different questions: a key says WHICH
 * INSTALLATION, a session says WHICH PERSON.
 */

const accountSchema = new mongoose.Schema(
  {
    /*
     * Which product this login belongs to. Chosen at registration — the signup
     * form asks before it asks anything else, because the rest of the form
     * differs — and never changed afterwards: a transport account has a company
     * and a fleet behind it, and there is no sensible reading of moving it to a
     * clinic.
     *
     * Defaulted rather than required, because every account that existed before
     * this backend served two products is a transport account and must go on
     * signing in without a migration running first.
     */
    module: {
      type: String,
      enum: MODULES,
      default: DEFAULT_MODULE,
      index: true,
    },

    /* ================= tenancy: transport =================
     * Present on every transport collection and on the index of every transport
     * query — this field is the whole of the isolation guarantee on that side.
     */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },

    /* ================= tenancy: clinic =================
     * The practice. Every clinic-module query is scoped by it, and it is read
     * from the ACCOUNT — never from a header, a path or a body field.
     */
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Owner",
      default: null,
      index: true,
    },

    /*
     * The DEFAULT clinic — what the console pins to on sign-in.
     *
     * Null for an owner, and that null is meaningful rather than missing: an
     * owner is not pinned to a branch, which is what lets them read across all
     * of them. Do not read it as "no access".
     *
     * Kept as its own field rather than "clinicIds[0]" because it is a choice
     * the owner makes when granting the account — the branch this person
     * actually sits at — and an array's order is not a place to store a
     * decision.
     */
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Clinic",
      default: null,
      index: true,
    },

    /*
     * The authoritative set of branches this account may open.
     *
     * Rules the routes enforce, stated here because they are easy to get half
     * right:
     *   - `clinicId` must be a member of this list.
     *   - An OWNER has `clinicId: null` and `clinicIds: []`, and empty means
     *     ALL — not none. Conflating the two locks an owner out of their own
     *     practice.
     *   - A staff account with more than one gets a clinic switcher, limited to
     *     this set.
     *   - A request naming a clinic outside it answers 404, never 403. A 403
     *     confirms the clinic exists, which is how one practice enumerates
     *     another's branches.
     */
    clinicIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Clinic" }],
      default: [],
    },

    name: { type: String, required: true, trim: true, maxlength: 80 },

    /*
     * Unique across the platform, not per tenant. One address is one person:
     * letting the same email exist twice makes "which business am I signing in
     * to?" a question the login form has to ask, and password resets ambiguous.
     */
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    /*
     * The clinic's own login identity — "SUN-01", generated at signup from the
     * clinic's code and returned once so the app can show it.
     *
     * It exists because a reception desk is a shared position rather than a
     * person: the receptionist on this afternoon's shift did not create the
     * account and does not know the email it was made with, but the login ID is
     * printed on the monitor. Sign-in accepts either.
     *
     * No default, deliberately. A sparse unique index skips only MISSING keys,
     * so an explicit null would make the second account without a login ID
     * collide with the first on a value nobody chose.
     */
    loginId: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 40,
    },

    phone: { type: String, default: "", trim: true, maxlength: 20 },

    /*
     * A label, not the authorisation. What the user may actually do is the
     * `permissions` array below; the role only decides what that array starts
     * as. See utils/permissions.js.
     *
     * The enum is the union of both modules' roles, because one collection
     * cannot have two enums. Which of them are OFFERED at registration is a
     * module question, and is answered by that module's catalogue.
     *
     * The one role with behaviour attached is "owner", which short-circuits
     * every check — an owner cannot lock themselves out with a bad tick box.
     */
    role: { type: String, enum: ALL_ROLES, default: "operations", index: true },

    permissions: { type: [String], default: [] },

    /* Transport: the login belongs to a driver, pointing at their employee
     * record. The tracking endpoints use it to know which lorry is reporting,
     * so a driver phone cannot post a position against somebody else's trip. */
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      default: null,
      index: true,
    },

    /* bcrypt hash. Never selected by default, so it cannot leak by accident. */
    password: { type: String, required: true, select: false },

    /*
     * ================= the logout counter =================
     *
     * A JWT is valid until it expires, and nothing a server does can take one
     * back — which makes "log out" a lie on a shared office PC, where the whole
     * point is that the next person cannot pick up the session.
     *
     * So every token carries the value of this counter at the moment it was
     * signed, and requireAuth refuses a token whose `tv` no longer matches.
     * Incrementing it invalidates every token ever issued for this account, in
     * one write and with no revocation list to store or sweep.
     *
     * Incremented on a password change and on suspension — the two moments
     * where a session that carries on is a session that should not.
     */
    tokenVersion: { type: Number, default: 0 },

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

/* Every listing screen is "this tenant's users, newest first" — once per
 * module, because the two never appear in the same list. */
accountSchema.index({ companyId: 1, createdAt: -1 });
accountSchema.index({ ownerId: 1, createdAt: -1 });
/* Unique across the platform, because it is an identity somebody types into a
 * login form. Sparse, because every transport account has none. */
accountSchema.index({ loginId: 1 }, { unique: true, sparse: true });

/*
 * Mongoose stores an explicit `undefined` as a missing key but an explicit
 * empty string as "". An empty string in a sparse unique index is a VALUE, so
 * the second account created without a login ID would collide with the first.
 * Normalised here so no caller has to remember it.
 */
accountSchema.pre("save", function normaliseLoginId() {
  if (!this.loginId) this.loginId = undefined;
});

accountSchema.methods.isOwner = function isOwner() {
  return this.role === "owner";
};

/*
 * The tenant id, whichever product this is. Used by the shared code — the audit
 * writer, the counter — that has no business knowing which module it serves.
 */
accountSchema.methods.tenantId = function tenantId() {
  return this.module === "clinic" ? this.ownerId : this.companyId;
};

/*
 * Whether this account may act on a given clinic.
 *
 * The owner's empty `clinicIds` means every branch of their practice, so the
 * caller still has to have checked the clinic belongs to `ownerId` — this
 * answers the narrower question of whether the account is restricted further.
 */
accountSchema.methods.mayUseClinic = function mayUseClinic(clinicId) {
  if (this.role === "owner") return true;
  if (!this.clinicIds || this.clinicIds.length === 0) return false;
  return this.clinicIds.some((id) => String(id) === String(clinicId));
};

/*
 * Fill the permission list from the role preset when none was chosen, using the
 * catalogue of THIS account's module — a clinic owner must not be handed a
 * transport preset because both catalogues happen to contain "owner".
 *
 * A user saved with an explicitly empty list keeps it: that is a suspension by
 * another name, and silently re-granting the preset would undo it.
 */
accountSchema.pre("save", function applyPreset() {
  if (this.isNew && (!this.permissions || this.permissions.length === 0)) {
    this.permissions = presetFor(this.module, this.role);
  }
});

module.exports = mongoose.model("Account", accountSchema);
