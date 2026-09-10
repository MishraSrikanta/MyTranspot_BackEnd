const express = require("express");

const Slot = require("../models/Slot");
const Clinic = require("../models/Clinic");
const Counter = require("../../../models/Counter");
const audit = require("../../../utils/audit");
const { errors, handler } = require("../../../utils/apiError");
const { parseText, parseObjectId, isNil } = require("../../../utils/validate");
const { requireAuth, requireModule } = require("../../../middleware/auth");
const {
  resolveClinicScope,
  requireSingleClinic,
  requireClinicPermission,
} = require("../../../middleware/clinicScope");
const { todayIn } = require("../utils/clinicTime");
const serialise = require("../utils/serialise");

const router = express.Router();

/*
 * The waiting room.
 *
 * ================= there is no Token collection, and no Appointment one =================
 *
 * A token is a position an existing booking holds in today's queue. The booking
 * itself lives inside its slot (see models/Slot.js), so the queue is a
 * projection of today's slots for one clinic — one query, no joins.
 *
 * Modelling tokens separately would mean two rows per visit and a standing
 * question about what to do when they disagree. Modelling appointments
 * separately, which v3 did, meant a join on the busiest screen in the clinic.
 *
 * ================= the day is the clinic's, not the server's =================
 *
 * "Today" is computed in the clinic's own timezone. A queue that rolled over at
 * half past five in the morning — which is what UTC midnight is in India —
 * would empty the waiting room while people were sitting in it.
 */

router.use(requireAuth, requireModule("clinic"), resolveClinicScope);

/*
 * Today's slots for one clinic, with the bookings inside them.
 *
 * Everything below works from this: the queue is not a separate thing to keep
 * in step, it is a different way of reading the same documents the grid shows.
 */
async function loadDay(req, { doctorId } = {}) {
  const clinic = await Clinic.findOne({ _id: req.clinicId, ownerId: req.ownerId });
  if (!clinic) throw errors.clinicNotFound();

  const date = todayIn(clinic.timezone);
  const query = { ownerId: req.ownerId, clinicId: clinic._id, date };
  if (doctorId) query["doctor.id"] = doctorId;

  const slots = await Slot.find(query).sort({ startTime: 1 });
  return { clinic, date, slots };
}

/*
 * Every booking in the day, flattened, with the slot it came from attached.
 *
 * Cancelled rows are dropped here — nobody is waiting — but they are still IN
 * the slot, which is what lets the grid show that somebody cancelled rather
 * than that nobody ever booked.
 */
function queueEntries(slots) {
  const out = [];
  for (const slot of slots) {
    for (const booking of slot.bookings || []) {
      if (booking.status === "cancelled") continue;
      out.push({ slot, booking });
    }
  }
  /*
   * Ordered by the token number, falling back to the slot time for anybody not
   * yet checked in.
   *
   * They are usually the same order, and when they are not, the number is what
   * the waiting room believes: a patient holding A-014 expects to be called
   * after A-013, whatever the timestamps say about a correction somebody made.
   */
  return out.sort((a, b) => {
    const an = a.booking.tokenNumber || "~";
    const bn = b.booking.tokenNumber || "~";
    if (an !== bn) return an < bn ? -1 : 1;
    return a.slot.startTime < b.slot.startTime ? -1 : 1;
  });
}

const view = ({ slot, booking }) => ({
  ...serialise.booking(booking),
  slotId: String(slot._id),
  date: slot.date,
  time: slot.startTime,
  doctor: { id: slot.doctor.id, name: slot.doctor.name },
});

/* ================= GET /api/v1/tokens/queue =================
 * ?doctorId=
 */
router.get(
  "/queue",
  requireClinicPermission("tokens.view"),
  requireSingleClinic,
  handler(async (req, res) => {
    const doctorId = isNil(req.query.doctorId)
      ? null
      : parseText(req.query.doctorId, "doctorId", { max: 80 });
    const { clinic, date, slots } = await loadDay(req, { doctorId });

    const entries = queueEntries(slots);
    const byState = (state) => entries.filter((e) => e.booking.tokenState === state);

    const serving = entries.find((e) => e.booking.tokenState === "serving") || null;
    const waiting = byState("waiting");
    const done = byState("done");

    return res.json({
      date,
      clinicId: String(clinic._id),
      current: serving ? view(serving) : null,
      /* Who the next press of the button calls, so the screen can name them
       * before it happens rather than after. */
      next: waiting.length ? view(waiting[0]) : null,
      waiting: waiting.map(view),
      held: byState("held").map(view),
      skipped: byState("skipped").map(view),
      completedCount: done.length,
      /* Not yet checked in — the rest of the day's diary, which the desk needs
       * beside the queue to know who has not arrived. */
      expected: entries.filter((e) => !e.booking.tokenNumber).map(view),
      averageWaitMinutes: averageWait(done.map((e) => e.booking)),
    });
  })
);

