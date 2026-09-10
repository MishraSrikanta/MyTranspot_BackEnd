const express = require("express");

const Account = require("../../../models/Account");
const Clinic = require("../models/Clinic");
const audit = require("../../../utils/audit");
const { errors, handler } = require("../../../utils/apiError");
const {
  parseEmail,
  parsePassword,
  parseText,
  parseOptionalText,
  parsePhone,
  parseEnum,
  parseObjectId,
  parseBoolean,
  parsePaging,
  pageResult,
  isNil,
} = require("../../../utils/validate");
const { hashPassword } = require("../../../utils/auth");
const { requireAuth, requireModule } = require("../../../middleware/auth");
const {
  resolveClinicScope,
  requireClinicOwner,
  requireClinicPermission,
} = require("../../../middleware/clinicScope");
const permissions = require("../permissions");
const { loginIdFor } = require("../utils/provision");
const serialise = require("../utils/serialise");

const router = express.Router();

/*
 * Staff.
 *
 * The owner grants a person one clinic, several, or all of them. That grant is
 * `clinicIds`, and it is the authoritative set — see models/Account.js for the
 * rules, including the one that matters most: an owner's EMPTY list means every
 * clinic, not none.
 */

router.use(requireAuth, requireModule("clinic"), resolveClinicScope);

/* ================= GET /api/v1/users/permissions =================
 * The catalogue and the role presets.
 *
 * Served rather than duplicated in the frontend, so a permission added here
 * appears in the editor without a frontend release — and the two can never
 * drift into showing a tick box that authorises nothing.
 *
 * Deliberately readable by any signed-in user, not just the owner: the app uses
 * it for labels and groupings on screens that merely DISPLAY what somebody can
 * do, and gating it would make those screens show raw permission strings.
 */
router.get(
  "/permissions",
  handler(async (req, res) =>
    res.json({
      permissions: permissions.PERMISSIONS,
      groups: permissions.PERMISSION_GROUPS,
      roles: permissions.ROLES,
      presets: permissions.ROLE_PRESETS,
      ownerOnly: [...permissions.OWNER_ONLY],
    })
  )
);

/* ================= GET /api/v1/users ================= */
router.get(
  "/",
  requireClinicPermission("users.manage"),
  handler(async (req, res) => {
    const { page, limit, skip } = parsePaging(req.query, { defaultLimit: 50 });

    /* The practice's staff — scoped by ownerId, which comes from the account. */
    const query = { module: "clinic", ownerId: req.ownerId };

    if (!isNil(req.query.clinicId) && String(req.query.clinicId) !== "all") {
      /* Filtering the LIST by branch, which is a different question from the
       * caller's own scope: "who works at Sunshine?" */
      query.clinicIds = req.clinicId;
    }
    if (!isNil(req.query.q)) {
      const term = String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: term, $options: "i" } },
        { email: { $regex: term, $options: "i" } },
        { loginId: { $regex: term, $options: "i" } },
      ];
    }

    const [rows, total] = await Promise.all([
      Account.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Account.countDocuments(query),
    ]);

    const items = rows.map((a) =>
      serialise.staffAccount(a, permissions.effectivePermissions(a))
    );
    return res.json(pageResult(items, total, { page, limit }));
  })
);

/* ================= POST /api/v1/users ================= */
router.post(
  "/",
  requireClinicOwner,
  handler(async (req, res) => {
    const name = parseText(req.body.name, "name", { max: 80, label: "Name" });
    const email = parseEmail(req.body.email);
    const role = parseEnum(req.body.role, "role", permissions.ROLES);

    if (role === "owner") {
      /*
       * There is one owner per practice, created at signup.
       *
       * A second would be an account with no clinic pin and every permission,
       * which is indistinguishable from the first — and "who can remove whom?"
       * has no good answer once there are two. A deputy gets clinic_admin on
       * every branch, which is the same reach without the ambiguity.
       */
      throw errors.validation("A practice has one owner. Use Clinic admin instead.", {
        role: "cannot be owner",
      });
    }

    const taken = await Account.findOne({ email }).select("_id");
    if (taken) throw errors.emailTaken();

    const { clinicIds, clinicId } = await parseGrants(req, role);

    const account = await Account.create({
      module: "clinic",
      ownerId: req.ownerId,
      name,
      email,
      phone: parsePhone(req.body.phone),
      role,
      clinicId,
      clinicIds,
      /*
       * An empty list is stored as empty and RESOLVED to the role's preset on
       * read. That is the standing contract: empty means "use the preset", not
       * "no permissions" — and the frontend resolves it identically.
       */
      permissions: permissions.sanitisePermissions(req.body.permissions || [], {
        allowEmpty: true,
      }),
      /*
       * A login ID derived from the default clinic's code, so a staff member at
       * a shared desk can be told "you are SUN-04" rather than an email they do
       * not have.
       */
      loginId: await nextLoginId(req.ownerId, clinicId),
      password: await hashPassword(parsePassword(req.body.password)),
    });

    audit.record(req, {
      action: "user.create",
      entityType: "account",
      entityId: account._id,
      entityLabel: account.email,
      note: `${role} · ${clinicIds.length} clinic(s)`,
    });

    return res
      .status(201)
      .json({ user: serialise.staffAccount(account, permissions.effectivePermissions(account)) });
  })
);

