const express = require("express");

const Clinic = require("../models/Clinic");
const Slot = require("../models/Slot");
const { errors, handler } = require("../../../utils/apiError");
const {
  parseText,
  parseDateOnly,
  parseObjectId,
  parseOptionalText,
  parseSlug,
  isNil,
} = require("../../../utils/validate");
const {
  publicBookingRateLimit,
  publicCancelRateLimit,
  publicReadRateLimit,
} = require("../../../middleware/rateLimit");
const { todayIn, timeNowIn, isFuture } = require("../utils/clinicTime");
const { claimPlace, releasePlace, nextRef, parseMobileDigits } = require("./slots");
const serialise = require("../utils/serialise");

const router = express.Router();

/*
 * The patient-facing API. No authentication of any kind, by design.
 *
 * A patient has no account, no password and no session — asking somebody to
 * register before they can book an appointment is how a clinic loses the
 * booking. A booking made here is addressed afterwards by its `publicRef`, 128
 * bits of randomness that is the only credential involved.
 *
 * Two rules run through every handler below:
 *
 * 1. Responses are built field by field by the serialisers, never spread from a
 *    stored document. A slot carries the clinic's capacity, its other patients'
 *    names and their telephone numbers; the patient gets a time and a doctor.
 *
 * 2. Time is checked at READ, in the clinic's own timezone, regardless of what
 *    is stored. The TTL index tidies expired slots about once a minute and is
 *    explicitly not a guarantee — this filter is what stops anybody booking
 *    yesterday in the meantime.
 */

/*
 * Find a clinic by its public address.
 *
 * A deactivated clinic is a 404 — the same answer a slug nobody has ever
 * registered gets. Anything else would confirm which clinics exist on the
 * platform to anybody prepared to guess names.
 *
 * `bookingEnabled` is deliberately NOT part of this check: a clinic that has
 * switched off online booking still has a page worth showing, with its address
 * and telephone number on it. The booking endpoint refuses; the page does not
 * vanish.
 */
async function findClinic(slug) {
  let normalised;
  try {
    normalised = parseSlug(slug);
  } catch (err) {
    throw errors.clinicNotFound();
  }

  const clinic = await Clinic.findOne({ slug: normalised, isActive: true });
  if (!clinic) throw errors.clinicNotFound();
  return clinic;
}

/* ================= GET /api/v1/public/clinics =================
 * The booking directory — where the patient journey actually starts.
 */
router.get(
  "/clinics",
  publicReadRateLimit,
  handler(async (req, res) => {
    /* Cacheable at the edge for a minute. The list changes when a clinic signs
     * up, which is rare, and this is the first request of every patient
     * session. */
    res.setHeader("Cache-Control", "public, max-age=60");

    const query = { isActive: true, bookingEnabled: true };

    if (!isNil(req.query.city)) {
      const city = parseOptionalText(req.query.city, "city", 80);
      query.city = { $regex: `^${escapeRegex(city)}$`, $options: "i" };
    }
    if (!isNil(req.query.q)) {
      const term = parseOptionalText(req.query.q, "q", 80);
      query.name = { $regex: escapeRegex(term), $options: "i" };
    }

    const clinics = await Clinic.find(query)
      .select("name slug city address phone doctors timezone")
      .sort({ name: 1 })
      .limit(200);

    /*
     * ================= listed because it has SLOTS =================
     *
     * This filter used to be `clinic.doctors.some(visible)`, and it returned an
     * empty directory for every practice on the platform.
     *
     * The reason is architectural, not a bug in the filter: doctors are records
     * in the practice's own Excel workbook. This server has never seen them, so
     * `clinic.doctors` is empty for every self-serve clinic and the condition
     * could never be true. Four live clinics, all active, all with booking
     * enabled, and `{"clinics":[]}`.
     *
     * A clinic is bookable if it has bookable TIMES, which is both derivable
     * here and a better question. Slots carry denormalised doctor snapshots
     * precisely so the public side can work without the workbook — so the
     * doctors come from the same place.
     *
     * It also fixes the failure the old comment was worried about, properly: a
     * clinic that has signed up but published nothing is not listed, because a
     * patient who taps it finds no times.
     */
    const summaries = await bookableSummaries(clinics);

    const bookable = clinics.filter(
      (clinic) =>
        summaries.has(String(clinic._id)) ||
        /* An admin-managed clinic with a real embedded doctor list still lists
         * on that basis, so nothing that worked before stops working. */
        (clinic.doctors || []).some((d) => d.isPubliclyVisible !== false)
    );

    /*
     * Still an allowlist, and still unauthenticated and crawlable. The three
     * added fields are counts and a date — what a directory needs in order to
     * say "3 doctors, next free tomorrow" without a request per clinic.
     */
    return res.json({
      clinics: bookable.map((clinic) => {
        const summary = summaries.get(String(clinic._id));
        return {
          id: String(clinic._id),
          name: clinic.name,
          slug: clinic.slug,
          city: clinic.city || "",
          address: clinic.address || "",
          /* Already public on the clinic's own page, and the one thing a
           * patient looking at a full day needs. */
          phone: clinic.phone || "",
          doctorCount: summary ? summary.doctorIds.length : 0,
          openSlots: summary ? summary.openSlots : 0,
          nextAvailable: summary ? summary.nextDate : null,
        };
      }),
    });
  })
);

