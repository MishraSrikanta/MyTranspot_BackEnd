const express = require("express");

const Clinic = require("../models/Clinic");
const Slot = require("../models/Slot");
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
const { requireClinicKey } = require("../../../middleware/clinicKey");
const { resolveSyncClinic } = require("../../../middleware/syncAuth");
const { syncRateLimit } = require("../../../middleware/rateLimit");
const { todayIn, encodeCursor, decodeCursor } = require("../utils/clinicTime");
const serialise = require("../utils/serialise");

const router = express.Router();

/*
 * Publishing the clinic's public face.
 *
 * ================= what this router is now =================
 *
 * Two endpoints: push the profile up, and read a status tile back. It used to
 * carry the slots and the booking feed as well, and those moved to /slots when
 * slots became cloud-only.
 *
 * The single-writer rule that made the sync model work still holds for what is
 * left: the WORKBOOK owns the clinic's name, hours, doctors and services, and
 * this server holds a read-only mirror for the public page. Nothing here is
 * ever written by anything but a publish, so there is no merge step.
 */

/*
 * ================= two ways in, one resolved clinic =================
 *
 * An API key is an INSTALLATION talking about its own clinic, unattended — a
 * reception PC publishing next fortnight at three in the morning with nobody
 * logged in. A session is a PERSON, in the console, pressing Publish.
 *
 * Both are legitimate and v3 requires both. What neither may do is name a
 * clinic in the body: the key resolves to exactly one, and a session resolves
 * through the account's grants. See middleware/syncAuth.js.
 */
router.use(resolveSyncClinic, syncRateLimit);

/* ================= PUT /api/v1/sync/profile =================
 * Publish what the public page shows.
 *
 * A FULL REPLACE, not a patch, and that is the important part. The workbook is
 * the source of truth, so the app sends the whole published set and the server
 * mirrors it. A patch protocol would let this server keep a doctor the workbook
 * no longer has — and nothing would ever notice, because the workbook has no
 * reason to ask about a row it deleted.
 */
router.put(
  "/profile",
  handler(async (req, res) => {
    const clinic = req.clinic;
    const body = req.body || {};
    const clinicBody = body.clinic || {};

    /*
     * The public-page fields the workbook owns. Note what is NOT here: the
     * slug, the timezone and the API key. Those are set at provisioning and
     * changing them from a sync call would let a clinic move its own public
     * address out from under links already in patients' messages.
     */
    if (!isNil(clinicBody.name)) {
      clinic.name = parseText(clinicBody.name, "clinic.name", { max: 120 });
    }
    if (!isNil(clinicBody.address)) {
      clinic.address = parseOptionalText(clinicBody.address, "clinic.address", 300);
    }
    if (!isNil(clinicBody.city)) {
      clinic.city = parseOptionalText(clinicBody.city, "clinic.city", 80);
    }
    if (!isNil(clinicBody.state)) {
      clinic.state = parseOptionalText(clinicBody.state, "clinic.state", 80);
    }
    if (!isNil(clinicBody.pincode)) {
      clinic.pincode = parseOptionalText(clinicBody.pincode, "clinic.pincode", 10);
    }
    if (!isNil(clinicBody.phone)) {
      clinic.phone = parseOptionalText(clinicBody.phone, "clinic.phone", 20);
    }
    if (!isNil(clinicBody.email)) {
      clinic.email = parseOptionalText(clinicBody.email, "clinic.email", 160);
    }
    if (!isNil(clinicBody.logoUrl)) {
      clinic.logoUrl = parseOptionalText(clinicBody.logoUrl, "clinic.logoUrl", 500) || null;
    }
    if (!isNil(clinicBody.openTime)) {
      clinic.openTime = parseTime(clinicBody.openTime, "clinic.openTime");
    }
    if (!isNil(clinicBody.closeTime)) {
      clinic.closeTime = parseTime(clinicBody.closeTime, "clinic.closeTime");
    }
    if (Array.isArray(clinicBody.workingDays)) {
      clinic.workingDays = clinicBody.workingDays
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    }
    if (!isNil(clinicBody.bookingEnabled)) {
      clinic.bookingEnabled = parseBoolean(clinicBody.bookingEnabled, true);
    }

    /*
     * Doctors and services are replaced wholesale when the key is present, and
     * left alone when it is absent.
     *
     * The distinction matters: an app publishing only the clinic's new phone
     * number should not have to resend forty services, and an app that sends
     * `doctors: []` genuinely means "there are none". `undefined` and `[]` are
     * different answers and are treated as such.
     */
    if (Array.isArray(body.doctors)) {
      clinic.doctors = body.doctors.map((d, i) => parsePublishedDoctor(d, i));
      assertUniqueClientIds(clinic.doctors, "doctors");
    }
    if (Array.isArray(body.services)) {
      clinic.services = body.services.map((s, i) => parsePublishedService(s, i));
      assertUniqueClientIds(clinic.services, "services");
    }

    clinic.lastPublishAt = new Date();
    await clinic.save();

    return res.json({
      clinic: serialise.publicClinic(clinic),
      published: {
        doctors: (clinic.doctors || []).length,
        services: (clinic.services || []).length,
        at: clinic.lastPublishAt.toISOString(),
      },
    });
  })
);