/* ================= POST /api/v1/tokens/issue =================
 * Check a patient in and hand them a number.
 */
router.post(
  "/issue",
  requireClinicPermission("tokens.manage"),
  requireSingleClinic,
  handler(async (req, res) => {
    const clinic = await Clinic.findOne({ _id: req.clinicId, ownerId: req.ownerId });
    if (!clinic) throw errors.clinicNotFound();

    const slotId = parseObjectId(req.body.slotId, "slotId");
    const ref = parseText(req.body.ref, "ref", { max: 60 });

    const slot = await Slot.findOne({
      _id: slotId,
      ownerId: req.ownerId,
      clinicId: clinic._id,
    });
    if (!slot) throw errors.slotNotFound();

    const booking = (slot.bookings || []).find((b) => b.ref === ref);
    if (!booking) throw errors.bookingNotFound();

    /* Already holds one. Returned rather than re-issued: a second press of
     * Check In must not hand the same patient two numbers. */
    if (booking.tokenNumber) {
      return res.json({ booking: serialise.booking(booking), slotId: String(slot._id) });
    }
    if (booking.status === "cancelled") {
      throw errors.bookingClosed("That booking was cancelled.");
    }

    /*
     * Only today's bookings can be checked in.
     *
     * The queue is a projection of ONE day, so a token issued against
     * tomorrow's slot would put that patient in a queue nobody can see, holding
     * a number that will collide with tomorrow's A-001 when it is really
     * issued.
     */
    const today = todayIn(clinic.timezone);
    if (slot.date !== today) {
      throw errors.validation(
        slot.date > today
          ? "That appointment is not until later. Check the patient in on the day."
          : "That appointment was for an earlier day.",
        { slotId: `is dated ${slot.date}, not ${today}` }
      );
    }

    /*
     * ================= the number =================
     *
     * Scoped to clinic + doctor + day, and allocated with an atomic $inc.
     *
     * `count() + 1` is the obvious implementation and it is wrong here in the
     * most visible way this product has: two patients checked in at two
     * machines in the same second are both handed A-024, and both stand up when
     * it is called.
     *
     * The counter key carries the date, so it stops being used tomorrow and
     * there is no nightly reset job that can fail to run.
     */
    const prefix = clinic.tokenPrefix || "A";
    const seq = await Counter.nextSequence(
      req.ownerId,
      `token:${clinic._id}:${slot.doctor.id}:${slot.date}`
    );
    const tokenNumber = `${prefix}-${String(seq).padStart(3, "0")}`;

    const updated = await setBooking(slot._id, ref, {
      tokenNumber,
      tokenState: "waiting",
      status: "checked_in",
      checkedInAt: new Date(),
    });

    audit.record(req, {
      action: "booking.checkin",
      entityType: "slot",
      entityId: slot._id,
      clinicId: clinic._id,
      entityLabel: ref,
      note: `token ${tokenNumber}`,
    });

    return res.status(201).json({
      booking: serialise.booking(findRef(updated, ref)),
      slotId: String(slot._id),
    });
  })
);

