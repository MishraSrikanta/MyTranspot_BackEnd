const mongoose = require("mongoose");
const crypto = require("crypto");

/*
 * A bookable time, and the people booked into it.
 *
 * ================= why the booking lives inside the slot =================
 *
 * v3 modelled appointments as their own documents pointing at a slot. That is
 * the conventional shape, and it is the wrong one here.
 *
 * Every question this product asks is "what is free, and who is in the rest?" —
 * a booking page, a reception grid, a token queue. With separate documents that
 * is a join on every render and a race on every booking. With the bookings
 * inside the slot it is ONE read, and taking the last place is ONE atomic
 * update of ONE document:
 *
 *   findOneAndUpdate({ _id, available: { $gt: 0 } }, { $inc: { available: -1 }, $push: { bookings } })
 *
 * A null result means blocked, full, past or gone. Every one of those branches
 * ends in "choose another time", which is why the route does not try to tell
 * them apart.
 *
 * ================= the snapshots =================
 *
 * `clinic` and `doctor` are COPIES, not references. They have to be: the server
 * has no access to the clinic's Excel database and never will, so the only way
 * a public booking page can render a doctor's name is if it was written here
 * when the slot was created.
 *
 * That also gives the right behaviour when a clinic renames itself — slots
 * already created keep the old name until they are recreated, and a patient
 * holding a confirmation sees the name that was on it.
 *
 * ================= these documents are working memory =================
 *
 * The slot expires (see `expiresAt`) and takes its bookings with it, typically
 * two days after the date it was for. Anything the clinic needs to keep — an
 * invoice, a report, a patient record — has to be in their own workbook before
 * then. What is stored here is "somebody called Priya on this number wants
 * 10:15 on Thursday", for as long as that sentence is useful.
 */

/*
 * What a booking may become. `booked` is where every one starts; the rest are
 * the reception desk working through the day.
 *
 * `cancelled` rows STAY in the array. Reception needs to see that somebody
 * cancelled rather than that nobody ever booked — those are very different
 * mornings, and only one of them is worth ringing about.
 */
const BOOKING_STATUSES = [
  "booked",
  "checked_in",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
];

/* The ones that still occupy a place. Availability is maintained against this
 * list, and nothing else should carry its own copy of it. */
const ACTIVE_STATUSES = ["booked", "checked_in", "in_progress"];

/* Where the patient is in today's queue, as opposed to where the visit is. A
 * patient the doctor has held to see later is still `checked_in` clinically
 * while their token is `held`. */
const TOKEN_STATES = ["waiting", "serving", "held", "skipped", "done"];

const SOURCES = ["public", "reception", "walk_in", "phone"];

const bookingSchema = new mongoose.Schema(
  {
    /*
     * APT-2026-004411 — the human reference, server-issued through the atomic
     * counter, and what the patient is told on the telephone.
     *
     * It is the one number two machines could otherwise duplicate: a reception
     * PC and a patient's phone can both book in the same second, and
     * `count() + 1` hands them the same reference.
     */
    ref: { type: String, required: true },

    /*
     * ================= why there is a second identifier =================
     *
     * `ref` is sequential, and a sequential value must never be the credential
     * that authorises anything. The public cancellation link is addressed by
     * THIS instead: 128 bits from crypto.randomBytes, never derived from the
     * ref, never guessable.
     *
     * Without it, cancelling APT-2026-004410, then 004411, then 004412 would
     * empty a clinic's whole day from a browser — and every one of those
     * patients would arrive to find no appointment. The v2 publicRef reasoning
     * applies here unchanged; only the document it lives in has moved.
     */
    publicRef: { type: String, required: true },

    /*
     * A name and a mobile number, and that is nearly all.
     *
     * A patient booking online is not registering as a patient. No address, no
     * date of birth, no history — the clinic links them to a real record in its
     * own workbook afterwards. See the module README.
     */
    patientName: { type: String, required: true, trim: true, maxlength: 120 },
    patientMobile: { type: String, required: true, trim: true, maxlength: 15 },

    /*
     * The patient's id in THAT CLINIC'S OWN WORKBOOK, when reception already
     * knows it. Stored opaquely: this server never resolves it, never validates
     * it, and could not check it against anything if it wanted to.
     */
    patientId: { type: String, default: null, trim: true, maxlength: 80 },
    /* Denormalised for the same reason the doctor is — nothing here can look it
     * up later. */
    serviceName: { type: String, default: "", trim: true, maxlength: 160 },

    notes: { type: String, default: "", trim: true, maxlength: 500 },

    source: { type: String, enum: SOURCES, default: "public" },
    status: { type: String, enum: BOOKING_STATUSES, default: "booked" },

    /* The queue. A token is a position in today's list, not a record of its
     * own — see routes/tokens.js for why there is no Token collection. */
    tokenNumber: { type: String, default: null },
    tokenState: { type: String, enum: TOKEN_STATES, default: null },

    bookedAt: { type: Date, default: Date.now },
    checkedInAt: { type: Date, default: null },
    calledAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    /* Who ended it. The patient's own page and the clinic's grid want to tell
     * "they rang to cancel" from "we cancelled it" apart. */
    cancelledBy: { type: String, enum: ["patient", "clinic"], default: null },
    cancelReason: { type: String, default: "", trim: true, maxlength: 300 },

    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    bookedByName: { type: String, default: "" },
  },
  { _id: false }
);

