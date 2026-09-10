const express = require("express");

const Owner = require("../models/Owner");
const Clinic = require("../models/Clinic");
const Slot = require("../models/Slot");
const ClinicLicense = require("../models/ClinicLicense");
const Account = require("../../../models/Account");
const { errors, handler } = require("../../../utils/apiError");
const {
  parseText,
  parseOptionalText,
  parseSlug,
  parseTime,
  parsePhone,
  parseBoolean,
  parsePaging,
  pageResult,
  parseObjectId,
  isNil,
} = require("../../../utils/validate");
const { requireAdminSecret } = require("../../../middleware/clinicKey");
const { allocateIdentifiers } = require("../utils/provision");
const { adminRateLimit } = require("../../../middleware/rateLimit");
const serialise = require("../utils/serialise");

const router = express.Router();

/*
 * Provisioning. Three endpoints, used a handful of times per customer by
 * whoever runs the deployment — not by anybody at a clinic.
 *
 * Guarded twice over: the shared secret must match, and app.js keeps this
 * router mounted so a missing deployment secret is reported as configuration
 * failure rather than a misleading route 404.
 */
router.use(requireAdminSecret, adminRateLimit);

/* ================= POST /api/v1/admin/clinics =================
 * Create a clinic and issue its first API key.
 */
router.post(
  "/clinics",
  handler(async (req, res) => {
    const name = parseText(req.body.name, "name", { max: 120, label: "Clinic name" });

    /*
     * The code and slug come from the same allocator public signup uses, so a
     * clinic provisioned by hand is indistinguishable from one that registered
     * itself. Two code paths inventing identifiers by different rules is how
     * "SUN" ends up meaning two clinics.
     *
     * An explicit slug is still honoured — provisioning is where somebody has a
     * reason to insist on one — but it is validated through the same parser and
     * checked for a collision, so it cannot bypass the reserved-word list.
     */
    let code;
    let slug;
    if (isNil(req.body.slug)) {
      ({ code, slug } = await allocateIdentifiers(name, async ({ code: c, slug: s }) => {
        const clash = await Clinic.findOne({ $or: [{ code: c }, { slug: s }] }).select("_id");
        return !!clash;
      }));
    } else {
      slug = parseSlug(req.body.slug);
      const taken = await Clinic.findOne({ slug }).select("_id");
      if (taken) {
        throw errors.duplicate("That web address is already taken.", {
          slug: "is already in use",
        });
      }
      /* The slug is fixed, so only the code still needs allocating around it. */
      ({ code } = await allocateIdentifiers(name, async ({ code: c }) => {
        const clash = await Clinic.findOne({ code: c }).select("_id");
        return !!clash;
      }));
    }

    /*
     * A clinic belongs to a practice, so provisioning one by hand creates the
     * practice too unless an existing one is named.
     *
     * The alternative — a clinic with a null ownerId — would be a row no
     * session could ever scope to: every clinic query filters by the account's
     * ownerId, so an ownerless clinic is invisible to the console that is
     * supposed to run it.
     */
    let owner;
    if (isNil(req.body.ownerId)) {
      owner = await Owner.create({
        name: parseOptionalText(req.body.ownerName, "ownerName", 80) || name,
        businessName: parseOptionalText(req.body.businessName, "businessName", 120) || name,
        email: parseOptionalText(req.body.email, "email", 160),
        phone: parseOptionalText(req.body.phone, "phone", 20),
      });
    } else {
      owner = await Owner.findById(parseObjectId(req.body.ownerId, "ownerId"));
      if (!owner) throw errors.notFound("That practice no longer exists.");
    }

    const clinic = new Clinic({
      ownerId: owner._id,
      name,
      code,
      slug,
      address: parseOptionalText(req.body.address, "address", 300),
      city: parseOptionalText(req.body.city, "city", 80),
      state: parseOptionalText(req.body.state, "state", 80),
      pincode: parseOptionalText(req.body.pincode, "pincode", 10),
      phone: parseOptionalText(req.body.phone, "phone", 20),
      email: parseOptionalText(req.body.email, "email", 160),
      /*
       * The timezone is set HERE and never by a sync call. Every expiry
       * decision on this API is made in it, so it is provisioning data rather
       * than something a workbook should be able to move — and a clinic that
       * changed its own timezone by accident would age out a day of slots.
       */
      timezone: parseOptionalText(req.body.timezone, "timezone", 60) || "Asia/Kolkata",
      openTime: isNil(req.body.openTime) ? "09:00" : parseTime(req.body.openTime, "openTime"),
      closeTime: isNil(req.body.closeTime)
        ? "20:00"
        : parseTime(req.body.closeTime, "closeTime"),
      bookingEnabled: parseBoolean(req.body.bookingEnabled, true),
    });

    /* Minted before the first save, so a clinic never exists without a key —
     * which would be a row nobody could reach and nobody would think to fix. */
    const apiKey = clinic.issueApiKey();
    await clinic.save();

    return res.status(201).json({
      owner: serialise.owner(owner),
      clinic: serialise.adminClinic(clinic),
      /*
       * ================= shown once, and only once =================
       *
       * There is no endpoint anywhere on this API that returns a key after this
       * moment. The document holds a sha256 of it and a six-character prefix,
       * neither of which can be turned back into a working credential.
       *
       * That is the standard contract for API keys, and the reason is simple: a
       * key list somebody can read is a key list an attacker can read, and the
       * attacker only needs the database once.
       */
      apiKey,
      warning:
        "Store this key now. It cannot be shown again — a lost key has to be rotated.",
    });
  })
);

