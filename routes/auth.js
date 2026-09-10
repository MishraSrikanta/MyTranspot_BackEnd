const crypto = require("crypto");
const express = require("express");

const Account = require("../models/Account");
const Company = require("../modules/transport/models/Company");
const Driver = require("../modules/transport/models/Driver");
const Owner = require("../modules/clinic/models/Owner");
const Clinic = require("../modules/clinic/models/Clinic");
const ClinicLicense = require("../modules/clinic/models/ClinicLicense");
const { errors, handler } = require("../utils/apiError");
const {
  hashPassword,
  verifyPassword,
  signToken,
  serialiseAccount,
  AUDIENCE_WEB,
  AUDIENCE_APP,
} = require("../utils/auth");
const { serialiseCompany } = require("../modules/transport/utils/serialise");
const {
  allocateIdentifiers,
  loginIdFor,
  parseClinicInputs,
} = require("../modules/clinic/utils/provision");
const serialise = require("../modules/clinic/utils/serialise");
const {
  MODULES,
  MODULE_LABELS,
  DEFAULT_MODULE,
  permissionsFor,
  rolesFor,
} = require("../utils/permissions");
const {
  parseEmail,
  parsePassword,
  parseText,
  parseOptionalText,
  parsePhone,
  parseEnum,
  parseBoolean,
  isNil,
} = require("../utils/validate");
const { requireAuth } = require("../middleware/auth");
const { loginRateLimit } = require("../middleware/rateLimit");

const router = express.Router();

/*
 * Sign-in, shared by both products.
 *
 * ================= why one auth router and not two =================
 *
 * The account table is shared, so the login form is too: a person types a
 * credential and a password, and the server works out which product they belong
 * to. Two login endpoints would mean the user has to know which one they are —
 * and they would be told they had the wrong password when they had merely
 * opened the wrong page.
 *
 * Registration is the exception and goes the other way: the module is the FIRST
 * thing the form asks, because the rest of it differs completely. A transport
 * signup names a company and creates a fleet; a clinic signup names a clinic,
 * generates its public address and login ID, issues a licence, seeds a
 * catalogue and mints the API key its offline app will use.
 */

/*
 * ================= the developer code =================
 *
 * Signing up for a clinic publishes a bookable page on the open internet and
 * issues a licence. Neither should be creatable by a passing bot, and there is
 * no email verification in this build to stand in the way.
 *
 * Read from the environment so it can be rotated without a deploy, with the
 * agreed value as the fallback. Checked HERE, on the server: the signup form
 * checks it too, but anyone can open the network tab and post the request
 * without the field, so the frontend's check is a courtesy and this one is the
 * control.
 */
const DEVELOPER_CODE = process.env.DEVELOPER_CODE || "Srikanta@123";

/*
 * How many clinics a signup form may create at once.
 *
 * Ten is generous for a practice registering itself, and low enough that a
 * malformed client cannot mint two hundred public pages and two hundred codes
 * in one request.
 */
const MAX_CLINICS_AT_SIGNUP = 10;

/*
 * Compared in constant time. It is a shared secret rather than a per-user one,
 * so the timing side channel is a small concern — but it is three lines, and
 * `===` on a secret is the sort of thing that gets copied somewhere it matters.
 *
 * Both sides are hashed first so the comparison is over two equal-length
 * buffers: timingSafeEqual throws on a length mismatch, which would itself leak
 * the length of the real code.
 */
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function assertDeveloperCode(raw) {
  const supplied = sha256(String(raw ?? ""));
  const expected = sha256(DEVELOPER_CODE);
  if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw errors.invalidDeveloperCode();
  }
}

/* ================= GET /api/v1/auth/modules =================
 * What the signup form's first question offers.
 *
 * Served rather than hard-coded in the frontend, for the same reason the
 * permission catalogue is: adding a third product then makes it appear in the
 * picker without a frontend release, and the labels cannot drift out of step
 * with the values the register endpoint will actually accept.
 */
router.get("/modules", (req, res) =>
  res.json({
    modules: MODULES.map((module) => ({
      value: module,
      label: MODULE_LABELS[module],
      /* So the signup screen can say what an account will be able to do before
       * creating it — and, for clinic, that a developer code is needed. */
      roles: rolesFor(module),
      permissions: permissionsFor(module),
      requiresDeveloperCode: module === "clinic",
    })),
    default: DEFAULT_MODULE,
  })
);

