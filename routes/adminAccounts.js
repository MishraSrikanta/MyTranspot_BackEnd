const express = require("express");

const Account = require("../models/Account");
const Company = require("../modules/transport/models/Company");
const Owner = require("../modules/clinic/models/Owner");
const Clinic = require("../modules/clinic/models/Clinic");
const ClinicLicense = require("../modules/clinic/models/ClinicLicense");

const { errors, handler } = require("../utils/apiError");
const { hashPassword, serialiseAccount } = require("../utils/auth");
const { MODULES, DEFAULT_MODULE, moduleOf, catalogueFor } = require("../utils/permissions");
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
const { requireAdminSecret } = require("../middleware/clinicKey");
const { consoleRateLimit } = require("../middleware/rateLimit");
const {
  allocateIdentifiers,
  loginIdFor,
  parseClinicInputs,
} = require("../modules/clinic/utils/provision");

/*
 * How many clinics one call may create.
 *
 * Higher than public signup's ten because this side of the door is the vendor
 * provisioning a customer they have spoken to, not an anonymous form — but
 * still capped, because a malformed client should not be able to mint two
 * hundred public pages and two hundred codes in a single request.
 */
const MAX_CLINICS_PER_CALL = 25;

/* The same rules signup uses — names or objects, blanks skipped, duplicates
 * dropped, the excess refused rather than truncated. Shared rather than
 * reimplemented: two parsers disagreeing about what counts as a duplicate is
 * how the console creates a clinic the signup form would have rejected. */
const parseClinicList = (raw) => parseClinicInputs(raw, MAX_CLINICS_PER_CALL);

/*
 * ================= the vendor's console API (base: /api/v1/admin) =================
 *
 * Every other route on this backend answers a question a CUSTOMER asks: a
 * haulage office reading its own trips, a practice publishing its own slots, an
 * owner managing their own staff through /api/v1/users. All of them are scoped
 * to the caller's own tenant, and that scoping IS the isolation guarantee —
 * there is deliberately no code path on them that reads across tenants.
 *
 * This file answers the other question, the one the person who SELLS the
 * software asks: who are my customers, create a login for this new one, add a
 * sub-login to that one, fix a name, remove a login that should not exist.
 * Those are cross-tenant by definition, which is exactly why they live behind a
 * different door instead of being bolted onto the customer-facing routes as a
 * special case that every future edit has to remember.
 *
 * ================= the door =================
 *
 * `requireAdminSecret` — the same gate modules/clinic/routes/admin.js uses, for
 * the same reason. The caller is not a person with an account, it is the
 * vendor's own console; there is no session to have, so there is no session to
 * check. An `x-admin-secret` header matches the deployment's ADMIN_SECRET or
 * the request does not happen.
 *
 * Guarded twice over, again like the provisioning routes: app.js does not mount
 * this router at all unless ADMIN_SECRET is set, so a deployment that was never
 * given one does not have these endpoints to find.
 *
 * ================= one router, two products =================
 *
 * `Account` is a single collection holding both products' logins, so splitting
 * this per module would leave two files disagreeing about what "create a login"
 * means. Instead every route takes `module`, and only the two things that
 * genuinely differ branch on it:
 *
 *   transport   tenant = Company   roles from modules/transport/permissions
 *   clinic      tenant = Owner     roles from modules/clinic/permissions
 *
 * That mirrors routes/auth.js, which dispatches registration the same way, and
 * routes/users.js, which dispatches staff management by the token's module.
 */

const router = express.Router();
/* Limiter first, so a wrong secret is counted rather than waved through to be
 * refused for free — see consoleRateLimit in middleware/rateLimit.js. */
router.use(consoleRateLimit, requireAdminSecret);

/* Which product a request is about. Every route needs it, so it is read one way
 * rather than three times with three different fallbacks. */
function moduleFrom(source) {
  return parseEnum(source.module, "module", MODULES, {
    fallback: DEFAULT_MODULE,
    label: "product",
  });
}

/*
 * The roles a sub-login may be given, per product, minus "owner".
 *
 * Owner is refused by name here exactly as it is on /api/v1/users: there is one
 * owner per tenant, it is created with the tenant, and a second one would be a
 * second unconditionally authorised login on somebody's business — added from a
 * console that business cannot see.
 *
 * Each product's own list, because forcing one catalogue onto the other gives a
 * clinic a "driver" and a haulage company a "lab".
 */