/*
 * The clinic as it stood when the slot was made. Six fields, because that is
 * what a confirmation page and a reminder message need: who, where, and what
 * number to ring.
 */
const clinicSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, default: "", uppercase: true, trim: true, maxlength: 12 },
    phone: { type: String, default: "", trim: true, maxlength: 20 },
    address: { type: String, default: "", trim: true, maxlength: 300 },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    slug: { type: String, default: "", lowercase: true, trim: true, maxlength: 60 },
  },
  { _id: false }
);

/*
 * The doctor as they stood when the slot was made.
 *
 * `id` is the WORKBOOK's id for them — this server has never seen their record
 * and issues no id of its own. It is what the app groups the reception grid by,
 * and what makes re-publishing the same fortnight idempotent.
 */
const doctorSnapshotSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    specialization: { type: String, default: "", trim: true, maxlength: 120 },
    qualification: { type: String, default: "", trim: true, maxlength: 160 },
    consultationFee: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const slotSchema = new mongoose.Schema(
  {
    /*
     * The practice. Every query filters by it.
     *
     * With self-serve signup there are many practices in one collection, and a
     * query that forgets this is a cross-tenant leak on the first day rather
     * than an obscure edge case.
     */
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Owner",
      required: true,
      index: true,
    },
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },

    clinic: { type: clinicSnapshotSchema, required: true },
    doctor: { type: doctorSnapshotSchema, required: true },

    /*
     * "YYYY-MM-DD" and "HH:mm", both local to the clinic and both stored as
     * strings.
     *
     * A slot is at a wall-clock time on a calendar day, which is not an
     * instant: stored as a Date, a 09:00 slot created from a laptop still set
     * to UTC lands at half past two in the afternoon. Zero-padded, so string
     * comparison is time comparison — which is what the expiry filter and the
     * grid's ordering both rely on.
     */
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },

    capacity: { type: Number, required: true, min: 1 },
    booked: { type: Number, default: 0, min: 0 },

    /*
     * ================= available is STORED =================
     *
     * Not computed on read. It is `capacity - count(active bookings)`, written
     * in the same update as the booking itself.
     *
     * Computing it per request means two readers can both see "1 free" and both
     * be told yes. Storing it is what lets the booking filter say
     * `available: { $gt: 0 }` — and that filter IS the concurrency control.
     */
    available: { type: Number, required: true, min: 0 },

    /* Stops new bookings without touching the ones already made. A doctor
     * called into theatre blocks the afternoon; the patients already booked
     * have to stay visible so somebody can ring them. */
    isBlocked: { type: Boolean, default: false },
    blockReason: { type: String, default: "", trim: true, maxlength: 200 },

    bookings: { type: [bookingSchema], default: [] },

    /*
     * ================= when this document dies =================
     *
     * The end of the slot's day in the CLINIC's timezone, plus the practice's
     * retention window (48 hours by default). A TTL index on this field removes
     * the document, and the bookings inside it go with it.
     *
     * There is no cron to miss and no job to fail quietly. What there is, is a
     * short window: anything the clinic needs to keep must be in their own
     * workbook before then. That is stated in the README in those words,
     * because this mechanism deletes patient names.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/*
 * ================= idempotency =================
 *
 * One slot per doctor per start time. Re-sending the same fortnight is the
 * NORMAL case — the app does it whenever a schedule changes — and a duplicated
 * 10:15 is a double booking waiting to happen: two documents, each believing it
 * has a free place, and two patients told to come at the same time.
 */
slotSchema.index(
  { clinicId: 1, "doctor.id": 1, date: 1, startTime: 1 },
  { unique: true }
);

/* The reception grid: one clinic, a date range, in order. */
slotSchema.index({ ownerId: 1, clinicId: 1, date: 1, startTime: 1 });
/* The public "what is free" query, which is the busiest read on the API. */
slotSchema.index({ clinicId: 1, date: 1, available: 1 });
/* "Has this number booked before?" — the duplicate-booking check, and the only
 * reason a mobile number is indexed. */
slotSchema.index({ "bookings.patientMobile": 1 });
/* The public cancellation link. Sparse is not needed: every booking has one. */
slotSchema.index({ "bookings.publicRef": 1 });

/*
 * The TTL. `expireAfterSeconds: 0` means "delete when the date in this field
 * has passed", which is why expiresAt holds the moment of death rather than a
 * duration.
 *
 * Mongo's TTL monitor runs about once a minute and is explicitly not a
 * guarantee, so every public read ALSO filters on the actual date. The TTL
 * keeps the collection tidy; the read-time filter keeps the answers right.
 */
slotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/*
 * 16 bytes is 128 bits. base64url rather than hex because it survives being
 * pasted out of a WhatsApp message or an email client that wraps lines, and is
 * a third shorter for the same entropy.
 */
function newPublicRef() {
  return crypto.randomBytes(16).toString("base64url");
}

/* The bookings that still hold a place. */
slotSchema.methods.activeBookings = function activeBookings() {
  return (this.bookings || []).filter((b) => ACTIVE_STATUSES.includes(b.status));
};

module.exports = mongoose.model("Slot", slotSchema);
module.exports.BOOKING_STATUSES = BOOKING_STATUSES;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.TOKEN_STATES = TOKEN_STATES;
module.exports.SOURCES = SOURCES;
module.exports.newPublicRef = newPublicRef;
