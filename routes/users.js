const express = require("express");

const { errors, sendError } = require("../utils/apiError");
const { verifyToken } = require("../utils/auth");

const transportUsers = require("../modules/transport/routes/users");
const clinicUsers = require("../modules/clinic/routes/users");

/*
 * /api/v1/users belongs to both products, and this decides which one answers.
 *
 * ================= why a dispatcher rather than two paths =================
 *
 * Every other endpoint in this backend is owned by exactly one module —
 * /trips is transport, /appointments is clinic — so mounting them side by side
 * is enough. Staff management is the one genuine collision: both products have
 * users, both frontends call /users, and neither can be moved without breaking
 * a client that already exists.
 *
 * Prefixing the paths (/transport/users, /clinic/users) was the alternative and
 * was rejected: it would mean editing both frontends for a problem the server
 * can answer on its own, since the token already says which product it is for.
 *
 * ================= what this does NOT do =================
 *
 * It does not authenticate. The `mod` claim is read WITHOUT trusting it for
 * anything but routing — the module router it hands off to runs the full
 * requireAuth, re-reads the account, and scopes from that. A forged claim
 * therefore picks the wrong router and is then refused by it, rather than
 * granting anything.
 */

const router = express.Router();

router.use((req, res, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || "").trim());
  if (!match) {
    /* No token at all. Answered here rather than by whichever router happened
     * to be the default, so the message is about signing in and not about a
     * product the caller never mentioned. */
    return sendError(res, errors.unauthenticated("You need to sign in first."));
  }

  let payload;
  try {
    payload = verifyToken(match[1]);
  } catch (err) {
    /* An expired token and a forged one get the same answer here, exactly as
     * they do in requireAuth. */
    return sendError(res, errors.unauthenticated());
  }

  /*
   * A token with no `mod` predates the two-product split, and every account
   * that existed then is a transport account — the same default the permission
   * dispatcher applies. See utils/permissions.js.
   */
  const handler = payload.mod === "clinic" ? clinicUsers : transportUsers;
  return handler(req, res, next);
});

module.exports = router;