/* ================= POST /api/v1/tokens/call-next ================= */
router.post(
  "/call-next",
  requireClinicPermission("tokens.manage"),
  requireSingleClinic,
  handler(async (req, res) => {
    const doctorId = isNil(req.body.doctorId)
      ? null
      : parseText(req.body.doctorId, "doctorId", { max: 80 });
    const { slots } = await loadDay(req, { doctorId });

    const entries = queueEntries(slots);

    /*
     * Whoever is being seen is finished first.
     *
     * Calling the next patient while the last is still marked `serving` is how
     * a queue ends up with two people in the consulting room according to the
     * screen — and the desk stops trusting it.
     */
    const serving = entries.filter((e) => e.booking.tokenState === "serving");
    for (const entry of serving) {
      await setBooking(entry.slot._id, entry.booking.ref, {
        tokenState: "done",
        status: "completed",
        completedAt: new Date(),
      });
    }

    const next = entries.find((e) => e.booking.tokenState === "waiting");
    /* Its own code, because it is not a failure the desk did anything about —
     * the waiting room is empty. */
    if (!next) throw errors.tokenQueueEmpty();

    /*
     * Claimed with the state in the filter, so two receptionists pressing Call
     * Next at the same moment cannot both be handed the same patient: the
     * second update matches nothing.
     */
    const updated = await setBooking(
      next.slot._id,
      next.booking.ref,
      { tokenState: "serving", status: "in_progress", calledAt: new Date() },
      { "b.tokenState": "waiting" }
    );
    if (!updated) throw errors.tokenQueueEmpty();

    return res.json({
      current: {
        ...serialise.booking(findRef(updated, next.booking.ref)),
        slotId: String(next.slot._id),
        time: next.slot.startTime,
        doctor: { id: next.slot.doctor.id, name: next.slot.doctor.name },
      },
    });
  })
);

/* ================= POST /api/v1/tokens/:slotId/:ref/:action =================
 * recall · hold · resume · skip · complete
 */
const ACTIONS = {
  /* Called again — the patient did not hear it the first time. */
  recall: { tokenState: "serving", status: "in_progress", calledAt: () => new Date() },
  /* Stepped out, or waiting on a test result. Keeps their number and their
   * place, which is the whole point of holding rather than skipping. */
  hold: { tokenState: "held", status: "checked_in" },
  resume: { tokenState: "waiting", status: "checked_in" },
  /* Called and absent. Not cancelled — they may still turn up, and the number
   * stays theirs. */
  skip: { tokenState: "skipped", status: "checked_in" },
  complete: { tokenState: "done", status: "completed", completedAt: () => new Date() },
};

router.post(
  "/:slotId/:ref/:action",
  requireClinicPermission("tokens.manage"),
  handler(async (req, res) => {
    const change = ACTIONS[String(req.params.action)];
    if (!change) throw errors.notFound();

    const slotId = parseObjectId(req.params.slotId, "slotId");
    const ref = parseText(req.params.ref, "ref", { max: 60 });

    const slot = await Slot.findOne({
      _id: slotId,
      ownerId: req.ownerId,
      clinicId: { $in: req.clinicIds },
    });
    if (!slot) throw errors.slotNotFound();

    const booking = (slot.bookings || []).find((b) => b.ref === ref);
    if (!booking) throw errors.bookingNotFound();
    if (!booking.tokenNumber) {
      throw errors.validation("That patient has not been checked in yet.", {
        ref: "has no token",
      });
    }

    const set = {};
    for (const [key, value] of Object.entries(change)) {
      set[key] = typeof value === "function" ? value() : value;
    }

    const updated = await setBooking(slot._id, ref, set);
    return res.json({
      booking: serialise.booking(findRef(updated, ref)),
      slotId: String(slot._id),
    });
  })
);

/* ================= helpers ================= */

/*
 * Change fields on ONE booking inside a slot.
 *
 * `arrayFilters` is what makes this precise: without it a positional update
 * would hit whichever element the query matched, which for a slot holding four
 * patients is a coin toss.
 *
 * Note what is NOT touched here — `available` and `booked`. Checking somebody
 * in or completing them does not free their place; only a cancellation does,
 * and that goes through releasePlace in routes/slots.js so the counter and the
 * status always move together.
 */
function setBooking(slotId, ref, fields, extraFilter = {}) {
  const set = {};
  for (const [key, value] of Object.entries(fields)) set[`bookings.$[b].${key}`] = value;

  return Slot.findOneAndUpdate(
    { _id: slotId },
    { $set: set },
    {
      arrayFilters: [{ "b.ref": ref, ...extraFilter }],
      returnDocument: "after",
    }
  );
}

const findRef = (slot, ref) => (slot.bookings || []).find((b) => b.ref === ref);

/*
 * The average wait, in whole minutes, over the visits actually called today.
 *
 * Computed from real timestamps rather than from the schedule, because the
 * schedule is what the clinic hoped for and this is the number a patient asking
 * "how long?" is owed.
 */
function averageWait(bookings) {
  const waits = bookings
    .filter((b) => b.checkedInAt && b.calledAt)
    .map((b) => (new Date(b.calledAt) - new Date(b.checkedInAt)) / 60000)
    .filter((m) => m >= 0);
  if (!waits.length) return null;
  return Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);
}

module.exports = router;
