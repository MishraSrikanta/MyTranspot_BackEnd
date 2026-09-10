const express = require("express");

const Slot = require("../models/Slot");
const Clinic = require("../models/Clinic");
const Counter = require("../../../models/Counter");
const audit = require("../../../utils/audit");
const { errors, handler } = require("../../../utils/apiError");
const {
  parseText,
  parseOptionalText,
  parseDateOnly,
  parseTime,
  parseInteger,
  parseAmount,
  parseBoolean,
  parseEnum,
  parseObjectId,
  isNil,
} = require("../../../utils/validate");
const { requireAuth, requireModule } = require("../../../middleware/auth");
const {
  resolveClinicScope,
  requireSingleClinic,
  requireClinicPermission,
  requireClinicOwner,
} = require("../../../middleware/clinicScope");
const {
  todayIn,
  isFuture,
  slotExpiresAt,
  eachDate,
  weekdayOf,
  expandTimes,
} = require("../utils/clinicTime");
const { hasPermission } = require("../permissions");
const serialise = require("../utils/serialise");

const router = express.Router();

/*
 * Slots, and the bookings inside them.
 *
 * ================= cloud only =================
 *
 * No slot, schedule or booking is written to the clinic's workbook, read from
 * it, or reconciled against it. The workbook keeps the practice's records —
 * patients, doctors, services, tests, reports, invoices — and nothing about who
 * is booked when.
 *
 * That is why `POST /sync/slots`, `GET /sync/bookings` and the acknowledgement
 * endpoint are gone rather than deprecated: there is nothing to publish and
 * nothing to pull, because the slot was never local.
 *
 * ================= and why one document holds both =================
 *
 * See models/Slot.js. In short: every question here is "what is free, and who
 * is in the rest?", and with the bookings inside the slot that is one read and
 * one atomic write instead of a join and a race.
 */

router.use(requireAuth, requireModule("clinic"), resolveClinicScope);

/* How many slots one call may expand into. A fortnight for six doctors at
 * fifteen-minute intervals is roughly eight hundred, so the cap is above the
 * real workload and well below anything that risks a serverless time limit
 * halfway through a batch. */
const MAX_EXPANSION = 1000;

/* ================= POST /api/v1/slots =================
 * Create slots from a pattern.
 */