function staffRolesFor(module) {
  return catalogueFor(module).ROLES.filter((role) => role !== "owner");
}

/* The field an account is scoped by — the whole difference between the two
 * products' tenancy, in one place. */
function tenantFieldFor(module) {
  return module === "clinic" ? "ownerId" : "companyId";
}

function tenantModelFor(module) {
  return module === "clinic" ? Owner : Company;
}

/*
 * A tenant, whichever product it belongs to, in one shape so the console can
 * render one list.
 *
 * `name` is what a person would call the customer — the company or the practice
 * — and `contactName` is the human behind it, which for a clinic is a different
 * string and for a company is not stored at all.
 */
function serialiseTenant(module, doc, accounts = 0) {
  const base = {
    id: String(doc._id),
    module,
    email: doc.email || "",
    phone: doc.phone || "",
    city: doc.city || "",
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt,
    accounts,
  };

  if (module === "clinic") {
    return { ...base, name: doc.businessName || doc.name, contactName: doc.name };
  }
  /*
   * `subscription.plan`, not `plan`. The tier is nested on the company document
   * (models/Company.js), and reading the flat name here returned `undefined` for
   * every company on the list while looking perfectly reasonable in the code.
   */
  return { ...base, name: doc.name, contactName: "", plan: doc.subscription?.plan || "trial" };
}

/* ================= GET /api/v1/admin/catalogue =================
 * What the console needs to draw its forms: the products, and the roles and
 * permissions each one offers.
 *
 * Served rather than duplicated in the console, for the same reason
 * /api/v1/users/permissions is: a role added on the server appears in the form
 * without a frontend release, and the two cannot drift into offering a role the
 * server would refuse.
 */
router.get(
  "/catalogue",
  handler(async (req, res) =>
    res.json({
      modules: MODULES.map((module) => ({
        module,
        roles: catalogueFor(module).ROLES,
        staffRoles: staffRolesFor(module),
        permissions: catalogueFor(module).PERMISSIONS,
        /*
         * The subscription tiers, for the console's create-customer form.
         *
         * Served rather than hard-coded there for the same reason the roles are:
         * a tier added to models/Company.js appears in the form without a
         * frontend release, and the console cannot offer one the server would
         * refuse. Empty for a product with no tiers — a clinic's entitlement is
         * a per-branch licence, which is a different shape entirely.
         */
        plans: module === "transport" ? Company.PLANS : [],
      })),
    })
  )
);

/* ================= GET /api/v1/admin/tenants?module= =================
 * Every customer on one product, newest first, each with how many logins it
 * has — the number the console shows before anybody expands a row.
 */