/* ================= GET /api/v1/public/clinics/:slug ================= */
router.get(
  "/clinics/:slug",
  publicReadRateLimit,
  handler(async (req, res) => {
    const clinic = await findClinic(req.params.slug);

    /* The doctors this clinic actually has bookable times for. Empty embedded
     * list is the normal case — see the note on publicClinic. */
    const summary = (await bookableSummaries([clinic])).get(String(clinic._id));

    return res.json({
      clinic: serialise.publicClinic(clinic, {
        doctors: (summary ? summary.doctors : []).map(serialise.publicDoctorFromSlot),
      }),
    });
  })
);

/* ================= GET /api/v1/public/clinics/:slug/slots =================
 * ?doctorId=&date=  or  ?doctorId=&from=&to=
 *
 * Only what is actually bookable: open, not full, not blocked, not past. The
 * doctor rides along on each slot, because omitting `doctorId` returns every
 * doctor's times and the page groups them.
 */
router.get(
  "/clinics/:slug/slots",
  publicReadRateLimit,
  handler(async (req, res) => {
    const clinic = await findClinic(req.params.slug);
    const today = todayIn(clinic.timezone);

    let from;
    let to;
    if (!isNil(req.query.date)) {
      from = parseDateOnly(req.query.date, "date");
      to = from;
    } else {
      from = isNil(req.query.from) ? today : parseDateOnly(req.query.from, "from");
      to = isNil(req.query.to) ? from : parseDateOnly(req.query.to, "to");
    }
    /* A range the wrong way round is a client bug, and is refused before the
     * clamp so the error only ever fires on what the caller actually sent. */
    if (to < from) {
      throw errors.validation("That date range is the wrong way round.", {
        to: "must be on or after from",
      });
    }
    /*
     * Clamped to today, and a range entirely in the past answers with an empty
     * list rather than an error — clicking backwards in a date picker is an
     * ordinary thing to do, and a 400 there turns a stray tap into a
     * broken-looking page.
     */
    if (from < today) from = today;
    if (to < from) return res.json({ slots: [] });

    /*
     * ================= ?includeFull=1 =================
     *
     * Off by default, because most callers want a list of times a patient can
     * take and nothing else.
     *
     * On, the full ones come too, with `available: 0`. That is what lets a
     * booking page draw a GRID rather than a list — and a grid is the only
     * honest picture of a busy clinic. Filtering them out means a doctor whose
     * 09:00 through 10:30 are gone appears to start at 10:45, which a patient
     * reads as "he comes in late" and not "the morning has gone", so they go
     * looking at another clinic instead of taking the 10:45.
     *
     * What does NOT change is what a full slot reveals: still no `bookings`,
     * still no `capacity`, still no `booked` — see serialise.publicSlotV4. A
     * patient learns that a time is taken, which they would learn by trying to
     * take it, and nothing whatever about who has it.
     *
     * `isBlocked` stays excluded in both modes. A blocked slot is not a booking:
     * it is the clinic saying "not this time", and showing it as a taken
     * appointment would misrepresent how busy they are.
     */
    const includeFull = req.query.includeFull === "1" || req.query.includeFull === "true";

    const query = {
      clinicId: clinic._id,
      date: { $gte: from, $lte: to },
      isBlocked: false,
      /* Excluded in the database rather than after the fact: `available` is
       * stored precisely so this can be an indexed comparison rather than a
       * pass over every slot in Node. */
      ...(includeFull ? {} : { available: { $gt: 0 } }),
    };
    if (!isNil(req.query.doctorId)) {
      query["doctor.id"] = parseText(req.query.doctorId, "doctorId", { max: 80 });
    }

    const slots = await Slot.find(query).sort({ date: 1, startTime: 1 }).limit(2000);

    /* The read-time expiry filter. The TTL is a tidy-up, not a guarantee. */
    const bookable = slots.filter((s) => isFuture(clinic.timezone, s.date, s.startTime));

    return res.json({ slots: bookable.map(serialise.publicSlotV4) });
  })
);