/* ================= PATCH /api/v1/users/:id ================= */
router.patch(
  "/:id",
  requireClinicOwner,
  handler(async (req, res) => {
    const account = await Account.findOne({
      _id: parseObjectId(req.params.id, "id"),
      module: "clinic",
      ownerId: req.ownerId,
    });
    if (!account) throw errors.accountNotFound();

    /*
     * The owner's own row is not editable here.
     *
     * Changing your own role or permissions through the staff screen is the
     * single easiest way to lock yourself out of your own practice, and there
     * is no second owner to undo it. Name and password go through /auth.
     */
    if (account.role === "owner") {
      throw errors.forbidden("The owner account is managed from Settings.");
    }

    const before = {
      role: account.role,
      clinicIds: (account.clinicIds || []).map(String),
      permissions: account.permissions,
      isActive: account.isActive,
    };

    if (!isNil(req.body.name)) {
      account.name = parseText(req.body.name, "name", { max: 80, label: "Name" });
    }
    if (!isNil(req.body.phone)) account.phone = parsePhone(req.body.phone);
    if (!isNil(req.body.role)) {
      const role = parseEnum(req.body.role, "role", permissions.ROLES);
      if (role === "owner") {
        throw errors.validation("A practice has one owner.", { role: "cannot be owner" });
      }
      account.role = role;
    }

    if (!isNil(req.body.clinicIds) || !isNil(req.body.clinicId)) {
      const { clinicIds, clinicId } = await parseGrants(req, account.role, account);
      account.clinicIds = clinicIds;
      account.clinicId = clinicId;
    }

    if (!isNil(req.body.permissions)) {
      account.permissions = permissions.sanitisePermissions(req.body.permissions, {
        allowEmpty: true,
      });
    }

    if (!isNil(req.body.isActive)) {
      account.isActive = parseBoolean(req.body.isActive, true);
    }

    /*
     * Any change to what this person may do ends their live sessions.
     *
     * A permission removed from somebody who is signed in would otherwise keep
     * working for up to twelve hours — which is exactly the window in which a
     * revocation matters. The counter makes it immediate; see
     * Account.tokenVersion.
     */
    const changes = audit.diff(before, account, [
      "role",
      "clinicIds",
      "permissions",
      "isActive",
    ]);
    if (changes) account.tokenVersion = (account.tokenVersion || 0) + 1;

    await account.save();

    audit.record(req, {
      action: "user.update",
      entityType: "account",
      entityId: account._id,
      entityLabel: account.email,
      changes,
    });

    return res.json({
      user: serialise.staffAccount(account, permissions.effectivePermissions(account)),
    });
  })
);

/* ================= POST /api/v1/users/:id/reset-password ================= */
router.post(
  "/:id/reset-password",
  requireClinicOwner,
  handler(async (req, res) => {
    const account = await Account.findOne({
      _id: parseObjectId(req.params.id, "id"),
      module: "clinic",
      ownerId: req.ownerId,
    });
    if (!account) throw errors.accountNotFound();
    if (account.role === "owner") {
      throw errors.forbidden("The owner's password is changed from Settings.");
    }

    account.password = await hashPassword(parsePassword(req.body.password));
    /* Every session this person had ends here — the usual reason for an owner
     * resetting a password is that it is believed to have leaked. */
    account.tokenVersion = (account.tokenVersion || 0) + 1;
    await account.save();

    audit.record(req, {
      action: "user.password_reset",
      entityType: "account",
      entityId: account._id,
      entityLabel: account.email,
    });

    return res.json({ message: "Password changed. That person has been signed out." });
  })
);

/* ================= helpers ================= */

/*
 * The clinic grant, validated against the practice.
 *
 * Every id must belong to the caller's owner, and a miss is a 404 rather than a
 * 403 for the usual reason: a 403 would confirm the clinic exists, which lets
 * one practice probe for another's branches through a staff form.
 */
async function parseGrants(req, role, existing) {
  const raw = Array.isArray(req.body.clinicIds)
    ? req.body.clinicIds
    : existing
      ? (existing.clinicIds || []).map(String)
      : [];

  const ids = [...new Set(raw.map((id) => parseObjectId(id, "clinicIds")))];

  /*
   * A staff account with access to nothing can sign in and see empty screens,
   * which reliably becomes a support call — "the system is broken" — rather
   * than the question it actually is, which is "who forgot to tick a box?".
   */
  if (!ids.length) {
    throw errors.validation("Pick at least one clinic for this person.", {
      clinicIds: "pick at least one clinic",
    });
  }

  const owned = await Clinic.find({ _id: { $in: ids }, ownerId: req.ownerId }).select("_id");
  if (owned.length !== ids.length) throw errors.clinicNotFound();

  /*
   * The default pin. Must be one of the granted clinics — a person pinned to a
   * branch they may not open lands on an empty screen at every sign-in.
   */
  let clinicId = ids[0];
  if (!isNil(req.body.clinicId)) {
    const requested = parseObjectId(req.body.clinicId, "clinicId");
    if (!ids.some((id) => String(id) === requested)) {
      throw errors.validation("The default clinic must be one of the granted clinics.", {
        clinicId: "must be one of clinicIds",
      });
    }
    clinicId = requested;
  }

  return { clinicIds: ids, clinicId };
}

/*
 * SUN-04 — the next free login ID at this person's default clinic.
 *
 * Counted rather than sequenced through the Counter collection because it is
 * cosmetic: a gap after somebody leaves is fine, and the uniqueness that
 * matters is enforced by the index on the account. The loop is bounded so a
 * clinic with a strange history cannot spin.
 */
async function nextLoginId(ownerId, clinicId) {
  const clinic = await Clinic.findById(clinicId).select("code");
  if (!clinic) return undefined;

  for (let n = 2; n <= 99; n += 1) {
    const candidate = loginIdFor(clinic.code, n);
    const taken = await Account.findOne({ loginId: candidate }).select("_id");
    if (!taken) return candidate;
  }
  /* Ninety-eight staff at one branch. The account is still created — a missing
   * login ID is a cosmetic loss, and refusing the hire is not. */
  return undefined;
}

module.exports = router;
