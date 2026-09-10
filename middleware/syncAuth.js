const mongoose = require("mongoose");

const { errors, sendError } = require("../utils/apiError");
const { requireClinicKey } = require("./clinicKey");
const { requireAuth } = require("./auth");
const { hasPermission } = require("../modules/clinic/permissions");

/*
 * The sync endpoints accept two very different credentials, and this decides
 * which one is in play.
 *
 * ================= why both exist =================
 *
 *   X-Clinic-Key   an INSTALLATION, unattended. A reception PC publishing next
 *                  fortnight's grid at three in the morning with nobody logged
 *                  in. A session would have expired hours earlier, and a sync
 *                  that silently stops until somebody notices means slots that
 *                  never reach the web.
 *
 *   Bearer <jwt>   a PERSON, in the console, pressing Publish. v3 needs this
 *                  because the owner builds the grid on screen and expects it
 *                  to be live before they close the laptop — not at whenever
 *                  the unattended job next runs.
 *
 * ================= the rule both paths obey =================
 *
 * The clinic is RESOLVED, never accepted. A key resolves to exactly one clinic.
 * A session resolves through the account's own grants. Neither reads a clinicId
 * out of the request body, and a session naming a clinic it was not granted
 * gets a 404 — not a 403, which would confirm the clinic exists.
 */

const modelOf = (name) => mongoose.model(name);

function resolveSyncClinic(req, res, next) {
  const hasKey = !!String(req.headers["x-clinic-key"] || "").trim();
  const hasBearer = /^Bearer\s+/i.test(String(req.headers.authorization || "").trim());

  /*
   * The key wins when both are present.
   *
   * That is the conservative choice: an unattended publisher that has somehow
   * also acquired a session header should behave as the installation it is,
   * with the narrow single-clinic scope that implies, rather than inheriting
   * whatever breadth a person's account happens to have.
   */
  if (hasKey) return requireClinicKey(req, res, next);

  if (!hasBearer) {
    return sendError(
      res,
      errors.unauthenticated("This request needs a clinic key or a signed-in session.")
    );
  }

  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return resolveFromSession(req, res, next);
  });
}

/*
 * A signed-in person publishing to one clinic.
 *
 * Which clinic is a question the owner has to answer, because an owner has
 * several and "publish the grid" is meaningless across all of them at once. A
 * clinic login is pinned and does not get asked.
 */
async function resolveFromSession(req, res, next) {
  try {
    if (req.module !== "clinic") {
      throw errors.forbidden("This login is for a different product.");
    }
    /* Publishing the grid IS managing slots. Checked here rather than per route
     * so a new sync endpoint cannot be added without a permission by accident. */
    if (!hasPermission(req.account, "slots.manage")) {
      throw errors.permissionDenied("slots.manage");
    }

    const account = req.account;

    /*
     * A pinned account ignores a clinicId in the query — not honours it, and
     * deliberately not an error either. The frontend appends the scope to every
     * request, so refusing it would produce an error on every publish for a
     * parameter the user never chose to send.
     */
    let clinicId = account.clinicId;

    if (!clinicId) {
      const requested = String(req.query.clinicId || req.headers["x-clinic-id"] || "").trim();
      if (!requested || requested === "all") {
        /*
         * An owner must name the branch. The frontend renders an inline clinic
         * picker on CLINIC_REQUIRED and resubmits, so this is a supported
         * answer rather than a failure — and publishing a grid to a guessed
         * clinic would put one branch's hours on another's public page.
         */
        throw errors.clinicRequired("Pick a single clinic before publishing slots.");
      }
      if (!/^[0-9a-fA-F]{24}$/.test(requested)) throw errors.clinicNotFound();
      clinicId = requested;
    }

    /*
     * Owned AND granted. The ownerId match is what stops one practice
     * publishing into another's clinic; mayUseClinic is what stops a
     * receptionist publishing into a branch they were not given.
     */
    const clinic = await modelOf("Clinic").findOne({
      _id: clinicId,
      ownerId: account.ownerId,
      isActive: true,
    });
    if (!clinic) throw errors.clinicNotFound();
    if (!account.mayUseClinic(clinic._id)) throw errors.clinicNotFound();

    req.clinic = clinic;
    req.clinicId = clinic._id;
    return next();
  } catch (err) {
    return sendError(res, err);
  }
}

module.exports = { resolveSyncClinic };