/*
 * ================= what used to be here =================
 *
 * POST /sync/slots, GET /sync/bookings and POST /sync/bookings/ack were the
 * heart of this router in v2. All three are gone, and deliberately not
 * deprecated.
 *
 * Slots and their bookings are now cloud-only: the app creates them through
 * POST /slots and reads them through GET /slots, and nothing about who is
 * booked when is written to the workbook. There is nothing left to publish
 * upward and nothing to pull down — the slot was never local.
 *
 * What remains here is the clinic PROFILE: the name, hours, doctors and
 * services that render the public page. Those genuinely do live in the
 * workbook, so they are still published from it.
 */

/* ================= GET /api/v1/sync/status =================
 * The dashboard tile: cheap, and polled by the app's header so the receptionist
 * sees "3 new online bookings" without running a full sync.
 */
router.get(
  "/status",
  handler(async (req, res) => {
    const clinic = req.clinic;
    const today = todayIn(clinic.timezone);

    /*
     * Cacheable for thirty seconds. The app polls this continuously and the
     * numbers are a status light rather than a ledger — half a minute stale is
     * invisible to a person and is the difference between one query a minute
     * and one per open tab per poll.
     */
    res.setHeader("Cache-Control", "private, max-age=30");

    /*
     * All five figures come from the slot collection, because in v4 that is
     * where the bookings are. There is no pending-pull count any longer: the
     * app reads /slots directly with its session, so there is no feed for
     * anything to be pending in.
     */
    const [openSlots, todaysSlots, furthest] = await Promise.all([
      Slot.countDocuments({
        clinicId: clinic._id,
        date: { $gte: today },
        isBlocked: false,
        available: { $gt: 0 },
      }),
      Slot.find({ clinicId: clinic._id, date: today }).select("bookings"),
      Slot.findOne({ clinicId: clinic._id, date: { $gte: today } })
        .sort({ date: -1 })
        .select("date"),
    ]);

    const todaysBookings = todaysSlots.reduce(
      (n, s) => n + (s.bookings || []).filter((b) => b.status !== "cancelled").length,
      0
    );

    const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

    return res.json({
      clinic: {
        name: clinic.name,
        slug: clinic.slug,
        bookingEnabled: clinic.bookingEnabled !== false,
        publicUrl: base ? `${base}/clinic/${clinic.slug}` : null,
      },
      slots: {
        open: openSlots,
        /* How far ahead the calendar actually goes — the number that tells a
         * receptionist it is time to publish another fortnight. */
        publishedThrough: furthest ? furthest.date : null,
      },
      bookings: { today: todaysBookings },
      lastPublishAt: clinic.lastPublishAt ? clinic.lastPublishAt.toISOString() : null,
      serverTime: new Date().toISOString(),
    });
  })
);

