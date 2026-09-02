const express = require("express");

const Account = require("../models/Account");
const Driver = require("../models/Driver");
const { errors, handler } = require("../utils/apiError");
const { hashPassword, serialiseAccount } = require("../utils/auth");
const {
  PERMISSIONS,
  ROLES,
  ROLE_PRESETS,
  presetFor,
  sanitisePermissions,
  DRIVER_ROLE,
} = require("../utils/permissions");
const {
  parseEmail,
  parsePassword,
  parseText,
  parsePhone,
  parseEnum,
  parseBoolean,
} = require("../utils/validate");
const { requireAuth, requirePermission, requireOwner } = require("../middleware/auth");
const audit = require("../utils/audit");

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/users/permissions =================
 * The catalogue the permissions screen is drawn from — every permission the
 * server knows about, and what each role starts with.
 *
 * Served rather than duplicated in the frontend so a permission added on the
 * server appears in the UI without a frontend release, and so the two can never
 * drift into showing a tick box that authorises nothing.
 */
router.get(
  "/permissions",
  handler(async (req, res) =>
    res.json({
      permissions: PERMISSIONS,
      roles: ROLES.filter((r) => r !== "owner"),
      presets: Object.fromEntries(
        Object.entries(ROLE_PRESETS).filter(([role]) => role !== "owner")
      ),
    })
  )
);

/* ================= GET /api/v1/users ================= */
router.get(
  "/",
  requirePermission("users.manage"),
  handler(async (req, res) => {
    const accounts = await Account.find({ companyId: req.companyId }).sort({
      role: 1,
      createdAt: 1,
    });
    return res.json({ users: accounts.map(serialiseAccount) });
  })
);

/* ================= POST /api/v1/users =================
 * Create a sub-account.
 */
router.post(
  "/",
  requirePermission("users.manage"),
  handler(async (req, res) => {
    const name = parseText(req.body.name, "name", { max: 80, label: "Name" });
    const email = parseEmail(req.body.email);
    const password = parsePassword(req.body.password);
    const phone = parsePhone(req.body.phone);

    /*
     * "owner" is refused by name. There is exactly one owner per company and it
     * is set at signup; letting this endpoint mint another would mean anyone
     * with users.manage could promote themselves past every check in the system
     * that treats an owner as unconditionally authorised.
     */
    const role = parseEnum(
      req.body.role,
      "role",
      ["MANAGER", "ACCOUNTANT", "OPERATIONS", "DRIVER", "CUSTOM"],
      { fallback: "OPERATIONS", label: "role" }
    ).toLowerCase();

    /*
     * The plan limit is enforced here rather than at billing time. A company on
     * the four-user plan that has quietly created eleven users is a support
     * conversation nobody wants to have retrospectively.
     */
    const limits = req.company.limits();
    if (limits.users != null) {
      const count = await Account.countDocuments({ companyId: req.companyId });
      if (count >= limits.users) {
        throw errors.planLimit(
          `Your plan includes ${limits.users} users. Upgrade to add more.`,
          { limit: limits.users, current: count }
        );
      }
    }

    if (await Account.findOne({ email }).select("_id")) throw errors.emailTaken();

    /*
     * An explicit list wins; otherwise the role's preset. Either way it goes
     * through the allowlist, so a permission this build does not recognise can
     * never be stored.
     *
     * A driver is the exception in both directions: the preset is empty and any
     * office permission sent with the request is dropped. A driver login reaches
     * its own trips through /api/v1/me by identity, and a driver holding
     * `trips.view` would be able to read the whole company's trip list — so the
     * only safe list for a driver is no list at all.
     */
    const isDriverRole = role === DRIVER_ROLE;
    const permissions = isDriverRole
      ? []
      : Array.isArray(req.body.permissions)
        ? sanitisePermissions(req.body.permissions)
        : presetFor(role);

    /*
     * Optional link to a driver record, which is what turns this into a login
     * for the phone app and for the driver screens.
     *
     * Required when the role IS driver: a driver login with nothing to be a
     * driver of has no permissions and no module — it can sign in and see an
     * empty screen, which looks like a broken product rather than a
     * misconfigured user.
     */
    if (isDriverRole && !req.body.driverId) {
      throw errors.validation("Choose which driver this login belongs to.", {
        driverId: "is required for a driver login",
      });
    }

    let driverId = null;
    if (req.body.driverId) {
      const driver = await Driver.findOne({
        _id: req.body.driverId,
        companyId: req.companyId,
      });
      if (!driver) throw errors.driverNotFound();
      driverId = driver._id;
    }

    const account = await Account.create({
      companyId: req.companyId,
      name,
      email,
      phone,
      role,
      permissions,
      driverId,
      password: await hashPassword(password),
    });

    /* Keep the driver record pointing back, so the driver screen can show
     * whether that driver can sign in. */
    if (driverId) {
      await Driver.updateOne({ _id: driverId }, { $set: { accountId: account._id } });
    }

    audit.record(req, {
      action: "user.created",
      entityType: "Account",
      entityId: account._id,
      entityLabel: account.email,
      changes: { role, permissions },
    });

    return res.status(201).json({ user: serialiseAccount(account) });
  })
);