/* ================= GET /api/v1/admin/clinics ================= */
router.get(
  "/clinics",
  handler(async (req, res) => {
    const { page, limit, skip } = parsePaging(req.query, { defaultLimit: 50 });

    const query = {};
    if (!isNil(req.query.q)) {
      const term = String(req.query.q).trim();
      /* Escaped before it becomes a regex. An unescaped search box is a way to
       * hand a caller a pattern that scans the whole collection. */
      const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: safe, $options: "i" } },
        { slug: { $regex: safe, $options: "i" } },
      ];
    }

    const [rows, total] = await Promise.all([
      Clinic.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Clinic.countDocuments(query),
    ]);

    /*
     * How much each clinic has on the books, in one aggregation rather than two
     * queries per row. This list is the screen somebody
     * opens when a clinic rings to say something has stopped working, and
     * "forty live bookings, last published on Tuesday" is the answer they need
     * in front of them.
     */
    const ids = rows.map((c) => c._id);
    const live = await Slot.aggregate([
      { $match: { clinicId: { $in: ids } } },
      { $unwind: "$bookings" },
      { $match: { "bookings.status": { $in: Slot.ACTIVE_STATUSES } } },
      { $group: { _id: "$clinicId", count: { $sum: 1 } } },
    ]);
    const liveByClinic = new Map(live.map((p) => [String(p._id), p.count]));

    const items = rows.map((clinic) => ({
      ...serialise.adminClinic(clinic),
      liveBookings: liveByClinic.get(String(clinic._id)) || 0,
    }));

    return res.json(pageResult(items, total, { page, limit }));
  })
);

/* ================= POST /api/v1/admin/clinics/:id/rotate-key =================
 * Issue a new key and invalidate the old one immediately.
 */
router.post(
  "/clinics/:id/rotate-key",
  handler(async (req, res) => {
    const clinic = await Clinic.findById(req.params.id);
    if (!clinic) throw errors.clinicNotFound();

    /*
     * The old key stops working the moment this saves. There is deliberately no
     * grace period and no second live key.
     *
     * A rotation happens because a key leaked, and a leaked key that goes on
     * working for an hour is a leaked key. The cost is that the clinic's app
     * fails to sync until somebody pastes the new one in — which is visible,
     * fixable in a minute, and vastly preferable to the alternative being
     * invisible.
     */
    const apiKey = clinic.issueApiKey();
    await clinic.save();

    return res.json({
      clinic: serialise.adminClinic(clinic),
      apiKey,
      warning:
        "The previous key stopped working immediately. Install this one in the clinic app.",
    });
  })
);

/* ================= GET /api/v1/admin/clinics/:id =================
 * Not one of the thirteen, and included because the two-line version of "why
 * has this clinic stopped syncing?" is worth more than the support call it
 * replaces. Read-only, and it returns no credential.
 */
router.get(
  "/clinics/:id",
  handler(async (req, res) => {
    const clinic = await Clinic.findById(req.params.id);
    if (!clinic) throw errors.clinicNotFound();

    const [slots, openSlots, booked] = await Promise.all([
      Slot.countDocuments({ clinicId: clinic._id }),
      Slot.countDocuments({ clinicId: clinic._id, isBlocked: false, available: { $gt: 0 } }),
      Slot.aggregate([
        { $match: { clinicId: clinic._id } },
        { $group: { _id: null, total: { $sum: "$booked" } } },
      ]),
    ]);

    return res.json({
      clinic: serialise.adminClinic(clinic),
      counts: {
        slots,
        openSlots,
        liveBookings: booked.length ? booked[0].total : 0,
      },
    });
  })
);