/* ================= POST /api/v1/auth/register =================
 * Public signup. Creates a tenant and its first account in one step.
 *
 * Both, together, or neither — a tenant with no account is unreachable and an
 * account with no tenant cannot be scoped by anything. If a later write fails,
 * everything created a moment earlier is removed rather than left as an orphan
 * that the next signup with the same name will collide with.
 *
 * ================= what is NOT read from this body =================
 *
 * `role` and `permissions`. This endpoint is on the open internet, and a signup
 * that honoured a role field would mean anyone could ask to be created as
 * somebody else's owner. They are not validated, not defaulted from, and not
 * read — the role is decided here, by the module.
 *
 * `module` IS read, and that is safe for the opposite reason: it grants
 * nothing, it only decides which empty business gets created.
 */
router.post(
  "/register",
  handler(async (req, res) => {
    const module = parseEnum(req.body.module, "module", MODULES, {
      fallback: DEFAULT_MODULE,
      label: "product",
    });

    const name = parseText(req.body.name, "name", { max: 80, label: "Your name" });
    const email = parseEmail(req.body.email);
    const password = parsePassword(req.body.password);
    const phone = parsePhone(req.body.phone);

    /* Checked before anything is created, so the common case — somebody signing
     * up twice — does not leave a stray tenant behind. */
    const taken = await Account.findOne({ email }).select("_id");
    if (taken) throw errors.emailTaken();

    if (module === "clinic") {
      return registerClinic(req, res, { name, email, password, phone });
    }
    return registerTransport(req, res, { name, email, password, phone });
  })
);

/*
 * A haulage company and its owner.
 */
async function registerTransport(req, res, { name, email, password, phone }) {
  const companyName = parseText(req.body.companyName, "companyName", {
    max: 120,
    label: "Company name",
  });

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
      module: "transport",
      companyId: company._id,
      name,
      email,
      phone,
      role: "owner",
      password: await hashPassword(password),
    });
  } catch (err) {
    await Company.deleteOne({ _id: company._id });
    /* A duplicate here means two signups raced past the check above. It is the
     * same situation the user asked about, so it gets the same answer. */
    if (err.code === 11000) throw errors.emailTaken();
    throw err;
  }

  return res.status(201).json({
    module: "transport",
    token: signToken(account, AUDIENCE_WEB),
    account: serialiseAccount(account),
    company: serialiseCompany(company),
  });
}

/*
 * A practice, its clinics, its owner login, and the API key its offline app
 * will authenticate with.
 *
 * ================= why the clinics are named here =================
 *
 * Nothing in this product can be entered until a clinic exists: a patient
 * belongs to one, a bill is issued by one, a staff member is granted one.
 * Creating the account and then landing the user on "add a clinic before you
 * can do anything" is an avoidable round trip, so the signup form asks for them
 * one line each.
 *
 * It stays OPTIONAL. Somebody who has not settled on names adds them later from
 * the Clinics screen, and that path has to keep working — a required list would
 * turn "the branches can wait until tomorrow" into a blocked signup.
 */
async function registerClinic(req, res, { name, email, password, phone }) {
  /* Before anything is created — there is no reason to allocate codes and mint
   * keys for a request that is about to be refused. */
  assertDeveloperCode(req.body.developerCode);

  /*
   * The practice name. Falls back to the person's, because a single-clinic
   * practice frequently has no other name and forcing one produces
   * "Dr Mehta Dr Mehta" above the clinic switcher.
   */
  const businessName = isNil(req.body.businessName)
    ? name
    : parseText(req.body.businessName, "businessName", { max: 120, label: "Practice name" });

  const clinicInputs = parseClinicInputs(req.body.clinics, MAX_CLINICS_AT_SIGNUP);

  const owner = await Owner.create({
    name,
    businessName,
    email,
    phone,
    address: parseOptionalText(req.body.address, "address", 300),
    city: parseOptionalText(req.body.city, "city", 80),
    state: parseOptionalText(req.body.state, "state", 80),
  });

  /*
   * From here everything is rolled back on failure. A half-finished signup that
   * leaves three orphan clinics behind is worse than one that leaves nothing:
   * those clinics hold slugs and codes nobody can ever claim again.
   */
  const created = [];
  let account;
  try {
    for (const clinicInput of clinicInputs) {
      /* Sequentially rather than in parallel: the identifier allocator checks
       * for a collision and then takes the code, and two of those racing would
       * both find "SUN" free. */
      created.push(await createClinicFor(owner, clinicInput, req));
    }

    account = await Account.create({
      module: "clinic",
      ownerId: owner._id,
      name,
      email,
      phone,
      /*
       * Always the owner, and never anything read from the body.
       *
       * This endpoint is on the open internet, but the scope it creates is a
       * NEW practice with nothing in it, so there is nothing to attach to. What
       * must never be possible is a signup that joins an EXISTING practice —
       * and that is prevented by ownerId being minted here rather than accepted.
       */
      role: "owner",
      /* Pinned to no branch: an owner reads across all of them. */
      clinicId: null,
      clinicIds: [],
      password: await hashPassword(password),
    });
  } catch (err) {
    const ids = created.map((c) => c.clinic._id);
    await Promise.all([
      Owner.deleteOne({ _id: owner._id }),
      Clinic.deleteMany({ _id: { $in: ids } }),
      ClinicLicense.deleteMany({ clinicId: { $in: ids } }),
      account ? Account.deleteOne({ _id: account._id }) : Promise.resolve(),
    ]);
    if (err.code === 11000) throw errors.emailTaken();
    throw err;
  }

  const clinics = created.map((c) => c.clinic);

  return res.status(201).json({
    ...serialise.session(serialiseAccount(account), owner, clinics),
    token: signToken(account, AUDIENCE_WEB),
    /*
     * One key per clinic, each shown once.
     *
     * A practice that registered two branches installs two apps, and each needs
     * its own credential: a shared key would make "which desk published this?"
     * unanswerable, and would turn one leak into a whole-practice event.
     */
    apiKeys: created.map((c) => ({
      clinicId: String(c.clinic._id),
      clinicName: c.clinic.name,
      loginId: c.license.loginId,
      apiKey: c.apiKey,
    })),
    warning:
      "Store these clinic keys now. They cannot be shown again — a lost key has to be rotated.",
  });
}