/* ================= PUT /api/v1/users/:id ================= */
router.put(
  "/:id",
  requirePermission("users.manage"),
  handler(async (req, res) => {
    const account = await Account.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!account) throw errors.accountNotFound();

    /*
     * The owner's own row is off limits to everybody but the owner. Otherwise a
     * manager with users.manage could suspend the owner, strip their
     * permissions, or change the email a password reset would go to — and take
     * the company.
     */
    if (account.role === "owner" && String(req.account._id) !== String(account._id)) {
      throw errors.forbidden("Only the owner can change the owner's account.");
    }

    const before = {
      name: account.name,
      role: account.role,
      permissions: [...(account.permissions || [])],
      isActive: account.isActive,
    };

    if (req.body.name !== undefined) {
      account.name = parseText(req.body.name, "name", { max: 80, label: "Name" });
    }
    if (req.body.phone !== undefined) account.phone = parsePhone(req.body.phone);

    if (req.body.role !== undefined && account.role !== "owner") {
      const role = parseEnum(
        req.body.role,
        "role",
        ["MANAGER", "ACCOUNTANT", "OPERATIONS", "DRIVER", "CUSTOM"],
        { label: "role" }
      ).toLowerCase();
      /*
       * Changing the role re-applies its preset only when no explicit
       * permission list came with the request. Silently resetting a carefully
       * tuned list because somebody corrected a job title is the sort of
       * surprise that loses trust in the permissions screen entirely.
       */
      if (role !== account.role && req.body.permissions === undefined) {
        account.permissions = presetFor(role);
      }
      account.role = role;
    }

    /*
     * Same rule as on creation, and it has to be repeated here rather than
     * assumed: promoting somebody to driver and ticking permission boxes in the
     * same save must not leave a driver holding office access.
     */
    if (account.role === DRIVER_ROLE) {
      account.permissions = [];
    } else if (req.body.permissions !== undefined && account.role !== "owner") {
      account.permissions = sanitisePermissions(req.body.permissions);
    }

    if (req.body.isActive !== undefined && account.role !== "owner") {
      account.isActive = parseBoolean(req.body.isActive, true);
    }

    if (req.body.password !== undefined) {
      account.password = await hashPassword(parsePassword(req.body.password));
    }

    await account.save();

    const changes = audit.diff(before, account.toObject(), [
      "name",
      "role",
      "permissions",
      "isActive",
    ]);
    if (changes) {
      audit.record(req, {
        action: "user.updated",
        entityType: "Account",
        entityId: account._id,
        entityLabel: account.email,
        changes,
      });
    }

    return res.json({ user: serialiseAccount(account) });
  })
);

/* ================= DELETE /api/v1/users/:id =================
 * Owner-only, and a suspension rather than a delete.
 *
 * A user's name is on every expense they approved and every trip they closed.
 * Removing the row would leave those records attributed to nobody, which
 * destroys the audit trail retrospectively — the one thing an audit trail must
 * never do. Setting isActive false ends the session and keeps the history.
 */
router.delete(
  "/:id",
  requireOwner,
  handler(async (req, res) => {
    const account = await Account.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!account) throw errors.accountNotFound();
    if (account.role === "owner") {
      throw errors.forbidden("The owner's login cannot be removed.");
    }

    account.isActive = false;
    await account.save();

    audit.record(req, {
      action: "user.suspended",
      entityType: "Account",
      entityId: account._id,
      entityLabel: account.email,
    });

    return res.json({
      message: "That login has been suspended. Their past entries are kept.",
      user: serialiseAccount(account),
    });
  })
);

module.exports = router;