router.get(
  "/tenants",
  handler(async (req, res) => {
    const module = moduleFrom(req.query);
    const tenants = await tenantModelFor(module).find({}).sort({ createdAt: -1 });

    /*
     * The login counts in one aggregation rather than a query per row. This is
     * the list somebody opens with two hundred customers in it, and N+1 there is
     * the difference between a screen and a wait.
     */
    const field = tenantFieldFor(module);
    const counts = await Account.aggregate([
      { $match: { [field]: { $in: tenants.map((t) => t._id) } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);
    const byTenant = new Map(counts.map((c) => [String(c._id), c.count]));

    return res.json({
      module,
      tenants: tenants.map((t) => serialiseTenant(module, t, byTenant.get(String(t._id)) || 0)),
      total: tenants.length,
    });
  })
);

/* ================= POST /api/v1/admin/tenants =================
 * A new customer and their owner login, in one call.
 *
 * One call rather than two because the halves are meaningless apart: a company
 * with no login is a row nobody can reach, and an owner account with no company
 * fails every request it makes. Everything is rolled back if the second half
 * fails, for exactly that reason.
 *
 * The vendor's equivalent of public signup — and unlike public signup it asks
 * for no developer code, because the door it is already behind is the admin
 * secret rather than an invite.
 */
router.post(
  "/tenants",
  handler(async (req, res) => {
    const module = moduleFrom(req.body);

    const name = parseText(req.body.name, "name", { max: 80, label: "Owner name" });
    const email = parseEmail(req.body.email);
    const password = parsePassword(req.body.password);
    const phone = parsePhone(req.body.phone);

    /* Checked before anything is created, so the common case — a customer who
     * already exists — does not leave a stray tenant behind. */
    if (await Account.findOne({ email }).select("_id")) throw errors.emailTaken();

    if (module === "clinic") {
      return createClinicTenant(req, res, { name, email, password, phone });
    }
    return createTransportTenant(req, res, { name, email, password, phone });
  })
);

async function createTransportTenant(req, res, { name, email, password, phone }) {
  const companyName = parseText(
    isNil(req.body.businessName) ? req.body.companyName : req.body.businessName,
    "businessName",
    { max: 120, label: "Company name" }
  );

  const company = await Company.create({
    name: companyName,
    phone,
    email,
    city: parseOptionalText(req.body.city, "city", 80),
    state: parseOptionalText(req.body.state, "state", 80),
    /*
     * The vendor sets the plan, because the vendor is who sold it. Public signup
     * cannot and takes the schema default — which is the difference between a
     * customer choosing their own limits and the person who invoiced them
     * recording what they bought.
     */
    ...(isNil(req.body.plan)
      ? {}
      : {
          subscription: {
            plan: parseEnum(req.body.plan, "plan", Company.PLANS, {
              fallback: "trial",
              label: "plan",
            }),
          },
        }),
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
    /* A duplicate here means two creations raced past the check above. Same
     * situation the caller asked about, so it gets the same answer. */
    if (err.code === 11000) throw errors.emailTaken();
    throw err;
  }

  return res.status(201).json({
    module: "transport",
    tenant: serialiseTenant("transport", company, 1),
    account: serialiseAccount(account),
  });
}

async function createClinicTenant(req, res, { name, email, password, phone }) {
  const businessName = isNil(req.body.businessName)
    ? name
    : parseText(req.body.businessName, "businessName", { max: 120, label: "Practice name" });

  /*
   * ================= one practice, as many clinics as it has =================
   *
   * This used to create exactly one, named by `clinicName`. A practice with four
   * branches therefore had to be created and then have three more added one at a
   * time through a different endpoint — and until `clinics` accepted details,
   * each of those inherited the head office's address.
   *
   * `clinics` is the same shape public signup takes (parseClinicInputs in
   * routes/auth.js): a list of names, or a list of objects each with its own
   * contact details. `clinicName` still works and means a list of one, so no
   * existing caller changes.
   *
   * A practice with NO clinic cannot be booked into and cannot sync, so the
   * fallback is one named after the practice rather than none.
   */
  const requested = parseClinicList(req.body.clinics);
  const clinicInputs = requested.length
    ? requested
    : [
        {
          name: isNil(req.body.clinicName)
            ? businessName
            : parseText(req.body.clinicName, "clinicName", { max: 120, label: "Clinic name" }),
        },
      ];

  const owner = await Owner.create({
    name,
    businessName,
    email,
    phone,
    address: parseOptionalText(req.body.address, "address", 300),
    city: parseOptionalText(req.body.city, "city", 80),
    state: parseOptionalText(req.body.state, "state", 80),
  });

  /* Everything created here, so the rollback below can undo all of it. */
  const clinics = [];
  const licenses = [];
  const apiKeys = [];
  let account;
  try {
    /*
     * Sequentially, not in parallel. The identifier allocator checks a code is
     * free and then takes it, and two of those racing would both find "SUN"
     * free — two clinics, one code, and every login ID ambiguous thereafter.
     */
    for (const input of clinicInputs) {
      /*
       * The code and slug come from the same allocator public signup and the
       * clinic provisioning route use. Three code paths inventing identifiers by
       * different rules is how "SUN" ends up meaning two clinics.
       */
      const { code, slug } = await allocateIdentifiers(input.name, async ({ code: c, slug: s }) => {
        const clash = await Clinic.findOne({ $or: [{ code: c }, { slug: s }] }).select("_id");
        return !!clash;
      });

      /*
       * The clinic's own detail where one was given, the practice's where none
       * was — which is right for the head office and wrong for every branch
       * after it, so each may override.
       *
       * `undefined` and `""` stay distinct: an omitted field inherits, and an
       * empty one is somebody deliberately clearing it. `||` here would quietly
       * put the practice's phone number back on a branch that has none.
       */
      const pick = (own, fallback) => (own === undefined ? fallback : own);

      const clinic = new Clinic({
        ownerId: owner._id,
        name: input.name,
        code,
        slug,
        phone: pick(input.phone, phone),
        email: pick(input.email, email),
        address: pick(input.address, parseOptionalText(req.body.address, "address", 300)),
        city: pick(input.city, parseOptionalText(req.body.city, "city", 80)),
        state: pick(input.state, parseOptionalText(req.body.state, "state", 80)),
        timezone:
          pick(input.timezone, parseOptionalText(req.body.timezone, "timezone", 60)) ||
          "Asia/Kolkata",
        bookingEnabled: pick(
          input.bookingEnabled,
          parseBoolean(req.body.bookingEnabled, true)
        ),
      });
      apiKeys.push({ clinicName: clinic.name, code, apiKey: clinic.issueApiKey() });
      await clinic.save();
      clinics.push(clinic);

      licenses.push(
        await ClinicLicense.create({
          clinicId: clinic._id,
          loginId: loginIdFor(code),
          /*
           * Null means a licence that does not lapse, the same default public
           * signup creates. A dated one is a decision, and this is the screen
           * where the person who sold the licence is in a position to make it.
           */
          expiresAt: isNil(req.body.expiresAt) ? null : new Date(req.body.expiresAt),
        })
      );
    }

    account = await Account.create({
      module: "clinic",
      ownerId: owner._id,
      name,
      email,
      /* The first clinic's login ID — the one the owner is told to quote. */
      loginId: licenses[0].loginId,
      phone,
      role: "owner",
      /* Pinned to no branch: an owner reads across all of them. */
      clinicId: null,
      clinicIds: [],
      password: await hashPassword(password),
    });

    /* Every licence points back at the login it authorises, so suspending one
     * can end that login's live sessions. */
    await ClinicLicense.updateMany(
      { _id: { $in: licenses.map((l) => l._id) } },
      { $set: { accountId: account._id } }
    );
  } catch (err) {
    /*
     * Rolled back in full — every clinic, not just the one that failed.
     *
     * A practice with no account is unreachable and holds slugs nobody can ever
     * claim again; a licence with no clinic is a row that means nothing. Half a
     * practice is worse than none, because the next attempt with the same names
     * collides with the wreckage of this one.
     */
    await Promise.all([
      Owner.deleteOne({ _id: owner._id }),
      Clinic.deleteMany({ _id: { $in: clinics.map((c) => c._id) } }),
      ClinicLicense.deleteMany({ _id: { $in: licenses.map((l) => l._id) } }),
      account ? Account.deleteOne({ _id: account._id }) : Promise.resolve(),
    ]);
    if (err.code === 11000) throw errors.emailTaken();
    throw err;
  }

  return res.status(201).json({
    module: "clinic",
    tenant: serialiseTenant("clinic", owner, 1),
    account: serialiseAccount(account),
    /* Kept singular as well as plural: every caller written before practices
     * could have more than one clinic reads `clinic` and `apiKey`. */
    clinic: {
      id: String(clinics[0]._id),
      name: clinics[0].name,
      code: clinics[0].code,
      slug: clinics[0].slug,
    },
    clinics: clinics.map((c, i) => ({
      id: String(c._id),
      name: c.name,
      code: c.code,
      slug: c.slug,
      loginId: licenses[i].loginId,
    })),
    loginId: licenses[0].loginId,
    /*
     * ================= shown once, and only once =================
     * No endpoint on this API returns a key after this moment. The document
     * holds a sha256 and a six-character prefix, neither of which can be turned
     * back into a working credential. One per clinic — they are separate
     * credentials for separate installations.
     */
    apiKey: apiKeys[0].apiKey,
    apiKeys,
    warning:
      "Store these clinic keys now. They cannot be shown again — a lost key has to be rotated.",
  });
}

/* ================= GET /api/v1/admin/tenants/:id =================
 * One customer, with what it is paying for.
 *
 * The two products answer that question from different places, because they
 * model it differently: a transport company carries a `plan` on the company
 * itself, and a practice carries a `ClinicLicense` per branch. Both are
 * returned in one `billing` block so the console has one shape to render.
 */
router.get(
  "/tenants/:id",
  handler(async (req, res) => {
    const module = moduleFrom(req.query);
    const tenant = await tenantModelFor(module).findById(req.params.id).catch(() => null);
    if (!tenant) throw errors.notFound("No customer with that id.");

    const field = tenantFieldFor(module);
    const accounts = await Account.countDocuments({ [field]: tenant._id });

    if (module === "clinic") {
      const clinics = await Clinic.find({ ownerId: tenant._id }).select("_id name code");
      const licences = await ClinicLicense.find({ clinicId: { $in: clinics.map((c) => c._id) } });
      const byClinic = new Map(licences.map((l) => [String(l.clinicId), l]));
      return res.json({
        tenant: serialiseTenant(module, tenant, accounts),
        billing: {
          kind: "licences",
          clinics: clinics.map((c) => {
            const licence = byClinic.get(String(c._id));
            return {
              clinicId: String(c._id),
              name: c.name,
              code: c.code,
              loginId: licence ? licence.loginId : null,
              status: licence ? licence.status : null,
              /* Null is a licence that does not lapse, not a missing date. */
              expiresAt: licence ? licence.expiresAt : null,
              issuedAt: licence ? licence.issuedAt : null,
            };
          }),
        },
      });
    }

    return res.json({
      tenant: serialiseTenant(module, tenant, accounts),
      billing: {
        kind: "plan",
        plan: tenant.subscription?.plan || "trial",
        plans: Company.PLANS,
        limits: tenant.limits(),
      },
    });
  })
);

/* ================= PATCH /api/v1/admin/tenants/:id =================
 * What the customer is paying for, and the details on the customer itself.
 *
 * ================= what this is NOT =================
 *
 * It is not a payment. **Neither product on this backend has a payments ledger**
 * — no amount, no method, no receipt, nothing to total. What exists is the
 * entitlement each product actually enforces: a transport company's `plan`,
 * which its user and vehicle limits are read from, and a clinic licence's
 * status and expiry, which decide whether that branch's console opens.
 *
 * So this endpoint records the *consequence* of being paid, which is the part
 * the software acts on. Recording the money itself would need a collection that
 * does not exist here, and inventing a half of one — an amount with no tax
 * treatment and no report — would be worse than the honest gap.
 */
router.patch(
  "/tenants/:id",
  handler(async (req, res) => {
    const module = moduleFrom(req.body);
    const tenant = await tenantModelFor(module).findById(req.params.id).catch(() => null);
    if (!tenant) throw errors.notFound("No customer with that id.");

    if (!isNil(req.body.name)) {
      const label = module === "clinic" ? "Practice name" : "Company name";
      const value = parseText(req.body.name, "name", { max: 120, label });
      if (module === "clinic") tenant.businessName = value;
      else tenant.name = value;
    }
    if (!isNil(req.body.email)) tenant.email = parseEmail(req.body.email);
    if (!isNil(req.body.phone)) tenant.phone = parsePhone(req.body.phone);
    if (!isNil(req.body.city)) tenant.city = parseOptionalText(req.body.city, "city", 80);

    /*
     * The plan is the transport product's entitlement: models/Company.js reads
     * its user, vehicle and trip limits straight off it. Changing it here is the
     * vendor recording an upgrade, and it takes effect on the customer's next
     * request rather than at some billing boundary.
     */
    if (!isNil(req.body.plan)) {
      if (module !== "transport") {
        throw errors.validation("A plan belongs to a transport company.", {
          plan: "not applicable to a clinic — use the licence fields",
        });
      }
      /*
       * Assigned into `subscription`, which is where the schema keeps it.
       * Writing `tenant.plan` instead is the quiet failure this cost an
       * afternoon to find: Mongoose's strict mode drops a path the schema does
       * not declare, so the save succeeded, the response echoed the new tier
       * back off the in-memory document, and the company stayed on the old one.
       * The console said "upgraded" and the customer's limits never moved.
       */
      if (!tenant.subscription) tenant.subscription = {};
      tenant.subscription.plan = parseEnum(req.body.plan, "plan", Company.PLANS, {
        fallback: tenant.subscription.plan || "trial",
        label: "plan",
      });
      tenant.markModified("subscription");
    }

    await tenant.save();

    /*
     * A clinic's entitlement lives on the branch, not the practice, so it is
     * addressed by `clinicId`. Suspending one ends that login's live sessions,
     * for the same reason a suspension does anywhere else: one that leaves the
     * desk signed in until tomorrow is not a suspension.
     */
    let licence = null;
    if (module === "clinic" && (!isNil(req.body.status) || !isNil(req.body.expiresAt))) {
      const clinicId = parseText(req.body.clinicId, "clinicId", { max: 40, label: "Clinic" });
      const clinic = await Clinic.findOne({ _id: clinicId, ownerId: tenant._id }).catch(() => null);
      /* 404 rather than 403 for a branch belonging to another practice: a 403
       * confirms it exists, which is how one practice enumerates another's. */
      if (!clinic) throw errors.clinicNotFound();

      licence = await ClinicLicense.findOne({ clinicId: clinic._id });
      if (!licence) throw errors.notFound("That clinic has no licence on record.");

      if (!isNil(req.body.status)) {
        licence.status = parseEnum(req.body.status, "status", ClinicLicense.STATUSES, {
          fallback: licence.status,
          label: "status",
        });
      }
      if (!isNil(req.body.expiresAt)) {
        /* An explicit null is "does not lapse", which is different from "not
         * sent" — hence the null check rather than a falsy one. */
        licence.expiresAt = req.body.expiresAt === null ? null : new Date(req.body.expiresAt);
      }
      if (!isNil(req.body.note)) {
        licence.note = parseOptionalText(req.body.note, "note", 300);
      }
      await licence.save();

      if (licence.status !== "active" && licence.accountId) {
        await Account.updateOne({ _id: licence.accountId }, { $inc: { tokenVersion: 1 } });
      }
    }

    const field = tenantFieldFor(module);
    const accounts = await Account.countDocuments({ [field]: tenant._id });
    return res.json({
      tenant: serialiseTenant(module, tenant, accounts),
      ...(licence
        ? {
            licence: {
              clinicId: String(licence.clinicId),
              loginId: licence.loginId,
              status: licence.status,
              expiresAt: licence.expiresAt,
            },
          }
        : {}),
    });
  })
);

/* ================= GET /api/v1/admin/accounts?module=&tenantId= =================
 * Every login on one product, or one customer's logins with `tenantId`.
 *
 * Unpaged on purpose: this is a vendor's customer list, which is hundreds rather
 * than millions, and a total that silently covers the first page only is a wrong
 * number presented as a right one.
 */
router.get(
  "/accounts",
  handler(async (req, res) => {
    const module = moduleFrom(req.query);
    const query = {};

    /*
     * Accounts predating the two-product split carry no `module` at all and are
     * every one of them transport — the same default utils/permissions.js
     * applies. Matching on the field alone would hide them from the console that
     * is supposed to manage them.
     */
    if (module === DEFAULT_MODULE) {
      query.$or = [{ module }, { module: { $exists: false } }, { module: null }];
    } else {
      query.module = module;
    }

    if (!isNil(req.query.tenantId)) {
      query[tenantFieldFor(module)] = req.query.tenantId;
    }

    const accounts = await Account.find(query).sort({ role: 1, createdAt: 1 });
    return res.json({
      module,
      accounts: accounts.map(serialiseAccount),
      total: accounts.length,
    });
  })
);

/* ================= POST /api/v1/admin/accounts =================
 * A sub-login under an existing customer.
 *
 * The vendor's version of what /api/v1/users does for a customer managing its
 * own staff — same shape, same refusal of "owner", and deliberately WITHOUT the
 * plan limit that route enforces. A limit exists to stop a customer quietly
 * exceeding what they bought; the vendor adding a login is the person who
 * decides what they bought.
 */
router.post(
  "/accounts",
  handler(async (req, res) => {
    const module = moduleFrom(req.body);
    const field = tenantFieldFor(module);

    const tenantId = parseText(req.body.tenantId, "tenantId", { max: 40, label: "Customer" });
    const tenant = await tenantModelFor(module).findById(tenantId).catch(() => null);
    if (!tenant) {
      throw errors.validation("No customer with that id.", { tenantId: "does not exist" });
    }

    const name = parseText(req.body.name, "name", { max: 80, label: "Name" });
    const email = parseEmail(req.body.email);
    const password = parsePassword(req.body.password);
    const phone = parsePhone(req.body.phone);

    const staffRoles = staffRolesFor(module);
    const role = parseEnum(req.body.role, "role", staffRoles, {
      fallback: staffRoles[0],
      label: "role",
    });

    if (await Account.findOne({ email }).select("_id")) throw errors.emailTaken();

    /*
     * An explicit list wins; otherwise the role's preset. Either way it goes
     * through that module's allowlist, so a permission this build does not
     * recognise — or one belonging to the other product — can never be stored.
     */
    const catalogue = catalogueFor(module);
    const permissions = Array.isArray(req.body.permissions)
      ? catalogue.sanitisePermissions(req.body.permissions)
      : catalogue.presetFor(role);

    const doc = {
      module,
      [field]: tenant._id,
      name,
      email,
      phone,
      role,
      permissions,
      password: await hashPassword(password),
    };

    /*
     * A clinic sub-login is pinned to the branches it may open, and an empty
     * list on a NON-owner means no branch at all rather than every branch — see
     * models/Account.js. So the caller names them, and the default is every
     * branch the practice currently has rather than a login that can open
     * nothing and looks broken on its first morning.
     */
    if (module === "clinic") {
      const branches = await Clinic.find({ ownerId: tenant._id }).select("_id");
      const allowed = branches.map((c) => String(c._id));
      const requested = Array.isArray(req.body.clinicIds) ? req.body.clinicIds.map(String) : null;
      const clinicIds = requested ? requested.filter((id) => allowed.includes(id)) : allowed;

      if (clinicIds.length === 0) {
        throw errors.validation("This login needs at least one clinic it may open.", {
          clinicIds: "is required",
        });
      }
      doc.clinicIds = clinicIds;
      doc.clinicId = clinicIds.includes(String(req.body.clinicId))
        ? req.body.clinicId
        : clinicIds[0];
    }

    const account = await Account.create(doc);
    return res.status(201).json({ account: serialiseAccount(account) });
  })
);

/* ================= GET /api/v1/admin/accounts/:id ================= */
router.get(
  "/accounts/:id",
  handler(async (req, res) => {
    const account = await Account.findById(req.params.id).catch(() => null);
    if (!account) throw errors.accountNotFound();
    return res.json({ account: serialiseAccount(account) });
  })
);

/* ================= PATCH /api/v1/admin/accounts/:id =================
 * Only the fields present are changed.
 *
 * Two of them reach beyond the row and are handled rather than merely written: a
 * new password and a suspension each end every live session on the account, by
 * bumping the counter middleware/auth.js checks. A suspension that leaves the
 * desk signed in until tomorrow is not a suspension.
 */
router.patch(
  "/accounts/:id",
  handler(async (req, res) => {
    const account = await Account.findById(req.params.id).catch(() => null);
    if (!account) throw errors.accountNotFound();

    const module = moduleOf(account);
    let endSessions = false;

    if (!isNil(req.body.name)) {
      account.name = parseText(req.body.name, "name", { max: 80, label: "Name" });
    }
    if (!isNil(req.body.phone)) account.phone = parsePhone(req.body.phone);

    if (!isNil(req.body.email)) {
      const email = parseEmail(req.body.email);
      if (email !== account.email) {
        if (await Account.findOne({ email, _id: { $ne: account._id } }).select("_id")) {
          throw errors.emailTaken();
        }
        account.email = email;
      }
    }

    /*
     * An owner's role is not editable here. Demoting the only owner of a business
     * leaves it with nobody who can grant anything — including nobody who can
     * undo the demotion.
     */
    if (!isNil(req.body.role)) {
      if (account.role === "owner") {
        throw errors.validation("An owner's role cannot be changed.", {
          role: "the owner is this customer's only unconditionally authorised login",
        });
      }
      account.role = parseEnum(req.body.role, "role", staffRolesFor(module), {
        fallback: account.role,
        label: "role",
      });
      /* The preset follows the role unless the caller sent a list of their own.
       * Otherwise a promoted receptionist keeps a receptionist's permissions and
       * the new job title quietly means nothing. */
      if (!Array.isArray(req.body.permissions)) {
        account.permissions = catalogueFor(module).presetFor(account.role);
      }
    }

    if (Array.isArray(req.body.permissions)) {
      account.permissions = catalogueFor(module).sanitisePermissions(req.body.permissions);
    }

    /*
     * ================= changing which branches a login may open =================
     *
     * The clinic product's access control is not a permission list, it is a
     * scope: `clinicIds` names the branches this login may open, and everything
     * outside it answers 404 rather than 403 (models/Account.js explains why).
     * Being able to set that only at creation made it a decision nobody could
     * revise — a receptionist moved to the second branch had to be deleted and
     * recreated, losing their id and their history.
     *
     * An OWNER is deliberately excluded. Their reach over every branch the
     * practice has is expressed by an EMPTY list, not by a list naming them all,
     * so writing branches onto an owner would silently demote them the moment
     * the practice opened a branch that was not in the list.
     */
    if (module === "clinic" && Array.isArray(req.body.clinicIds) && account.role !== "owner") {
      const branches = await Clinic.find({ ownerId: account.ownerId }).select("_id");
      const allowed = branches.map((c) => String(c._id));
      /*
       * Filtered against the practice's own branches, not trusted as sent. This
       * is the request that would otherwise let one practice's staff be pinned
       * to another practice's clinic by pasting an id.
       */
      const clinicIds = req.body.clinicIds.map(String).filter((id) => allowed.includes(id));

      if (clinicIds.length === 0) {
        throw errors.validation("This login needs at least one clinic it may open.", {
          clinicIds: "is required",
        });
      }

      account.clinicIds = clinicIds;
      /* The default branch has to stay inside the new scope, or the login opens
       * on a clinic it may no longer read and looks broken rather than changed. */
      if (!clinicIds.includes(String(account.clinicId))) account.clinicId = clinicIds[0];
      /* Their access changed, so the session carrying the old scope must go. */
      endSessions = true;
    }

    if (!isNil(req.body.isActive)) {
      const next = parseBoolean(req.body.isActive, account.isActive !== false);
      if (next !== (account.isActive !== false)) {
        account.isActive = next;
        /* Suspending ends the sessions. Restoring does not need to. */
        if (!next) endSessions = true;
      }
    }

    if (!isNil(req.body.password)) {
      account.password = await hashPassword(parsePassword(req.body.password));
      endSessions = true;
    }

    if (endSessions) account.tokenVersion = (account.tokenVersion || 0) + 1;

    await account.save();
    return res.json({ account: serialiseAccount(account) });
  })
);

/* ================= DELETE /api/v1/admin/accounts/:id =================
 * Permanent, and refused for an owner who still has other logins.
 *
 * Refused rather than cascaded: deleting a customer's owner would take every
 * sub-login with it as a side effect of one click, and the receptionist who
 * cannot sign in tomorrow morning has no way to find out why. Two deliberate
 * steps cost a moment and remove that entirely.
 *
 * Note what this does NOT delete: the company or the practice. A tenant with no
 * logins is recoverable by creating one; a deleted tenant takes its trips, its
 * clinics and its licences with it, and that is not a decision an account screen
 * should be making on somebody's behalf.
 */
router.delete(
  "/accounts/:id",
  handler(async (req, res) => {
    const account = await Account.findById(req.params.id).catch(() => null);
    if (!account) throw errors.accountNotFound();

    if (account.role === "owner") {
      const field = tenantFieldFor(moduleOf(account));
      const others = await Account.countDocuments({
        [field]: account[field],
        _id: { $ne: account._id },
      });
      if (others > 0) {
        throw errors.resourceBusy(
          `This customer still has ${others} other login${others === 1 ? "" : "s"}. Remove those first — deleting the owner would leave them attached to nobody.`,
          { logins: others }
        );
      }
    }

    await Account.deleteOne({ _id: account._id });
    return res.json({ deleted: true, id: String(account._id) });
  })
);

module.exports = router;