/*
 * One clinic, its generated identifiers, its licence and its key.
 *
 * Shared by signup and by the Clinics screen, so a branch added on day two is
 * indistinguishable from one named at registration. Two code paths inventing
 * identifiers by different rules is how "SUN" ends up meaning two clinics.
 */
async function createClinicFor(owner, input, req) {
  /* A bare string is still a valid caller — see parseClinicInputs. */
  const details = typeof input === "string" ? { name: input } : input;
  const clinicName = details.name;

  const { code, slug } = await allocateIdentifiers(clinicName, async ({ code: c, slug: s }) => {
    const clash = await Clinic.findOne({ $or: [{ code: c }, { slug: s }] }).select("_id");
    return !!clash;
  });

  /*
   * The clinic's own detail where one was given, the owner's where none was.
   *
   * `??` and not `||` on purpose: `""` is a deliberate blank — somebody clearing
   * a branch's phone number — and `||` would read it as absent and quietly put
   * the owner's number back. Only `undefined` means "not sent".
   */
  const pick = (own, fallback) => (own === undefined ? fallback : own);

  const clinic = new Clinic({
    ownerId: owner._id,
    name: clinicName,
    code,
    slug,
    phone: pick(details.phone, owner.phone),
    email: pick(details.email, owner.email),
    address: pick(details.address, owner.address),
    city: pick(details.city, owner.city),
    state: pick(details.state, owner.state),
    timezone:
      pick(details.timezone, parseOptionalText(req.body.timezone, "timezone", 60)) ||
      "Asia/Kolkata",
    /*
     * Findable from the first minute. A practice that signs up wants to be
     * bookable, and it can switch this off in Settings before anyone books —
     * whereas defaulting to off means a page that silently does not work and a
     * setting nobody knew to look for.
     */
    bookingEnabled: pick(details.bookingEnabled, true),
    /*
     * No seeded catalogue, deliberately — this reverses v2 on the point.
     *
     * A seeded price is a price nobody at that clinic agreed to, sitting in a
     * catalogue somebody can raise an invoice from. The screens open empty with
     * an Add button, which is at least honest about nobody having decided yet.
     */
    services: [],
    doctors: [],
  });
  const apiKey = clinic.issueApiKey();
  await clinic.save();

  const license = await ClinicLicense.create({
    clinicId: clinic._id,
    loginId: loginIdFor(code),
    status: "active",
    /* No expiry from self-serve signup. A licence that lapses is a commercial
     * decision somebody makes later, not a trap laid at registration. */
    expiresAt: null,
  });

  return { clinic, apiKey, license };
}


/* ================= POST /api/v1/auth/login =================
 * One field, either kind of credential.
 */
