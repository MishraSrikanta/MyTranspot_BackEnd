const express = require("express");
const Account = require("../models/Account");
const Company = require("../models/Company");
const Driver = require("../models/Driver");
const { errors, handler } = require("../utils/apiError");
const {
  hashPassword,
  verifyPassword,
  signToken,
  serialiseAccount,
  serialiseCompany,
  AUDIENCE_WEB,
  AUDIENCE_APP,
} = require("../utils/auth");
const {
  parseEmail,
  parsePassword,
  parseText,
  parseOptionalText,
  parsePhone,
} = require("../utils/validate");
const { requireAuth } = require("../middleware/auth");
const { loginRateLimit } = require("../middleware/rateLimit");

const router = express.Router();

/* ================= POST /api/v1/auth/register =================
 * Public signup. Creates a company and its owner in one step.
 *
 * Both, together, or neither — a company with no owner is unreachable and a
 * user with no company cannot be scoped by anything. If the account write
 * fails, the company created a moment earlier is removed rather than left as an
 * orphan that the next signup with the same name will collide with.
 *
 * Nothing here reads `role` or `permissions` from the body. This endpoint is on
 * the open internet: a signup that honoured a role field would mean anyone
 * could ask to be created as somebody else's owner.
 */

router.post(
  "/register",
  handler(async (req, res) => {
    const companyName = parseText(req.body.companyName, "companyName", {
      max: 120,
      label: "Company name",
    });
    const name = parseText(req.body.name, "name", { max: 80, label: "Your name" });
    const email = parseEmail(req.body.email);
    const password = parsePassword(req.body.password);
    const phone = parsePhone(req.body.phone);

    /* Checked before the company is created, so the common case — somebody
     * signing up twice — does not leave a stray company behind. */
    const taken = await Account.findOne({ email }).select("_id");
    if (taken) throw errors.emailTaken();

    const company = await Company.create({
      name: companyName,
      phone,
      email,
      city: parseOptionalText(req.body.city, "city", 80),
      state: parseOptionalText(req.body.state, "state", 80),
    });

    let account;
    try {
      account = await Account.create({
        companyId: company._id,
        name,
        email,
        phone,
        role: "owner",
        password: await hashPassword(password),
      });
    } catch (err) {
      await Company.deleteOne({ _id: company._id });
      /* A duplicate here means two signups raced past the check above. It is
       * the same situation the user asked about, so it gets the same answer. */
      if (err.code === 11000) throw errors.emailTaken();
      throw err;
    }

    return res.status(201).json({
      token: signToken(account, AUDIENCE_WEB),
      account: serialiseAccount(account),
      company: serialiseCompany(company),
    });
  })
);

/* ================= POST /api/v1/auth/login =================
 * The office web console.
 */
router.post(
  "/login",
  loginRateLimit,
  handler(async (req, res) => {
    const email = parseEmail(req.body.email);
    const password = String(req.body.password ?? "");

    /* `password` is select:false on the schema, so it has to be asked for. */
    const account = await Account.findOne({ email }).select("+password");
    /*
     * One answer for an unknown email and for a wrong password. Anything else
     * turns this endpoint into a way of discovering which addresses are
     * registered — and in this market, that is a competitor's customer list.
     */
    if (!account) throw errors.badCredentials();
    if (!(await verifyPassword(password, account.password))) throw errors.badCredentials();
    if (account.isActive === false) {
      throw errors.forbidden("This login has been suspended. Ask your owner to re-enable it.");
    }

    const company = await Company.findById(account.companyId);
    if (!company || !company.isActive) {
      throw errors.forbidden("This company account is not active.");
    }

    account.lastLoginAt = new Date();
    await account.save();

    return res.json({
      token: signToken(account, AUDIENCE_WEB),
      account: serialiseAccount(account),
      company: serialiseCompany(company),
      /*
       * The tracking configuration comes back with the login so the console has
       * it before the map is opened, and so an owner never sees an interval on
       * screen that disagrees with what the phones are actually doing.
       */
      tracking: company.trackingConfig(),
    });
  })
);

/* ================= POST /api/v1/auth/driver-login =================
 * The phone in the cab.
 *
 * A separate endpoint from /login, and a separate token audience, for one
 * reason: the token it issues lasts 90 days. A handset in a lorry is signed in
 * once and used for months, often with no signal to re-authenticate against —
 * but a 90-day token that also opened the office console would be a serious
 * liability sitting in a jacket pocket. Minting it with `aud: driver-app`
 * confines it to the endpoints a driver actually needs.
 */
router.post(
  "/driver-login",
  loginRateLimit,
  handler(async (req, res) => {
    const email = parseEmail(req.body.email);
    const password = String(req.body.password ?? "");

    const account = await Account.findOne({ email }).select("+password");
    if (!account) throw errors.badCredentials();
    if (!(await verifyPassword(password, account.password))) throw errors.badCredentials();
    if (account.isActive === false) throw errors.forbidden("This login has been suspended.");
    if (!account.driverId) {
      throw errors.forbidden("This login is not linked to a driver record.");
    }

    const [company, driver] = await Promise.all([
      Company.findById(account.companyId),
      Driver.findById(account.driverId),
    ]);
    if (!company || !company.isActive) {
      throw errors.forbidden("This company account is not active.");
    }

    account.lastLoginAt = new Date();
    await account.save();

    return res.json({
      token: signToken(account, AUDIENCE_APP),
      account: serialiseAccount(account),
      driver: driver
        ? {
            id: String(driver._id),
            name: driver.name,
            phone: driver.phone,
            status: driver.status,
            currentTripId: driver.currentTripId ? String(driver.currentTripId) : null,
          }
        : null,
      /*
       * The phone is told how often to report at the moment it signs in, and
       * again on every upload. It never hard-codes an interval, which is what
       * makes the owner's setting the only place the number lives.
       */
      tracking: company.trackingConfig(),
    });
  })
);

/* ================= GET /api/v1/auth/me =================
 * Who am I, what may I do, and what company am I in. The console calls this on
 * every load and builds its entire menu from `account.permissions`.
 */
router.get(
  "/me",
  requireAuth,
  handler(async (req, res) =>
    res.json({
      account: serialiseAccount(req.account),
      company: serialiseCompany(req.company),
      tracking: req.company.trackingConfig(),
    })
  )
);

/* ================= POST /api/v1/auth/change-password ================= */
router.post(
  "/change-password",
  requireAuth,
  handler(async (req, res) => {
    const currentPassword = String(req.body.currentPassword ?? "");
    const newPassword = parsePassword(req.body.newPassword, "newPassword");

    /*
     * The current password is required even though the caller is already
     * authenticated. The session may be an unattended browser in a shared
     * office, and without this check walking past one is enough to take the
     * account.
     */
    const account = await Account.findById(req.account._id).select("+password");
    if (!(await verifyPassword(currentPassword, account.password))) {
      throw errors.validation("Your current password is not correct.", {
        currentPassword: "is incorrect",
      });
    }

    account.password = await hashPassword(newPassword);
    await account.save();

    /*
     * A fresh token is returned. The old one stays valid until it expires —
     * this build has no token revocation list, and saying so plainly is better
     * than implying a security property the system does not have.
     */
    return res.json({
      message: "Password changed.",
      token: signToken(account, req.audience || AUDIENCE_WEB),
    });
  })
);

module.exports = router;