/* ================= PATCH /api/v1/admin/clinics/:id =================
 * A clinic's own details.
 *
 * ================= why this endpoint had to exist =================
 *
 * Until now nothing in the product could edit a clinic. Signup created them and
 * that was the last word — which was survivable while a clinic's details were
 * simply the owner's copied across, and became a real problem the moment a
 * practice could register two. A Cuttack branch created with Bhubaneswar's
 * address had that address on its public booking page permanently, and the only
 * remedy was to delete the clinic and lose its code, its slug and its bookings.
 *
 * So: the fields a person can be wrong about are editable, and the ones the rest
 * of the system depends on are not.
 *
 * ================= what is deliberately NOT editable =================
 *
 * `code`   prefixes every login ID and every numbered document the clinic has
 *          ever issued. Changing it would orphan all of them.
 * `slug`   is the public booking address. Changing it breaks every link the
 *          clinic has printed, texted or put on a card. It is settable once, at
 *          creation, where somebody is choosing rather than correcting.
 * `ownerId` moving a clinic between practices would move its bookings and its
 *          staff scopes with it, silently.
 *
 * A rename IS allowed — the name is a label, and nothing keys off it.
 */
router.patch(
  "/clinics/:id",
  handler(async (req, res) => {
    const clinic = await Clinic.findById(parseObjectId(req.params.id, "id")).catch(() => null);
    if (!clinic) throw errors.clinicNotFound();

    /*
     * Only the fields present are touched. A PATCH that defaulted the absent
     * ones would let a form which renders four boxes blank out the six it does
     * not know about — which is how an address disappears when somebody edits a
     * phone number.
     *
     * ================= and "present" means present, not non-empty =================
     *
     * Deliberately NOT `isNil`, which is the shared parser helper and reads a
     * blank string as missing. That is the right reading almost everywhere else
     * in this codebase and precisely wrong on an edit form, where `""` is how a
     * person CLEARS a field.
     *
     * With `isNil` here, clearing a clinic's address did nothing at all: the
     * request succeeded, the response echoed the old address back, and the
     * operator was left believing they had removed it.
     */
    const absent = (v) => v === undefined || v === null;

    /* A blank name is refused rather than ignored — parseText rejects it — and
     * that is right: it is a mistake, not an instruction. */
    if (!absent(req.body.name)) {
      clinic.name = parseText(req.body.name, "name", { max: 120, label: "Clinic name" });
    }
    if (!absent(req.body.phone)) clinic.phone = parsePhone(req.body.phone);
    if (!absent(req.body.email)) clinic.email = parseOptionalText(req.body.email, "email", 160);
    if (!absent(req.body.address)) {
      clinic.address = parseOptionalText(req.body.address, "address", 300);
    }
    if (!absent(req.body.city)) clinic.city = parseOptionalText(req.body.city, "city", 80);
    if (!absent(req.body.state)) clinic.state = parseOptionalText(req.body.state, "state", 80);
    if (!absent(req.body.timezone)) {
      /*
       * Falling back to the current value rather than to Asia/Kolkata: somebody
       * clearing this box means "leave it alone", and silently relocating a
       * clinic's timezone would move every appointment time it displays.
       */
      clinic.timezone = parseOptionalText(req.body.timezone, "timezone", 60) || clinic.timezone;
    }
    if (!isNil(req.body.bookingEnabled)) {
      clinic.bookingEnabled = parseBoolean(req.body.bookingEnabled, clinic.bookingEnabled !== false);
    }
    if (!isNil(req.body.isActive)) {
      clinic.isActive = parseBoolean(req.body.isActive, clinic.isActive !== false);
    }

    await clinic.save();
    return res.json({ clinic: serialise.adminClinic(clinic) });
  })
);