/* ================= POST /api/v1/public/clinics/:slug/slots/:slotId/book =================
 * The patient's phone.
 */
router.post(
  "/clinics/:slug/slots/:slotId/book",
  publicBookingRateLimit,
  handler(async (req, res) => {
    const clinic = await findClinic(req.params.slug);

    if (clinic.bookingEnabled === false) {
      throw errors.bookingClosed(
        "This clinic is not taking online bookings at the moment. Please call them."
      );
    }

    const slotId = parseObjectId(req.params.slotId, "slotId");

    /* Everything a patient is asked for, and no more. No address, no date of
     * birth, no history — they are not registering as a patient. */
    const patientName = parseText(req.body.patientName, "patientName", {
      max: 120,
      label: "Your name",
    });
    const patientMobile = parseMobileDigits(req.body.patientMobile);
    const notes = parseOptionalText(req.body.notes, "notes", 500);

    const booking = {
      ref: await nextRef(clinic.ownerId, todayIn(clinic.timezone)),
      publicRef: Slot.newPublicRef(),
      patientName,
      patientMobile,
      patientId: null,
      serviceName: "",
      notes,
      source: "public",
      status: "booked",
      bookedAt: new Date(),
    };

    /*
     * ================= one atomic conditional update =================
     *
     * Two patients tapping the last 10:15 at the same moment is not a rare
     * case — it is what happens when a clinic posts its link to a WhatsApp
     * group. The filter IS the concurrency control; see claimPlace in
     * routes/slots.js.
     *
     * The date bound is inside the filter rather than checked beforehand,
     * because the TTL sweeper runs about once a minute: without it a slot the
     * sweeper has not reached is still bookable.
     */
    const slot = await claimPlace(
      slotId,
      { ownerId: clinic.ownerId, clinicId: clinic._id },
      booking,
      { date: { $gte: todayIn(clinic.timezone) } }
    );

    /*
     * A null result means blocked, full, past or gone.
     *
     * Deliberately NOT told apart. Every one of those branches ends in "choose
     * another time", and distinguishing them on an unauthenticated endpoint
     * would tell a stranger which of a clinic's times are full — which is the
     * clinic's business, not the internet's.
     */
    if (!slot) throw errors.slotUnavailable();

    /*
     * A last read-time check on the slot we just claimed.
     *
     * The `$gte: today` filter above catches a past DAY, but not a time earlier
     * today. Rather than a second database round trip inside the claim, the
     * place is given back if the time has passed — the window is a fraction of
     * a second and the alternative is a filter that cannot express it.
     */
    if (!isFuture(clinic.timezone, slot.date, slot.startTime)) {
      await releasePlace(
        { _id: slot._id },
        { publicRef: booking.publicRef },
        { cancelledBy: "clinic", cancelReason: "time had passed" }
      );
      throw errors.bookingClosed("That appointment time has already passed.");
    }

    return res.status(201).json({
      ...serialise.bookingConfirmation(booking, slot),
      /* The link the patient cancels with. Returned exactly once — see the
       * model for why it is not the sequential `ref`. */
      cancelUrl: cancelUrlFor(booking.publicRef),
      whatsappUrl: whatsappLink(slot, booking),
    });
  })
);