/* ================= parsing ================= */

function parsePublishedDoctor(raw, index) {
  const row = raw || {};
  return {
    clientId: parseText(row.clientId, `doctors[${index}].clientId`, { max: 80 }),
    name: parseText(row.name, `doctors[${index}].name`, { max: 120 }),
    specialization: parseOptionalText(
      row.specialization,
      `doctors[${index}].specialization`,
      120
    ),
    qualification: parseOptionalText(
      row.qualification,
      `doctors[${index}].qualification`,
      160
    ),
    consultationFee: parseAmount(row.consultationFee, `doctors[${index}].consultationFee`),
    photoUrl: parseOptionalText(row.photoUrl, `doctors[${index}].photoUrl`, 500) || null,
    isPubliclyVisible: parseBoolean(row.isPubliclyVisible, true),
  };
}

function parsePublishedService(raw, index) {
  const row = raw || {};
  return {
    clientId: parseText(row.clientId, `services[${index}].clientId`, { max: 80 }),
    name: parseText(row.name, `services[${index}].name`, { max: 160 }),
    category: parseOptionalText(row.category, `services[${index}].category`, 80),
    description: parseOptionalText(row.description, `services[${index}].description`, 500),
    price: parseAmount(row.price, `services[${index}].price`),
    durationMinutes: parseInteger(row.durationMinutes, `services[${index}].durationMinutes`, {
      min: 0,
      max: 600,
      fallback: 15,
    }),
    isPubliclyVisible: parseBoolean(row.isPubliclyVisible, true),
  };
}

function parseSlotRow(raw, index, from, to) {
  const row = raw || {};
  const field = (name) => `slots[${index}].${name}`;

  const date = parseDateOnly(row.date, field("date"));
  /*
   * A slot outside the declared window is refused rather than quietly accepted.
   *
   * The window is what authorises the close pass, so a payload that reaches
   * beyond it is one whose author has misunderstood the contract — and the
   * damage from guessing is a slot that no future publish will ever be able to
   * withdraw, because it sits outside every window the app sends.
   */
  if (date < from || date > to) {
    throw errors.validation(`That slot is outside the published date range.`, {
      [field("date")]: `must be between ${from} and ${to}`,
    });
  }

  const startTime = parseTime(row.startTime, field("startTime"));
  const endTime = parseTime(row.endTime, field("endTime"));
  if (endTime <= startTime) {
    throw errors.validation("A slot must end after it starts.", {
      [field("endTime")]: "must be after startTime",
    });
  }

  return {
    clientId: parseText(row.clientId, field("clientId"), { max: 80 }),
    doctorClientId: parseOptionalText(row.doctorClientId, field("doctorClientId"), 80),
    date,
    startTime,
    endTime,
    capacity: parseInteger(row.capacity, field("capacity"), {
      min: 1,
      max: 100,
      fallback: 1,
    }),
    /*
     * "expired" is not accepted from a client. It is a conclusion this server
     * draws from the calendar, and letting a workbook assert it would let a
     * clinic with a wrong system clock expire its own live slots.
     */
    status: parseEnum(row.status, field("status"), ["open", "closed"], {
      fallback: "open",
    }),
  };
}

/*
 * Two rows in one payload claiming the same workbook id.
 *
 * Caught here rather than left to the bulk write, where the second would
 * silently overwrite the first and the response would cheerfully report both as
 * written. The usual cause is a copy-paste in the workbook, and the clinic
 * needs to know.
 */
function assertUniqueClientIds(rows, label) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.clientId)) {
      throw errors.validation(`Two ${label} rows share the id "${row.clientId}".`, {
        [label]: "clientId must be unique within a publish",
      });
    }
    seen.add(row.clientId);
  }
}

module.exports = router;
