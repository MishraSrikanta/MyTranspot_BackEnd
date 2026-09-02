const Account = require("../models/Account");
const Company = require("../models/Company");
const { errors, sendError } = require("../utils/apiError");
const { verifyToken, AUDIENCE_APP } = require("../utils/auth");
const { hasPermission, isDriverAccount } = require("../utils/permissions");

/*
 * Authentication and tenancy — the two things every route in this API depends
 * on and neither of which a route is allowed to work out for itself.
 *
 * On success the request carries:
 *   req.account    the Account document
 *   req.company    the Company document (the tenant)
 *   req.companyId  the ObjectId every single query in the system is scoped by
 *
 * The companyId is taken from the ACCOUNT, never from the request. Not from a
 * header, not from a path segment, not from a body field. That single rule is
 * the whole of the isolation guarantee: there is no value a client can send
 * that changes which company's data it reads.
 */

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) throw errors.unauthenticated("You need to sign in first.");

    let payload;
    try {
      payload = verifyToken(match[1]);
    } catch (err) {
      /* An expired token and a forged one get the same answer. Telling a caller
       * which is which is free reconnaissance. */
      throw errors.unauthenticated();
    }

    const account = await Account.findById(payload.id);
    if (!account || account.isActive === false) throw errors.unauthenticated();

    /*
     * The token says which company it was issued for. If that no longer matches
     * the account, something has changed underneath the session — or the token
     * has been tampered with — and the safe answer is to end it rather than to
     * guess which of the two is right.
     */
    if (payload.cid && String(account.companyId) !== String(payload.cid)) {
      throw errors.unauthenticated();
    }

    const company = await Company.findById(account.companyId);
    if (!company) throw errors.unauthenticated();
    if (!company.isActive) {
      throw errors.forbidden("This account has been suspended. Please contact support.");
    }

    req.account = account;
    req.company = company;
    req.companyId = account.companyId;
    /* Which app the token was minted for — the driver phone or the web console.
     * Used by requireDriverApp below. */
    req.audience = payload.aud;

    return next();
  } catch (err) {
    return sendError(res, err);
  }
}

/*
 * The one permission check.
 *
 * Applied per route rather than per router, because the split that matters is
 * usually inside a resource and not between resources: reading a trip and
 * repricing it are the same URL prefix and very different privileges.
 */
function requirePermission(permission) {
  return function check(req, res, next) {
    if (!req.account) return sendError(res, errors.unauthenticated());
    if (hasPermission(req.account, permission)) return next();
    return sendError(res, errors.permissionDenied(permission));
  };
}

/* Any one of several — for a route that several roles reach by different
 * paths, such as a trip list that both the accountant and the dispatcher open. */
function requireAnyPermission(...permissions) {
  return function check(req, res, next) {
    if (!req.account) return sendError(res, errors.unauthenticated());
    if (permissions.some((p) => hasPermission(req.account, p))) return next();
    return sendError(res, errors.permissionDenied(permissions[0]));
  };
}

/*
 * Owner-only. Reserved for the few actions where "the owner said so" is the
 * whole authorisation: changing the subscription, and deleting things that
 * carry financial history.
 */
function requireOwner(req, res, next) {
  if (!req.account) return sendError(res, errors.unauthenticated());
  if (req.account.role === "owner") return next();
  return sendError(res, errors.forbidden("Only the account owner can do that."));
}

/*
 * The driver-app endpoints — posting locations and adding expenses from the
 * roadside.
 *
 * Two conditions, and both are needed. The token must have been minted for the
 * phone app, and the account must be linked to a driver record. The first stops
 * a 90-day handset token being used to open the office console; the second is
 * what lets the tracking routes work out which lorry is reporting without
 * trusting a vehicle id sent in the body.
 */
function requireDriverApp(req, res, next) {
  if (!req.account) return sendError(res, errors.unauthenticated());
  if (req.audience !== AUDIENCE_APP) {
    return sendError(res, errors.forbidden("This endpoint is for the driver app."));
  }
  if (!req.account.driverId) {
    return sendError(
      res,
      errors.forbidden("This login is not linked to a driver record.")
    );
  }
  return next();
}

/*
 * Gate for paid features. Deliberately NOT applied to the tracking endpoints or
 * to reading existing data.
 *
 * A lapsed subscription must never strand a lorry mid-trip: the phone goes on
 * reporting, the trip goes on recording, and the owner sees a renewal prompt
 * rather than a wall. What it does block is starting new work — because that is
 * a decision the owner can make in the office, at a moment when losing the
 * argument costs nothing.
 */
function requireActiveSubscription(req, res, next) {
  if (!req.company) return sendError(res, errors.unauthenticated());
  if (req.company.subscriptionIsActive()) return next();
  return sendError(res, errors.subscriptionExpired());
}

/*
 * The gate on the driver's own module.
 *
 * Deliberately NOT `requireDriverApp`. That one is confined to the phone's
 * 90-day `driver-app` token, which is the right rule for the endpoints the app
 * polls unattended. This is the same person signed into the same account from a
 * browser — a driver with a handset and no app, or one using the web page to
 * send a position — and the data it reaches is only ever their own trips.
 *
 * The requirement is identity: the account must be linked to a driver record.
 * A manager cannot reach these endpoints, which is correct — there is nothing
 * here for them that the office screens do not already show.
 */
function requireDriver(req, res, next) {
  if (!req.account) return sendError(res, errors.unauthenticated());
  if (!req.account.driverId) {
    return sendError(
      res,
      errors.forbidden("This login is not linked to a driver record.")
    );
  }
  return next();
}

/*
 * Keep an office user out of a driver's screens and vice versa.
 *
 * A driver login holds no office permissions (see utils/permissions.js), so
 * every office endpoint would already refuse it on the permission check. This
 * says so in one place and with an answer a person can act on, rather than
 * leaving a driver who opens /trips to collect a generic denial.
 */
function refuseDriverAccounts(req, res, next) {
  if (isDriverAccount(req.account)) {
    return sendError(
      res,
      errors.forbidden("This is a driver login. Use the driver screens.")
    );
  }
  return next();
}

module.exports = {
  requireAuth,
  requirePermission,
  requireAnyPermission,
  requireOwner,
  requireDriverApp,
  requireDriver,
  refuseDriverAccounts,
  requireActiveSubscription,
};