/* ================= GET /api/v1/public/bookings/:publicRef =================
 * The patient's own booking.
 */
router.get(
  "/bookings/:publicRef",
  publicReadRateLimit,
  handler(async (req, res) => {
    const { slot, booking } = await findBooking(req.params.publicRef);
    return res.json({
      ...serialise.bookingConfirmation(booking, slot),
      cancelUrl: cancelUrlFor(booking.publicRef),
    });
  })
);

/* ================= POST /api/v1/public/bookings/:publicRef/cancel ================= */
router.post(
  "/bookings/:publicRef/cancel",
  publicCancelRateLimit,
  handler(async (req, res) => {
    const { slot, booking } = await findBooking(req.params.publicRef);

    /* Already cancelled. Not an error worth showing anybody — the caller's
     * intent is satisfied, and two taps on a slow connection is the usual
     * cause. */
    if (booking.status === "cancelled") {
      return res.json({ ...serialise.bookingConfirmation(booking, slot), cancelled: true });
    }

    /*
     * Too late once the time has passed. A cancellation after the fact is a
     * no-show, and a no-show is something the clinic records about a patient
     * who did not arrive — letting the patient reclassify it from their phone
     * at four in the afternoon would quietly erase that.
     */
    if (!isFuture(slot.clinicTimezone, slot.date, slot.startTime)) {
      throw errors.bookingClosed(
        "That appointment time has passed. Please call the clinic."
      );
    }

    const updated = await releasePlace(
      { _id: slot._id },
      { publicRef: booking.publicRef },
      { cancelledBy: "patient", cancelReason: parseOptionalText(req.body.reason, "reason", 300) }
    );

    /* Lost a race with the clinic cancelling it first. The patient's intent is
     * still satisfied. */
    const row = updated
      ? updated.bookings.find((b) => b.publicRef === booking.publicRef)
      : booking;

    return res.json({
      ...serialise.bookingConfirmation(row, updated || slot),
      cancelled: true,
    });
  })
);

/* ================= helpers ================= */

/*
 * Look a booking up by the patient's own credential.
 *
 * Length-checked before it reaches the database: a publicRef is 22 base64url
 * characters, and anything else is a probe. Answering a probe with a query is a
 * free lookup for whoever is probing.
 */
async function findBooking(rawRef) {
  const publicRef = String(rawRef || "").trim();
  if (publicRef.length < 16 || publicRef.length > 64) throw errors.bookingNotFound();

  const slot = await Slot.findOne({ "bookings.publicRef": publicRef });
  if (!slot) throw errors.bookingNotFound();

  const booking = (slot.bookings || []).find((b) => b.publicRef === publicRef);
  if (!booking) throw errors.bookingNotFound();

  /*
   * The clinic's timezone is not on the slot snapshot — it is provisioning
   * data, not something a booking page renders — so it is fetched for the
   * expiry comparison. One extra read on a page a patient opens once.
   */
  const clinic = await Clinic.findById(slot.clinicId).select("timezone isActive");
  if (!clinic || !clinic.isActive) throw errors.bookingNotFound();
  slot.clinicTimezone = clinic.timezone;

  return { slot, booking };
}

