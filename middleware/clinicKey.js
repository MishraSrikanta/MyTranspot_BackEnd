const crypto = require("crypto");

const { errors, sendError } = require("../utils/apiError");

/*
 * The whole authentication layer for the clinic sync API, in one file.
 *
 * ================= why an API key and not a session =================
 *
 * The thing calling these endpoints is not a person. It is one installation of
 * the clinic app talking to its own booking endpoint, frequently unattended —
 * publishing next fortnight's slots at three in the morning, or pulling
 * bookings while the receptionist is with a patient. A session that expires
 * would mean a sync that silently stops until somebody notices, which for a
 * booking feed means appointments nobody at the clinic has seen.
 *
 * So: a long-lived key, held by the app next to its file handle, rotatable when
 * it leaks. That replaces the entire login/logout/session/JWT/permission layer
 * — none of which has any endpoints on this side of the product.
 *
 * ================= the isolation property =================
 *
 * A key resolves to exactly ONE clinic, and every query downstream is built
 * from `req.clinic._id`. There is no cross-clinic read on this API — not as a
 * permission check that could be forgotten on a new route, but because there is
 * no code path that could express one. A clinicId in a body or a query string
 * is never consulted.
 */

const Clinic = require("../modules/clinic/models/Clinic");

const HEADER = "x-clinic-key";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/*
 * Compare two secrets without leaking their similarity through how long the
 * comparison took.
 *
 * The lookup below is by hash, so this is belt and braces rather than the main
 * defence — but the habit is worth keeping, and `===` on a credential is the
 * kind of thing that is correct here and copied somewhere it is not.
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function requireClinicKey(req, res, next) {
  try {
    const raw = String(req.headers[HEADER] || "").trim();
    if (!raw) {
      throw errors.unauthenticated("This request needs a clinic key.");
    }

    /*
     * Looked up BY HASH, so the plaintext is never compared against anything
     * stored and never has to be. The unique index on apiKeyHash makes this a
     * single index hit on every sync request, which matters because the app
     * polls the status endpoint continuously.
     */
    const clinic = await Clinic.findOne({ apiKeyHash: sha256(raw) });

    /*
     * A wrong key and an unknown key get the same answer, with no hint about
     * whether the clinic exists. The same reasoning as badCredentials: an API
     * that distinguishes them is an API that can be used to enumerate
     * customers.
     */
    if (!clinic || !clinic.apiKeyHash || !safeEqual(sha256(raw), clinic.apiKeyHash)) {
      throw errors.unauthenticated("That clinic key is not valid.");
    }

    if (!clinic.isActive) {
      throw errors.forbidden("This clinic has been deactivated. Please contact support.");
    }

    req.clinic = clinic;
    req.clinicId = clinic._id;
    return next();
  } catch (err) {
    return sendError(res, err);
  }
}

/*
 * The administration endpoints — creating a clinic and rotating its key.
 *
 * A shared secret in a header, and that is the right size of mechanism for
 * something used a handful of times per customer by the person who runs the
 * deployment. It is guarded twice: the secret must match, and app.js keeps the
 * surface mounted so a missing deployment secret is reported as configuration
 * failure rather than a misleading route 404.
 *
 * The unset case is refused rather than allowed. An admin API that opens itself
 * when a variable is missing is an admin API that is wide open on the first
 * deployment where somebody forgets one — and creating clinics and minting keys
 * is not a thing to leave to a default.
 */
function requireAdminSecret(req, res, next) {
  const expected = process.env.ADMIN_SECRET || "";
  const supplied = String(req.headers["x-admin-secret"] || "").trim();

  if (!expected) {
    return sendError(
      res,
      errors.serviceUnavailable("The admin API is not configured on this deployment.")
    );
  }
  if (!supplied || !safeEqual(sha256(supplied), sha256(expected))) {
    return sendError(res, errors.unauthenticated("That admin secret is not valid."));
  }
  return next();
}

/*
 * The cron endpoint's guard.
 *
 * A public cron URL is a public "expire everything" button: anyone who finds it
 * can age out a clinic's whole day of slots. Vercel sends the secret as a
 * bearer token; a plain header is accepted too so the job can be driven by an
 * ordinary scheduler.
 */
function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET || "";
  const header = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  const supplied = String(
    req.headers["x-cron-secret"] || (bearer ? bearer[1] : "")
  ).trim();

  if (!expected) {
    return sendError(res, errors.notFound());
  }
  if (!supplied || !safeEqual(sha256(supplied), sha256(expected))) {
    return sendError(res, errors.unauthenticated("That cron secret is not valid."));
  }
  return next();
}

module.exports = { requireClinicKey, requireAdminSecret, requireCronSecret, sha256 };