router.post(
  "/",
  requireClinicPermission("slots.manage"),
  /* An owner must name the branch. The frontend renders an inline clinic picker
   * on CLINIC_REQUIRED rather than losing the form, so this is a supported
   * answer and not a failure. */
  requireSingleClinic,
  handler(async (req, res) => {
    const clinic = await Clinic.findOne({ _id: req.clinicId, ownerId: req.ownerId });
    if (!clinic) throw errors.clinicNotFound();

    /*
     * ================= the snapshots are required =================
     *
     * Not defaulted from the clinic row, and not optional. This server cannot
     * see the workbook, so if the doctor's name does not arrive here it does
     * not exist anywhere the booking page can reach — and the slot would render
     * as a time with nobody attached to it.
     *
     * Refusing is better than creating slots that cannot draw a booking page.
     */
    const doctor = parseDoctor(req.body.doctor);
    const clinicSnapshot = parseClinicSnapshot(req.body.clinic, clinic);

    const from = parseDateOnly(req.body.from, "from");
    const to = isNil(req.body.to) ? from : parseDateOnly(req.body.to, "to");
    if (to < from) {
      throw errors.validation("That date range is the wrong way round.", {
        to: "must be on or after from",
      });
    }

    const startTime = parseTime(req.body.startTime, "startTime");
    const endTime = parseTime(req.body.endTime, "endTime");
    if (endTime <= startTime) {
      throw errors.validation("The day must end after it starts.", {
        endTime: "must be after startTime",
      });
    }

    const slotMinutes = parseInteger(req.body.slotMinutes, "slotMinutes", {
      min: 5,
      max: 240,
      fallback: 15,
    });
    /*
     * Capacity must be at least one. A zero-capacity slot is the "why can
     * nobody book this?" support call — it renders on the grid, looks
     * available, and refuses every patient.
     */
    const capacity = parseInteger(req.body.capacity, "capacity", {
      min: 1,
      max: 100,
      fallback: 1,
    });

    const breakStart = isNil(req.body.breakStart)
      ? null
      : parseTime(req.body.breakStart, "breakStart");
    const breakEnd = isNil(req.body.breakEnd) ? null : parseTime(req.body.breakEnd, "breakEnd");
    /* Half a break is ignored rather than guessed at — a start with no end
     * would otherwise silently swallow the rest of the day. */
    const hasBreak = !!(breakStart && breakEnd && breakEnd > breakStart);

    const weekdays = Array.isArray(req.body.weekdays)
      ? req.body.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : null;
    const skipDates = new Set(
      (Array.isArray(req.body.skipDates) ? req.body.skipDates : []).map((d) =>
        parseDateOnly(d, "skipDates")
      )
    );

    const times = expandTimes({
      startTime,
      endTime,
      slotMinutes,
      breakStart: hasBreak ? breakStart : null,
      breakEnd: hasBreak ? breakEnd : null,
    });
    if (!times.length) {
      throw errors.validation("That pattern produces no slots.", {
        slotMinutes: "does not fit between startTime and endTime",
      });
    }

    const today = todayIn(clinic.timezone);
    const dates = eachDate(from, to);

    const wanted = [];
    let skipped = 0;

    for (const date of dates) {
      /* A day the doctor is on leave, or one the pattern does not cover. */
      if (skipDates.has(date)) {
        skipped += times.length;
        continue;
      }
      if (weekdays && !weekdays.includes(weekdayOf(clinic.timezone, date))) {
        skipped += times.length;
        continue;
      }

      for (const time of times) {
        /* A slot in the past is skipped rather than refused: a fortnight
         * beginning today legitimately contains this morning, and rejecting the
         * whole call over it would mean the clinic could never publish "from
         * today". */
        if (!isFuture(clinic.timezone, date, time.startTime)) {
          skipped += 1;
          continue;
        }
        wanted.push({ date, ...time });
      }
    }

    if (wanted.length > MAX_EXPANSION) {
      throw errors.payloadTooLarge(
        `That pattern makes ${wanted.length} slots. Publish at most ${MAX_EXPANSION} at a time — split the date range.`,
        { to: `range is too long; at most ${MAX_EXPANSION} slots per call` }
      );
    }

    /*
     * ================= idempotency =================
     *
     * Re-sending the same fortnight is the NORMAL case: the app does it
     * whenever a schedule changes. Existing rows are counted in `skipped` and
     * left exactly as they are — capacity, bookings and all.
     *
     * Deliberately NOT an upsert that overwrites. A republish that reset
     * `available` would hand out places already taken, and a republish that
     * reset `capacity` would undo a change reception made this morning.
     */
    const existing = await Slot.find({
      clinicId: clinic._id,
      "doctor.id": doctor.id,
      date: { $gte: from, $lte: to },
    }).select("date startTime");
    const taken = new Set(existing.map((s) => `${s.date} ${s.startTime}`));

    const retentionHours = clinic.retentionHours || 48;
    const documents = [];
    for (const row of wanted) {
      if (taken.has(`${row.date} ${row.startTime}`)) {
        skipped += 1;
        continue;
      }
      documents.push({
        ownerId: req.ownerId,
        clinicId: clinic._id,
        clinic: clinicSnapshot,
        doctor,
        date: row.date,
        startTime: row.startTime,
        endTime: row.endTime,
        capacity,
        booked: 0,
        available: capacity,
        isBlocked: false,
        bookings: [],
        expiresAt: slotExpiresAt(clinic.timezone, row.date, retentionHours),
      });
    }

    let created = [];
    /*
     * Writes that failed for a reason nobody asked for. Counted separately from
     * `skipped`, and the difference matters more than it looks — see below.
     */
    let failed = 0;

    if (documents.length) {
      /*
       * `ordered: false` so one collision cannot stop the rest. The unique
       * index is the real guard against a duplicate 10:15 — the `taken` set
       * above is an optimisation, and two publishes racing would slip past it.
       */
      try {
        created = await Slot.insertMany(documents, { ordered: false });
      } catch (err) {
        if (err.writeErrors) {
          created = err.insertedDocs || [];

          /*
           * ================= not every E11000 is a republish =================
           *
           * A duplicate key here has two completely different meanings, and
           * collapsing them into `skipped` cost a day of debugging.
           *
           * The benign one: two publishes raced, and the loser hit the unique
           * index on a slot the `taken` set had not yet seen. Nothing is
           * wrong; the slot exists, which is what the caller wanted.
           *
           * The other one: the write violated a constraint that has nothing to
           * do with this slot's identity. That is what happened in production —
           * a UNIQUE { clinicId, clientId } index left behind by the v2 schema,
           * on a field v4 documents do not have, so Mongo read it as null and
           * allowed ONE slot per clinic. Publishing a fortnight created one
           * slot and reported the other sixty-three as "already existed", which
           * is a sentence a clinic has no reason to disbelieve.
           *
           * So: a duplicate on a (date, startTime) this call did not already
           * know about is not "already existed". It is a failure, it is counted
           * as one, and it is logged with the index that rejected it — because
           * the only thing that will ever fix it is somebody reading that name.
           * See scripts/drop-stale-slot-indexes.js.
           */
          for (const writeError of err.writeErrors) {
            const document = documents[writeError.index];
            const identity = document ? `${document.date} ${document.startTime}` : "unknown";
            const isRepublish = writeError.code === 11000 && taken.has(identity);

            if (isRepublish) {
              skipped += 1;
              continue;
            }

            failed += 1;
            console.error(
              "[slots] insert rejected:",
              identity,
              `code=${writeError.code}`,
              writeError.errmsg || writeError.err?.errmsg || ""
            );
          }
        } else {
          throw err;
        }
      }
    }

    if (failed) {
      console.error(
        `[slots] ${failed} of ${documents.length} slots could not be written for ${doctor.name} ` +
          `(${from}..${to}). If the errors above name an index, the collection has a constraint ` +
          "the Slot model does not declare — run scripts/drop-stale-slot-indexes.js."
      );
    }

    audit.record(req, {
      action: "slot.create",
      entityType: "slot",
      clinicId: clinic._id,
      entityLabel: `${doctor.name} ${from}..${to}`,
      note: `created ${created.length}, skipped ${skipped}` + (failed ? `, FAILED ${failed}` : ""),
    });

    return res.status(201).json({
      created: created.length,
      skipped,
      /*
       * Additive, and deliberately always present: a client that shows "created
       * 1, skipped 63" reads as success, and the whole point of separating this
       * out is that somebody sees the number that is not zero.
       */
      failed,
      slots: created.map((s) => ({
        id: String(s._id),
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
      })),
    });
  })
);