router.post(
  "/login",
  loginRateLimit,
  handler(async (req, res) => {
    /*
     * ================= email OR login ID, in one field =================
     *
     * Users do not reliably know which kind of credential they hold. A
     * receptionist reads "SUN-01" off the monitor; the person who signed the
     * clinic up remembers an email. Rejecting a correct password because it was
     * typed into the wrong box is the most infuriating possible sign-in bug,
     * and having two fields does not fix it — it just moves the confusion
     * earlier.
     *
     * `loginId` is accepted as an alias so a client that knows which it has can
     * say so, but neither field is treated differently.
     */
    const identity = String(req.body.email ?? req.body.loginId ?? "").trim();
    const password = String(req.body.password ?? "");

    /*
     * Deliberately NOT parseEmail. A login ID is not an email address and would
     * fail that parser — and the resulting 400 would tell a caller that the
     * value they typed is not a registered SHAPE, which is a small piece of the
     * enumeration this endpoint is careful not to give away.
     */
    const account = await findByIdentity(identity);

    /*
     * One answer for an unknown identity and for a wrong password. Anything
     * else turns this endpoint into a way of discovering which emails and login
     * IDs are registered — and in either of these markets, the registered list
     * is a competitor's customer list.
     */
    if (!account) throw errors.badCredentials();
    if (!(await verifyPassword(password, account.password))) throw errors.badCredentials();
    if (account.isActive === false) {
      throw errors.forbidden("This login has been suspended. Please contact support.");
    }

    account.lastLoginAt = new Date();
    await account.save();

    if (account.module === "clinic") {
      const { owner, clinics } = await loadClinicSession(account);
      return res.json({
        ...serialise.session(serialiseAccount(account), owner, clinics),
        token: signToken(account, AUDIENCE_WEB),
      });
    }

    const company = await Company.findById(account.companyId);
    if (!company || !company.isActive) {
      throw errors.forbidden("This company account is not active.");
    }

    return res.json({
      module: "transport",
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

/*
 * Resolve one typed value against both identities.
 *
 * Email first because it is the far commoner case, and the login ID lookup only
 * runs when the first misses — so the usual sign-in is one query, not two.
 */
async function findByIdentity(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const byEmail = await Account.findOne({ email: value.toLowerCase() }).select("+password");
  if (byEmail) return byEmail;

  return Account.findOne({ loginId: value.toUpperCase() }).select("+password");
}

/* ================= POST /api/v1/auth/driver-login =================
 * The phone in the cab. Transport only.
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
    if (account.module !== "transport" || !account.driverId) {
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
 * Who am I, what may I do, and which business am I in. The console calls this
 * on every load and builds its entire menu from `account.permissions`.
 */
router.get(
  "/me",
  requireAuth,
  handler(async (req, res) => {
    if (req.module === "clinic") {
      const { owner, clinics } = await loadClinicSession(req.account);
      return res.json(serialise.session(serialiseAccount(req.account), owner, clinics));
    }

    return res.json({
      module: "transport",
      account: serialiseAccount(req.account),
      company: serialiseCompany(req.company),
      tracking: req.company.trackingConfig(),
    });
  })
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
     * authenticated. The session may be an unattended browser at a reception
     * desk, and without this check walking past one is enough to take the
     * account.
     */
    const account = await Account.findById(req.account._id).select("+password");
    if (!(await verifyPassword(currentPassword, account.password))) {
      throw errors.validation("Your current password is not correct.", {
        currentPassword: "is incorrect",
      });
    }

    account.password = await hashPassword(newPassword);
    /*
     * Every other session ends here.
     *
     * A password change is usually somebody reacting to a password they think
     * has leaked, and leaving the old sessions alive would make it a gesture:
     * whoever had the old password still has a working token for as long as it
     * lasts. Incrementing the counter invalidates every token ever issued for
     * this account, including the one that made this request — which is why a
     * fresh one is returned below.
     */
    account.tokenVersion = (account.tokenVersion || 0) + 1;
    await account.save();

    return res.json({
      message: "Password changed. Other devices have been signed out.",
      token: signToken(account, req.audience || AUDIENCE_WEB),
    });
  })
);

/*
 * The practice and the clinics this account may open.
 *
 * ================= one loader for all three endpoints =================
 *
 * /auth/register, /auth/login and /auth/me all return the same three keys, and
 * the frontend reads them identically. Three endpoints assembling that shape
 * separately is the commonest way to produce a session with a nameless owner
 * and an empty clinic switcher — which is as far as the app gets.
 *
 * The clinic list is the SCOPE, not a directory: an owner gets every branch of
 * their practice, and a staff member gets only the ones they were granted. That
 * is what populates the switcher, so a receptionist never sees a branch they
 * cannot open.
 */
async function loadClinicSession(account) {
  const owner = await Owner.findById(account.ownerId);
  if (!owner || !owner.isActive) {
    throw errors.forbidden("This practice account is not active.");
  }

  const query = { ownerId: owner._id, isActive: true };
  /*
   * An owner's empty `clinicIds` means EVERY clinic, not none. Reading it the
   * other way hands the owner an empty switcher and a product that appears to
   * have lost their practice.
   */
  if (account.role !== "owner" && account.clinicIds && account.clinicIds.length) {
    query._id = { $in: account.clinicIds };
  }

  const clinics = await Clinic.find(query).sort({ name: 1 });
  return { owner, clinics };
}

function publicUrlFor(clinic) {
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/clinic/${clinic.slug}` : null;
}

module.exports = router;
