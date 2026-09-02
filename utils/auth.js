const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { effectivePermissions } = require("./permissions");

/*
 * Tokens and the shapes an account is allowed to leave the server in.
 *
 * Two token lifetimes, because two very different things sign in:
 *
 *   web  — an office user at a desk, 12 hours. Long enough that nobody is
 *          asked for a password in the middle of a working day, short enough
 *          that a browser left open in an internet cafe is not a standing key.
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
 * The token carries the company id as well as the account id. Not because the
 * server trusts it — every request re-reads the account and scopes by the
 * companyId on THAT document — but because it makes a mismatch loud: a token
 * whose company no longer matches its account has been tampered with or the
 * account has been moved, and either way the session should end.
 */
function signToken(account, audience = AUDIENCE_WEB) {
  return jwt.sign(
    {
      id: String(account._id),
      cid: String(account.companyId),
      role: account.role,
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
 */
function serialiseAccount(account) {
  return {
    id: String(account._id),
    companyId: String(account.companyId),
    name: account.name,
    email: account.email,
    phone: account.phone || "",
    role: account.role,
    permissions: effectivePermissions(account),
    driverId: account.driverId ? String(account.driverId) : null,
    isActive: account.isActive !== false,
    lastLoginAt: iso(account.lastLoginAt),
    createdAt: iso(account.createdAt),
  };
}

function serialiseCompany(company) {
  return {
    id: String(company._id),
    name: company.name,
    legalName: company.legalName || "",
    gstin: company.gstin || "",
    phone: company.phone || "",
    email: company.email || "",
    address: company.address || "",
    city: company.city || "",
    state: company.state || "",
    timezone: company.timezone,
    tripPrefix: company.tripPrefix,
    estimatePrefix: company.estimatePrefix,
    tracking: company.trackingConfig(),
    defaults: company.defaults || {},
    subscription: {
      plan: company.subscription?.plan || "trial",
      startedAt: iso(company.subscription?.startedAt),
      expiresAt: iso(company.subscription?.expiresAt),
      isActive: company.subscriptionIsActive(),
      limits: company.limits(),
    },
    createdAt: iso(company.createdAt),
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
  serialiseCompany,
  iso,
};