/* ================= GET /api/v1/slots =================
 * ?clinicId=&date=&from=&to=&doctorId=
 */
router.get(
  "/",
  requireClinicPermission("slots.view"),
  handler(async (req, res) => {
    const query = { ownerId: req.ownerId, clinicId: { $in: req.clinicIds } };

    /*
     * A date or a range is REQUIRED. An unbounded slot query is a scan of every
     * slot every clinic has ever published, and it is the sort of request a
     * grid makes on every render.
     */
    if (!isNil(req.query.date)) {
      query.date = parseDateOnly(req.query.date, "date");
    } else if (!isNil(req.query.from) || !isNil(req.query.to)) {
      const from = isNil(req.query.from) ? null : parseDateOnly(req.query.from, "from");
      const to = isNil(req.query.to) ? null : parseDateOnly(req.query.to, "to");
      if (from && to && to < from) {
        throw errors.validation("That date range is the wrong way round.", {
          to: "must be on or after from",
        });
      }
      query.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    } else {
      throw errors.validation("Choose a date or a date range.", {
        date: "is required",
      });
    }

    /*
     * ================= doctorId is optional =================
     *
     * Omitting it returns EVERY doctor's slots, and that is the point of this
     * endpoint. The question at a reception desk is "when can this patient be
     * seen by anybody?", and answering it used to mean flipping through a
     * doctor dropdown one name at a time. The app groups the response by
     * doctor.
     */
    if (!isNil(req.query.doctorId)) {
      query["doctor.id"] = parseText(req.query.doctorId, "doctorId", { max: 80 });
    }

    const slots = await Slot.find(query).sort({ date: 1, startTime: 1 }).limit(2000);

    /*
     * The patient names come back only for somebody entitled to read them.
     *
     * A staff member with `slots.view` but not `appointments.view` — a doctor
     * looking at their own availability, say — gets the grid and the counts,
     * which is what they asked for, and no list of who is coming.
     */
    const withBookings = hasPermission(req.account, "appointments.view");

    return res.json({
      slots: slots.map((s) => serialise.slot(s, { bookings: withBookings })),
    });
  })
);