function cancelUrlFor(publicRef) {
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/booking/${publicRef}` : null;
}

/*
 * A wa.me deep link the patient can tap to message the clinic about this
 * booking. No message is sent by this server and no provider is involved — it
 * is a link, which is why the whole product needs no WhatsApp integration.
 */
function whatsappLink(slot, booking) {
  const digits = String(slot.clinic.phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const number = digits.length === 10 ? `91${digits}` : digits;
  const text = encodeURIComponent(
    `Hello ${slot.clinic.name}, this is ${booking.patientName}. My booking is ${booking.ref} on ${slot.date} at ${slot.startTime}.`
  );
  return `https://wa.me/${number}?text=${text}`;
}

/* A search box is a caller-supplied pattern. Unescaped, ".*" from a stranger is
 * a scan of the whole collection on an unauthenticated endpoint. */
/*
 * ================= what is actually bookable, per clinic =================
 *
 * One aggregation over slots, answering three things the public side cannot get
 * anywhere else: which clinics have times, which doctors sit in them, and when
 * the next free one is.
 *
 * ================= why it groups by timezone =================
 *
 * "Still in the future" is not a property of a date — it is a comparison
 * against a wall clock, and the clinics on this platform are not all on one.
 * Matching `date >= today` alone would list a clinic whose only remaining
 * slots were this morning's, and send the patient to a page with nothing on it.
 *
 * So clinics are bucketed by their IANA zone and one aggregation runs per
 * bucket with that zone's today and its current time. In practice that is a
 * single bucket — every clinic here is Asia/Kolkata — and it stays correct the
 * day one is not.
 *
 * The date/time comparison is a string comparison, which is exact because both
 * formats are zero-padded and big-endian: "09:15" < "10:00" as text and as
 * time. The same reasoning as isFuture(), pushed into the database so that
 * "which clinics have anything?" is one round trip rather than one per clinic.
 */
async function bookableSummaries(clinics) {
  const byZone = new Map();
  for (const clinic of clinics) {
    const zone = clinic.timezone || "Asia/Kolkata";
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(clinic._id);
  }

  const out = new Map();

  for (const [zone, ids] of byZone) {
    const today = todayIn(zone);
    const now = timeNowIn(zone);

    const rows = await Slot.aggregate([
      {
        $match: {
          clinicId: { $in: ids },
          isBlocked: false,
          available: { $gt: 0 },
          /* Today's remaining times, and every later day. */
          $or: [{ date: { $gt: today } }, { date: today, startTime: { $gt: now } }],
        },
      },
      { $sort: { date: 1, startTime: 1 } },
      {
        $group: {
          _id: "$clinicId",
          /* First by the sort above, so this is genuinely the next free time. */
          nextDate: { $first: "$date" },
          nextTime: { $first: "$startTime" },
          openSlots: { $sum: 1 },
          /* One entry per doctor, carrying the snapshot the page renders. */
          doctors: { $addToSet: "$doctor" },
        },
      },
    ]);

    for (const row of rows) {
      /*
       * `$addToSet` is by whole-object equality, so a doctor whose fee changed
       * midway through the fortnight appears twice. Collapsed by id, keeping
       * the fullest snapshot — a later publish is the more current one, and a
       * duplicated name in a doctor list is the sort of thing a patient reads
       * as a broken page.
       */
      const byId = new Map();
      for (const snapshot of row.doctors) {
        if (!snapshot || !snapshot.id) continue;
        const seen = byId.get(snapshot.id);
        if (!seen || (!seen.specialization && snapshot.specialization)) byId.set(snapshot.id, snapshot);
      }

      const doctors = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));

      out.set(String(row._id), {
        nextDate: row.nextDate,
        nextTime: row.nextTime,
        openSlots: row.openSlots,
        doctors,
        doctorIds: doctors.map((d) => d.id),
      });
    }
  }

  return out;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = router;