/* ================= DELETE /api/v1/admin/clinics/:id =================
 * Removes a clinic, its licence and its slots.
 *
 * ================= what this refuses, and why =================
 *
 * Deleting a clinic is not deleting a row. It takes the licence with it, every
 * slot published against it, and every booking inside those slots — patients
 * who are expecting to be seen. So it refuses three situations outright rather
 * than doing half of it and reporting success:
 *
 *   the practice's LAST clinic   a practice with none cannot be booked into and
 *                                cannot sync. Delete the practice instead.
 *
 *   live bookings                people are expecting to be seen. `?force=true`
 *                                is available for the case where the clinic has
 *                                genuinely closed, and it says how many.
 *
 *   a login pinned ONLY here     that person would be left with an empty scope,
 *                                which on a non-owner means access to nothing.
 *                                They can still sign in, so it looks broken
 *                                rather than restricted. The response names
 *                                them, so it is fixable in one step.
 *
 * A login scoped to this clinic AND others is simply unpinned from this one —
 * no confirmation needed, because nothing about their access breaks.
 */
router.delete(
  "/clinics/:id",
  handler(async (req, res) => {
    const clinic = await Clinic.findById(parseObjectId(req.params.id, "id")).catch(() => null);
    if (!clinic) throw errors.clinicNotFound();

    const force = parseBoolean(req.query.force, false);

    const siblings = await Clinic.countDocuments({ ownerId: clinic.ownerId });
    if (siblings <= 1) {
      throw errors.validation(
        "This is the practice's only clinic, and a practice with none cannot be booked into or synced.",
        { clinic: "cannot delete the last one" }
      );
    }

    /*
     * Counted before anything is removed. Reporting "deleted" and then
     * discovering forty people had appointments is not a recoverable mistake —
     * the slots are gone and nobody knows who to ring.
     */
    const live = await Slot.aggregate([
      { $match: { clinicId: clinic._id } },
      { $unwind: "$bookings" },
      { $match: { "bookings.status": { $in: Slot.ACTIVE_STATUSES } } },
      { $count: "n" },
    ]);
    const liveBookings = live.length ? live[0].n : 0;
    if (liveBookings > 0 && !force) {
      throw errors.validation(
        `This clinic has ${liveBookings} live booking${liveBookings === 1 ? "" : "s"}. Deleting it cancels ${liveBookings === 1 ? "that appointment" : "those appointments"} with no notice to the patient.`,
        { bookings: String(liveBookings), hint: "send ?force=true to delete anyway" }
      );
    }

    /* Logins whose ONLY clinic is this one. Named, not counted — "2 logins
     * would be left with nothing" sends somebody hunting for which two. */
    const stranded = await Account.find({
      module: "clinic",
      ownerId: clinic.ownerId,
      role: { $ne: "owner" },
      clinicIds: { $size: 1, $all: [clinic._id] },
    }).select("name email");

    if (stranded.length > 0) {
      throw errors.validation(
        `${stranded.length} login${stranded.length === 1 ? "" : "s"} can open only this clinic and would be left with access to nothing. Give ${stranded.length === 1 ? "them" : "them"} another clinic first.`,
        { logins: stranded.map((a) => `${a.name} <${a.email}>`).join(", ") }
      );
    }

    const slots = await Slot.countDocuments({ clinicId: clinic._id });

    /*
     * Unpinned from everyone who could reach it BEFORE the clinic goes, so
     * there is no window in which a session holds a scope naming a clinic that
     * no longer exists. `$pull` leaves their other clinics alone.
     */
    await Account.updateMany(
      { module: "clinic", ownerId: clinic.ownerId, clinicIds: clinic._id },
      { $pull: { clinicIds: clinic._id } }
    );
    /* Anyone whose DEFAULT was this clinic falls back to their first remaining
     * one — a default pointing at a deleted clinic opens on nothing. */
    const affected = await Account.find({
      module: "clinic",
      ownerId: clinic.ownerId,
      clinicId: clinic._id,
    });
    for (const account of affected) {
      account.clinicId = account.clinicIds.length ? account.clinicIds[0] : null;
      /* Their reachable set changed, so the token describing it must not
       * outlive the change. */
      account.tokenVersion = (account.tokenVersion || 0) + 1;
      await account.save();
    }

    await Promise.all([
      Slot.deleteMany({ clinicId: clinic._id }),
      ClinicLicense.deleteMany({ clinicId: clinic._id }),
    ]);
    await Clinic.deleteOne({ _id: clinic._id });

    return res.json({
      deleted: true,
      id: String(clinic._id),
      name: clinic.name,
      /* What actually went, so the console can say so rather than "done". */
      removed: { slots, liveBookings, loginsUnpinned: affected.length },
    });
  })
);

module.exports = router;