/* ================= PATCH /api/v1/slots/:id =================
 * Block, unblock, or change capacity.
 */
router.patch(
  "/:id",
  requireClinicPermission("slots.manage"),
  handler(async (req, res) => {
    const slot = await findScoped(req);

    if (!isNil(req.body.isBlocked)) {
      slot.isBlocked = parseBoolean(req.body.isBlocked, false);
      slot.blockReason = parseOptionalText(req.body.blockReason, "blockReason", 200);
    }

    if (!isNil(req.body.capacity)) {
      const capacity = parseInteger(req.body.capacity, "capacity", { min: 1, max: 100 });
      const active = slot.activeBookings().length;
      /*
       * Never below what is already booked.
       *
       * Reducing a slot from four to two while three patients hold it is a real
       * mistake, usually a typo — and clamping it silently would leave the
       * clinic believing they had reduced it while a fourth patient could still
       * be added by a cancellation.
       */
      if (capacity < active) throw errors.capacityBelowBooked(active);
      slot.capacity = capacity;
      slot.available = Math.max(0, capacity - active);
    }

    await slot.save();

    audit.record(req, {
      action: "slot.update",
      entityType: "slot",
      entityId: slot._id,
      clinicId: slot.clinicId,
      entityLabel: `${slot.date} ${slot.startTime}`,
      note: slot.isBlocked ? "blocked" : `capacity ${slot.capacity}`,
    });

    return res.json({ slot: serialise.slot(slot, { bookings: true }) });
  })
);

/* ================= DELETE /api/v1/slots =================
 * Bulk purge of past slots. Declared BEFORE /:id so "before" is never read as
 * an id.
 */
router.delete(
  "/",
  requireClinicPermission("appointments.purge"),
  requireClinicOwner,
  handler(async (req, res) => {
    const before = parseDateOnly(req.query.before, "before");
    const force = parseBoolean(req.query.force, false);

    const clinic = req.clinicId
      ? await Clinic.findOne({ _id: req.clinicId, ownerId: req.ownerId })
      : null;
    const today = todayIn(clinic ? clinic.timezone : "Asia/Kolkata");

    /*
     * The date must be in the past. "Delete everything from tomorrow" is never
     * something somebody meant, and on the most destructive endpoint here a
     * typo in a date field should not be able to empty a diary nobody has
     * worked yet.
     */
    if (before > today) {
      throw errors.validation("Choose a date in the past.", {
        before: "must be earlier than today",
      });
    }

    const scope = {
      ownerId: req.ownerId,
      clinicId: { $in: req.clinicIds },
      date: { $lt: before },
    };

    /*
     * Slots with live bookings are KEPT by default.
     *
     * Those are exactly the ones a clinic needs in order to work out what went
     * wrong on a day nobody closed out, and they are counted so the number is
     * visible rather than silently absent.
     */
    const liveFilter = {
      bookings: { $elemMatch: { status: { $in: Slot.ACTIVE_STATUSES } } },
    };

    const keptWithBookings = await Slot.countDocuments({ ...scope, ...liveFilter });
    const result = await Slot.deleteMany(
      force ? scope : { ...scope, ...{ $nor: [liveFilter] } }
    );

    audit.record(req, {
      action: "slot.purge",
      entityType: "slot",
      clinicId: req.clinicId || null,
      note: `deleted ${result.deletedCount} before ${before}${force ? " (forced)" : `, kept ${keptWithBookings} with live bookings`}`,
    });

    return res.json({
      deleted: result.deletedCount || 0,
      keptWithBookings: force ? 0 : keptWithBookings,
    });
  })
);

