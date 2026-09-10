const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { effectivePermissions, moduleOf } = require("./permissions");

/*
 * Tokens, and the shapes an account is allowed to leave the server in.
 *
 * ================= who actually signs in =================
 *
 * Almost all of this serves MyTransport, where every screen is behind a login.
 * The clinic module barely uses it: its app authenticates with a long-lived API
 * key (see middleware/clinicKey.js), and the only human sign-in on that side is
 * the optional owner page for looking at today's bookings from a phone.
 *
 * Two token lifetimes, because two very different things sign in:
 *
 *   web  — someone at a desk, 12 hours. Long enough that nobody is asked for a
 *          password in the middle of a working day, short enough that a browser
 *          left open in an internet cafe is not a standing key.
 *   app  — a driver's phone, 90 days. A handset in a lorry cab is signed in
 *          once and used for months, often somewhere with no signal to
 *          re-authenticate against. A short token there means the tracker stops
 *          reporting halfway through a trip, in the one situation where nobody
 *          can do anything about it.
 *
 * The `aud` claim keeps them apart, so a driver's long-lived phone token cannot
 * be lifted off the handset and used to open the office web console.
 */
const WEB_TOKEN_TTL = "12h";
const APP_TOKEN_TTL = "90d";

/*
 * One issuer for the whole deployment, and deliberately NOT renamed to
 * something product-neutral. Changing this string invalidates every token
 * already in the field — including the 90-day ones on driver handsets that will
 * not be re-authenticated for weeks. The name is cosmetic; the outage would not
 * be.
 */
const TOKEN_ISSUER = "mytransport";

const AUDIENCE_WEB = "web";
const AUDIENCE_APP = "driver-app";

const BCRYPT_ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

/*
 * ================= what the token carries, and why =================
 *
 * The tenant id is in the payload and the server does NOT trust it: every
 * request re-reads the account and scopes by the id on THAT document. It is
 * here so a mismatch is loud — a token whose tenant no longer matches its
 * account has been tampered with, or the account has been moved, and either way
 * the session should end rather than be guessed at.
 *
 * `mod` is what keeps one product's token out of the other's routes.
 *
 * `tv` is the one claim that IS trusted, and it is the only revocation this
 * system has. See Account.tokenVersion.
 */
function signToken(account, audience = AUDIENCE_WEB) {
  const module = moduleOf(account);
  return jwt.sign(
    {
      id: String(account._id),
      mod: module,
      /*
       * The tenant: a company for transport, the PRACTICE for clinic.
       *
       * Not the pinned clinic — an owner has none, and a staff member's pin can
       * be changed by the owner without that meaning the session should end.
       * The claim keeps MyTransport's name so tokens already in the field,
       * signed with `cid: companyId`, go on validating.
       */
      cid: String(module === "clinic" ? account.ownerId : account.companyId),
      role: account.role,
      tv: account.tokenVersion || 0,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: audience === AUDIENCE_APP ? APP_TOKEN_TTL : WEB_TOKEN_TTL,
      issuer: TOKEN_ISSUER,
      audience,
    }
  );
}

function verifyToken(raw, audience) {
  return jwt.verify(raw, process.env.JWT_SECRET, {
    issuer: TOKEN_ISSUER,
    /* Undefined means "either" — used by endpoints both a phone and the web
     * console legitimately call, such as adding an expense. */
    ...(audience ? { audience } : {}),
  });
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/*
 * The account as the client sees it. The password hash is never part of this,
 * whatever the caller passes in.
 *
 * `permissions` is the RESOLVED list, not the stored one — an owner gets every
 * permission spelled out rather than an empty array and a special case. The
 * frontend builds its whole menu from this, which means adding a permission on
 * the server makes the section appear without a frontend release.
 *
 * The tenancy field is emitted per module rather than as one merged shape. A
 * clinic page reading `companyId: null` would have to know to ignore it; worse,
 * a field that is always null is a field somebody eventually writes code
 * against.
 */
function serialiseAccount(account) {
  const module = moduleOf(account);

  const base = {
    id: String(account._id),
    module,
    name: account.name,
    email: account.email,
    phone: account.phone || "",
    role: account.role,
    permissions: effectivePermissions(account),
    isActive: account.isActive !== false,
    lastLoginAt: iso(account.lastLoginAt),
    createdAt: iso(account.createdAt),
  };

  if (module === "clinic") {
    return {
      ...base,
      ownerId: account.ownerId ? String(account.ownerId) : null,
      loginId: account.loginId || null,
      /* The default pin — null for an owner, who is pinned to no branch. */
      clinicId: account.clinicId ? String(account.clinicId) : null,
      /*
       * The authoritative set. Empty on an owner means EVERY clinic, not none —
       * see models/Account.js. The frontend reads it the same way.
       */
      clinicIds: (account.clinicIds || []).map(String),
    };
  }

  return {
    ...base,
    companyId: account.companyId ? String(account.companyId) : null,
    driverId: account.driverId ? String(account.driverId) : null,
  };
}

module.exports = {
  WEB_TOKEN_TTL,
  APP_TOKEN_TTL,
  TOKEN_ISSUER,
  AUDIENCE_WEB,
  AUDIENCE_APP,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  serialiseAccount,
  iso,
};
