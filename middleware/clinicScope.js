const mongoose = require("mongoose");

const { errors, sendError } = require("../utils/apiError");
const { hasPermission } = require("../modules/clinic/permissions");

/*
 * Which clinic is this request about?
 *
 * ================= the one genuinely new authorisation concept =================
 *
 * It exists because an owner reads ACROSS branches while a staff member cannot
 * read outside their own. Everything else in this backend answers "which
 * tenant?" once, from the account, and is done. Here there are two levels and
 * the second one is a choice the caller makes — so it has to be a choice the
 * server validates rather than honours.
 *
 * Runs after requireAuth on every clinic-scoped router and leaves behind:
 *
 *   req.ownerId      the practice. Never from the request.
 *   req.clinicId     the single branch, or null when reading consolidated
 *   req.clinicIds    the list every query filters by
 *   req.isAllClinics whether this is the consolidated view
 *
 * Every clinic query is then
 *   { ownerId: req.ownerId, clinicId: { $in: req.clinicIds } }
 * and no route reads a clinicId out of the request itself.
 *
 * ================= 404, never 403 =================
 *
 * A clinic that does not exist and one belonging to another practice get the
 * same answer. A 403 confirms the id is real, which is how one practice walks
 * the id space and learns how many branches a competitor runs. The frontend
 * also treats 401 as "session over" and returns to sign-in, so a wrong clinic
 * must never be a 401 either.
 */

const modelOf = (name) => mongoose.model(name);

async function resolveClinicScope(req, res, next) {
  try {
    if (!req.account || req.module !== "clinic") throw errors.unauthenticated();

    const account = req.account;
    req.ownerId = account.ownerId;

    /* Every branch of this practice, as the universe the request lives in. */
    const owned = await modelOf("Clinic")
      .find({ ownerId: account.ownerId, isActive: true })
      .select("_id");
    const ownedIds = owned.map((c) => c._id);

    /*
     * What the account is ALLOWED to see, before the request narrows it.
     *
     * An owner's empty `clinicIds` means every branch, not none — the single
     * most important line in this file to get right, because reading it the
     * other way locks an owner out of their own practice with an empty screen
     * and no error to explain it.
     */
    const permitted =
      account.role === "owner" || !account.clinicIds || account.clinicIds.length === 0
        ? ownedIds
        : ownedIds.filter((id) => account.mayUseClinic(id));

    /*
     * A staff account whose grants have all been revoked or deactivated. Told
     * plainly rather than served an empty diary, because "no appointments
     * today" and "you have access to nothing" look identical on screen and
     * reliably become a support call.
     */
    if (account.role !== "owner" && permitted.length === 0) {
      throw errors.forbidden(
        "This login is not linked to any clinic. Ask the practice owner to grant one."
      );
    }

    const requested = String(
      req.query.clinicId || req.headers["x-clinic-id"] || ""
    ).trim();

    /*
     * "all" and an absent value are the same request — read everything I may
     * see. The frontend appends the scope to every call including writes, so
     * "all" arrives constantly; requireSingleClinic below is what refuses it
     * where a single branch is needed.
     */
    if (!requested || requested === "all") {
      /*
       * A staff account with exactly one permitted clinic is NOT reading
       * consolidated — it is reading its own branch, and treating it as an
       * "all clinics" view would let a write through that should have been
       * refused. One clinic is one clinic.
       */
      const single = permitted.length === 1 ? permitted[0] : null;
      req.clinicId = single;
      req.clinicIds = permitted;
      req.isAllClinics = !single;
      return next();
    }

    if (!/^[0-9a-fA-F]{24}$/.test(requested)) throw errors.clinicNotFound();

    const found = permitted.find((id) => String(id) === requested);
    if (!found) throw errors.clinicNotFound();

    req.clinicId = found;
    req.clinicIds = [found];
    req.isAllClinics = false;
    return next();
  } catch (err) {
    return sendError(res, err);
  }
}

/*
 * Writes need one branch.
 *
 * You cannot book an appointment into "all clinics", and picking the first on
 * the owner's behalf is how a patient ends up in a diary forty kilometres from
 * the clinic they telephoned.
 *
 * The CLINIC_REQUIRED code is part of the contract rather than an error: the
 * frontend renders an inline clinic picker on it and resubmits, so the user
 * never loses the form they filled in.
 */
function requireSingleClinic(req, res, next) {
  if (!req.clinicId) return sendError(res, errors.clinicRequired());
  return next();
}

/*
 * The clinic module's permission gate.
 *
 * Separate from middleware/auth.js's `requirePermission`, which dispatches on
 * the account's module — this one is bound to the clinic catalogue, so a route
 * under modules/clinic cannot accidentally be guarded by a transport
 * permission that would silently never match.
 */
function requireClinicPermission(permission) {
  return function check(req, res, next) {
    if (!req.account) return sendError(res, errors.unauthenticated());
    if (hasPermission(req.account, permission)) return next();
    return sendError(res, errors.permissionDenied(permission));
  };
}

/* Owner-only, for the few actions where "the owner said so" is the whole
 * authorisation: creating a clinic, granting staff, purging finished days. */
function requireClinicOwner(req, res, next) {
  if (!req.account) return sendError(res, errors.unauthenticated());
  if (req.account.role === "owner") return next();
  return sendError(res, errors.forbidden("Only the practice owner can do that."));
}

module.exports = {
  resolveClinicScope,
  requireSingleClinic,
  requireClinicPermission,
  requireClinicOwner,
};