/* ================= DELETE /api/v1/slots/:id ================= */
router.delete(
  "/:id",
  requireClinicPermission("slots.manage"),
  handler(async (req, res) => {
    const slot = await findScoped(req);
    const force = parseBoolean(req.query.force, false);
    const active = slot.activeBookings().length;

    /*
     * Never silently delete a slot somebody is holding a confirmation for. The
     * count rides along so the UI can name it — the person clicking almost
     * never knows there is anybody in it.
     */
    if (active > 0 && !force) throw errors.slotHasBookings(active);
    if (active > 0 && force && req.account.role !== "owner") {
      throw errors.forbidden("Only the practice owner can delete a slot with bookings.");
    }

    /* Audited BEFORE the row goes: afterwards there is nothing left to
     * describe, and this log is the only recourse anybody has. */
    audit.record(req, {
      action: "slot.delete",
      entityType: "slot",
      entityId: slot._id,
      clinicId: slot.clinicId,
      entityLabel: `${slot.date} ${slot.startTime} · ${slot.doctor.name}`,
      note: active
        ? `FORCED with ${active} live booking(s): ${slot
            .activeBookings()
            .map((b) => `${b.patientName} ${b.patientMobile}`)
            .join(", ")}`
        : "no live bookings",
    });

    await Slot.deleteOne({ _id: slot._id });
    return res.json({ deleted: true });
  })
);

/* ================= POST /api/v1/slots/:id/book =================
 * Reception books somebody in.
 */
router.post(
  "/:id/book",
  requireClinicPermission("appointments.manage"),
  handler(async (req, res) => {
    const id = parseObjectId(req.params.id, "id");

    const patientName = parseText(req.body.patientName, "patientName", {
      max: 120,
      label: "Patient name",
    });
    const patientMobile = parseMobileDigits(req.body.patientMobile);
    const source = parseEnum(req.body.source, "source", Slot.SOURCES, {
      fallback: "reception",
    });

    /* Read first, only to know which practice's counter to draw the reference
     * from and to give a useful error. The claim below stands on its own. */
    const target = await Slot.findOne({
      _id: id,
      ownerId: req.ownerId,
      clinicId: { $in: req.clinicIds },
    }).select("clinicId date startTime");
    if (!target) throw errors.slotNotFound();

    const booking = {
      ref: await nextRef(req.ownerId, target.date),
      publicRef: Slot.newPublicRef(),
      patientName,
      patientMobile,
      /* An id from the clinic's own workbook. Stored opaquely — this server
       * never resolves it, and could not check it against anything. */
      patientId: parseOptionalText(req.body.patientId, "patientId", 80) || null,
      serviceName: parseOptionalText(req.body.serviceName, "serviceName", 160),
      notes: parseOptionalText(req.body.notes, "notes", 500),
      source,
      status: "booked",
      bookedAt: new Date(),
      bookedBy: req.account._id,
      bookedByName: req.account.name,
    };

    const slot = await claimPlace(id, { ownerId: req.ownerId, clinicIds: req.clinicIds }, booking);
    if (!slot) {
      /*
       * Blocked, full, past or gone. Told apart here — unlike on the public
       * path — because reception has a different next action for each: book
       * off-grid, unblock, or refresh a stale screen.
       */
      const current = await Slot.findOne({ _id: id, ownerId: req.ownerId }).select(
        "isBlocked available date startTime"
      );
      if (!current) throw errors.slotNotFound();
      if (current.isBlocked) throw errors.bookingClosed("That slot is blocked.");
      if (current.available <= 0) throw errors.slotFull();
      throw errors.bookingClosed("That appointment time has already passed.");
    }

    audit.record(req, {
      action: "booking.create",
      entityType: "slot",
      entityId: slot._id,
      clinicId: slot.clinicId,
      entityLabel: booking.ref,
      note: `${patientName} · ${slot.date} ${slot.startTime}`,
    });

    return res.status(201).json({
      booking: serialise.booking(booking),
      slot: serialise.slot(slot, { bookings: true }),
    });
  })
);

