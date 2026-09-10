const mongoose = require("mongoose");

const Account = require("../models/Account");
const { errors, sendError } = require("../utils/apiError");
const { verifyToken, AUDIENCE_APP } = require("../utils/auth");
const { hasPermission, moduleOf } = require("../utils/permissions");

/*
 * Authentication and tenancy for the signed-in surfaces — which, since the
 * clinic module went offline-first, means MyTransport plus the small optional
 * owner page on the clinic side.
 *
 * The clinic SYNC and PUBLIC routes do not come through here at all. Sync
 * authenticates with an API key (middleware/clinicKey.js) and the public
 * booking pages have no credential by design.
 *
 * On success the request carries:
 *   req.account    the Account document
 *   req.module     "transport" | "clinic"
 *   req.audience   which console the token was minted for
 *   req.company    the Company document, for a transport account
 *   req.companyId  the id every transport query is scoped by
 *   req.clinic     the Clinic document, for a clinic owner account
 *
 * ================= the rule that is the whole isolation guarantee =================
 *
 * The tenant id is taken from the ACCOUNT, never from the request. Not from a
 * header, not from a path segment, not from a body field. There is no value a
 * client can send that changes which company's data it reads.
 */

/*
 * Tenant models are resolved lazily rather than required at the top.
 *
 * Requiring them here would make this shared file import both products' models
 * on every cold start, and would create a cycle the day a model needs a helper
 * that needs this middleware. `mongoose.model(name)` reads the
 * already-registered model instead, which app.js guarantees has happened.
 */
const modelOf = (name) => mongoose.model(name);

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
     * ================= revocation =================
     *
     * The only way this system can take a token back. A token signed before the
     * account's counter was last incremented — by a password change or a
     * suspension — is refused here.
     *
     * A token with no `tv` at all predates the counter and is let through:
     * those are the driver handsets already in the field, and refusing them
     * would sign out every driver the moment this deploys. They expire on their
     * own within 90 days, after which this branch stops mattering.
     */
    if (payload.tv !== undefined && payload.tv !== (account.tokenVersion || 0)) {
      throw errors.unauthenticated();
    }

    const module = moduleOf(account);
    /*
     * The token says which product it was issued for. A mismatch means the
     * token was minted against a different account state, and the safe answer
     * is to end the session rather than serve the wrong module's data.
     */
    if (payload.mod && payload.mod !== module) throw errors.unauthenticated();

    req.account = account;
    req.module = module;
    /* Which app the token was minted for — the driver phone or a web console.
     * Used by requireDriverApp below. */
    req.audience = payload.aud;

    if (module === "clinic") {
      /*
       * The clinic console. The tenant is the PRACTICE, not a branch — a staff
       * member's pinned clinic can be changed by the owner, and that is not a
       * reason to end their session mid-morning.
       */
      if (payload.cid && String(account.ownerId) !== String(payload.cid)) {
        throw errors.unauthenticated();
      }

      const owner = await modelOf("Owner").findById(account.ownerId);
      if (!owner) throw errors.unauthenticated();
      if (!owner.isActive) {
        throw errors.forbidden("This account has been suspended. Please contact support.");
      }

      req.owner = owner;
      req.ownerId = owner._id;

      /*
       * The default pin, loaded for convenience. Null for an owner, who is
       * pinned to no branch — and NOT an error: which clinic a request is about
       * is decided by resolveClinicScope, not here.
       */
      req.clinic = null;
      if (account.clinicId) {
        const clinic = await modelOf("Clinic").findById(account.clinicId);
        /* A deactivated default is survivable: the account may still hold other
         * grants, and refusing the login would strand somebody over a branch
         * they were not asking for. */
        if (clinic && clinic.isActive) req.clinic = clinic;
      }
    } else {
      /*
       * The token says which company it was issued for. If that no longer
       * matches the account, something has changed underneath the session — or
       * the token has been tampered with — and the safe answer is to end it
       * rather than to guess which of the two is right.
       */
      if (payload.cid && String(account.companyId) !== String(payload.cid)) {
        throw errors.unauthenticated();
      }
      const company = await modelOf("Company").findById(account.companyId);
      if (!company) throw errors.unauthenticated();
      if (!company.isActive) {
        throw errors.forbidden("This account has been suspended. Please contact support.");
      }
      req.company = company;
      req.companyId = account.companyId;
    }

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
 * ================= the module gate, applied at the MOUNT =================
 *
 * A guard that runs BEFORE a router's own requireAuth, so it can be attached in
 * app.js without every route file having to remember it.
 *
 * ================= why this exists =================
 *
 * It closes a real cross-module leak. A clinic account reaching a transport
 * route passed every check the transport module makes:
 *
 *   - requireAuth succeeded, because the account is valid;
 *   - requirePermission succeeded, because a clinic OWNER short-circuits every
 *     permission check by design;
 *   - and the route then queried `{ companyId: req.companyId }` with
 *     `req.companyId` undefined — which Mongoose STRIPS from the filter rather
 *     than matching nothing.
 *
 * The result was an unscoped query returning every company's trips. Three
 * individually reasonable behaviours composing into a tenant leak, which is
 * how they usually happen.
 *
 * Reading the signed `mod` claim is enough here and costs no database round
 * trip: the claim is only trusted for ROUTING, and the router's own requireAuth
 * re-reads the account and refuses any token whose claim disagrees with it.
 */
function assertTokenModule(module) {
  return function guard(req, res, next) {
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || "").trim());
    /* No token at all is the router's business — it has a better message, and
     * refusing here would answer "wrong product" to somebody who is simply not
     * signed in. */
    if (!match) return next();

    let payload;
    try {
      payload = verifyToken(match[1]);
    } catch (err) {
      return next();
    }

    /* A token with no `mod` predates the two-product split, and every account
     * that existed then is a transport account. */
    const claimed = payload.mod || "transport";
    if (claimed !== module) {
      return sendError(res, errors.forbidden("This login is for a different product."));
    }
    return next();
  };
}

/*
 * Keep one product's token out of the other's routes.
 *
 * Belt and braces: the routers are mounted separately and every query is scoped
 * by a tenant id the other module's accounts do not have, so a transport token
 * reaching a clinic route would find nothing rather than somebody else's data.
 * This says so in one place, and turns a confusing empty screen into an answer.
 */
function requireModule(module) {
  return function check(req, res, next) {
    if (!req.account) return sendError(res, errors.unauthenticated());
    if (req.module !== module) {
      return sendError(res, errors.forbidden("This login is for a different product."));
    }
    return next();
  };
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
 * The gate on the driver's own module.
 *
 * Deliberately NOT requireDriverApp. That one is confined to the phone's 90-day
 * token, which is the right rule for the endpoints the app polls unattended.
 * This is the same person signed into the same account from a browser — a
 * driver with a handset and no app — and the data it reaches is only ever their
 * own trips.
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
 * Keep an office user out of a driver's screens and vice versa. A driver login
 * holds no office permission, so every office endpoint would already refuse it
 * — this says so with an answer a person can act on.
 */
function refuseDriverAccounts(req, res, next) {
  const account = req.account;
  if (account && (account.role === "driver" || account.driverId)) {
    return sendError(
      res,
      errors.forbidden("This is a driver login. Use the driver screens.")
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

module.exports = {
  requireAuth,
  assertTokenModule,
  requirePermission,
  requireAnyPermission,
  requireOwner,
  requireModule,
  requireDriverApp,
  requireDriver,
  refuseDriverAccounts,
  requireActiveSubscription,
};