/* ================= POST /api/v1/slots/:id/bookings/:ref/cancel ================= */
router.post(
  "/:id/bookings/:ref/cancel",
  requireClinicPermission("appointments.cancel"),
  handler(async (req, res) => {
    const id = parseObjectId(req.params.id, "id");
    const ref = parseText(req.params.ref, "ref", { max: 60 });
    const reason = parseOptionalText(req.body.reason, "reason", 300);

    const slot = await releasePlace(
      { _id: id, ownerId: req.ownerId, clinicId: { $in: req.clinicIds } },
      { ref },
      { cancelledBy: "clinic", cancelReason: reason }
    );

    if (!slot) {
      /* Either there is no such booking, or it was already cancelled. The
       * second is not an error worth showing anybody — the caller's intent is
       * satisfied — so an existing cancelled row answers as success. */
      const existing = await Slot.findOne({
        _id: id,
        ownerId: req.ownerId,
        clinicId: { $in: req.clinicIds },
        "bookings.ref": ref,
      });
      if (!existing) throw errors.bookingNotFound();
      return res.json({ slot: serialise.slot(existing, { bookings: true }) });
    }

    audit.record(req, {
      action: "booking.cancel",
      entityType: "slot",
      entityId: slot._id,
      clinicId: slot.clinicId,
      entityLabel: ref,
      note: reason,
    });

    return res.json({ slot: serialise.slot(slot, { bookings: true }) });
  })
);

/* ================= the two shared writes ================= */

/*
 * ================= taking a place =================
 *
 * ONE atomic conditional update, and the filter IS the concurrency control.
 *
 * Two patients tapping the last 10:15 at the same moment is not a rare case —
 * it is what happens when a clinic posts its booking link to a WhatsApp group.
 * A read-then-write says yes to both, and the clinic finds out when they are
 * both standing at the desk.
 *
 * `available: { $gt: 0 }` is evaluated by the database as part of the match, so
 * of two requests arriving in the same millisecond exactly one can satisfy it.
 * The loser gets null.
 *
 * `date: { $gte: today }` is in the filter rather than checked beforehand
 * because the TTL runs about once a minute and is not a guarantee: without it,
 * a slot the sweeper has not reached yet is still bookable.
 */
async function claimPlace(id, scope, booking, extraFilter = {}) {
  return Slot.findOneAndUpdate(
    {
      _id: id,
      ownerId: scope.ownerId,
      ...(scope.clinicIds ? { clinicId: { $in: scope.clinicIds } } : {}),
      ...(scope.clinicId ? { clinicId: scope.clinicId } : {}),
      isBlocked: false,
      available: { $gt: 0 },
      ...extraFilter,
    },
    {
      $inc: { booked: 1, available: -1 },
      $push: { bookings: booking },
    },
    { returnDocument: "after" }
  );
}

/*
 * ================= giving one back =================
 *
 * The status change and the availability increment are ONE update. A
 * cancellation that does not free the place is a slot the clinic cannot resell,
 * and they will not notice until the day.
 *
 * `arrayFilters` with `status: "booked"` is what makes this idempotent: a
 * second cancellation of the same booking matches nothing, returns null, and
 * cannot drive `available` above `capacity`.
 */
function releasePlace(filter, match, { cancelledBy, cancelReason }) {
  return Slot.findOneAndUpdate(
    {
      ...filter,
      bookings: {
        $elemMatch: {
          ...(match.ref ? { ref: match.ref } : {}),
          ...(match.publicRef ? { publicRef: match.publicRef } : {}),
          /* Only a live booking releases a place. A cancelled one has already
           * given its place back. */
          status: { $in: Slot.ACTIVE_STATUSES },
        },
      },
    },
    {
      $set: {
        "bookings.$[b].status": "cancelled",
        "bookings.$[b].cancelledAt": new Date(),
        "bookings.$[b].cancelledBy": cancelledBy,
        "bookings.$[b].cancelReason": cancelReason || "",
        "bookings.$[b].tokenState": null,
      },
      $inc: { booked: -1, available: 1 },
    },
    {
      arrayFilters: [
        {
          ...(match.ref ? { "b.ref": match.ref } : {}),
          ...(match.publicRef ? { "b.publicRef": match.publicRef } : {}),
          "b.status": { $in: Slot.ACTIVE_STATUSES },
        },
      ],
      returnDocument: "after",
    }
  );
}

/* ================= helpers ================= */

async function findScoped(req) {
  const slot = await Slot.findOne({
    _id: parseObjectId(req.params.id, "id"),
    ownerId: req.ownerId,
    clinicId: { $in: req.clinicIds },
  });
  /*
   * A slot from another practice is simply not found — 404, never 403. A 403
   * confirms the id is real, which is how one practice enumerates another's
   * diary.
   */
  if (!slot) throw errors.slotNotFound();
  return slot;
}

/*
 * APT-2026-004411, through the atomic counter.
 *
 * Per practice and per year: the year makes the reference readable to whoever
 * is holding the paper, and lets the sequence restart each January without ever
 * colliding with last year's.
 */
async function nextRef(ownerId, date) {
  const year = Number(String(date).slice(0, 4));
  const seq = await Counter.nextSequence(ownerId, `booking:${year}`);
  return Counter.formatYearNumber("APT", year, seq);
}

/*
 * Ten digits, the Indian mobile format, normalised.
 *
 * Stricter than a general phone parser because this number is an IDENTITY here:
 * it is what reception searches their workbook for to link the booking to a
 * patient record. "+91 98765 43210" and "09876543210" are one person, and
 * storing both shapes is how the same patient fails to be found.
 */
function parseMobileDigits(raw) {
  const digits = String(raw ?? "").replace(/[\s-()]/g, "").replace(/^(\+91|91|0)/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw errors.validation("Please enter a valid 10-digit mobile number.", {
      patientMobile: "must be 10 digits",
    });
  }
  return digits;
}

function parseDoctor(raw) {
  if (isNil(raw) || typeof raw !== "object") {
    throw errors.validation("The doctor's details are required.", {
      doctor: "is required",
    });
  }
  return {
    /* The workbook's id for them. This server issues none of its own. */
    id: parseText(raw.id, "doctor.id", { max: 80, label: "Doctor" }),
    name: parseText(raw.name, "doctor.name", { max: 120, label: "Doctor name" }),
    specialization: parseOptionalText(raw.specialization, "doctor.specialization", 120),
    qualification: parseOptionalText(raw.qualification, "doctor.qualification", 160),
    consultationFee: parseAmount(raw.consultationFee, "doctor.consultationFee"),
  };
}

/*
 * The clinic snapshot. Falls back to the stored clinic field by field, so an
 * app that sends only a name still produces a slot with a working address on
 * its confirmation page.
 */
function parseClinicSnapshot(raw, clinic) {
  const given = raw && typeof raw === "object" ? raw : {};
  return {
    name: isNil(given.name)
      ? clinic.name
      : parseText(given.name, "clinic.name", { max: 120 }),
    code: parseOptionalText(given.code, "clinic.code", 12) || clinic.code || "",
    phone: parseOptionalText(given.phone, "clinic.phone", 20) || clinic.phone || "",
    address: parseOptionalText(given.address, "clinic.address", 300) || clinic.address || "",
    city: parseOptionalText(given.city, "clinic.city", 80) || clinic.city || "",
    /* Never taken from the request: the slug is this clinic's public address,
     * and a slot claiming a different one would send its confirmation link to
     * somebody else's page. */
    slug: clinic.slug,
  };
}

module.exports = router;
module.exports.claimPlace = claimPlace;
module.exports.releasePlace = releasePlace;
module.exports.nextRef = nextRef;
module.exports.parseMobileDigits = parseMobileDigits;
