const mongoose = require("mongoose");
const crypto = require("crypto");

/*
 * A clinic, as this backend knows it.
 *
 * ================= what this document is and is not =================
 *
 * It is NOT the clinic's database. The clinic's database is a workbook on a
 * machine at the front desk, holding patients, invoices, reports, staff and
 * everything else that matters. This row holds the public face of the clinic
 * and the credential its app uses to talk to us — and nothing else.
 *
 * The `doctors` and `services` arrays are a MIRROR. They are owned by the
 * workbook, replaced wholesale by PUT /sync/profile, and never written by
 * anything else on this server. That single-writer rule is what makes the sync
 * model have no merge step at all: no row on this API has two writers, so there
 * is nothing to reconcile.
 */

/*
 * Embedded rather than in their own collections, because they are never queried
 * independently — the only read is "the whole public page for this slug", which
 * is one document fetch. They are also replaced as a unit on every publish, and
 * a set of rows replaced as a unit is an array.
 *
 * `clientId` is the row's id IN THE WORKBOOK. Matching on it is what lets the
 * app republish repeatedly without creating duplicates and without having to
 * remember any id this server invented.
 */
const publishedDoctorSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    specialization: { type: String, default: "", trim: true, maxlength: 120 },
    qualification: { type: String, default: "", trim: true, maxlength: 160 },
    consultationFee: { type: Number, default: 0, min: 0 },
    photoUrl: { type: String, default: null },
    /*
     * Stored even when false, and filtered at read time.
     *
     * The alternative — dropping invisible rows at publish — looks tidier and
     * is worse: a slot references a doctor by clientId, so a doctor hidden from
     * the public page would leave their slots pointing at nothing, and the
     * clinic could not flip visibility back on without republishing everything.
     */
    isPubliclyVisible: { type: Boolean, default: true },
  },
  { _id: false }
);

const publishedServiceSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, default: "", trim: true, maxlength: 80 },
    description: { type: String, default: "", trim: true, maxlength: 500 },
    price: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, default: 15, min: 0, max: 600 },
    isPubliclyVisible: { type: Boolean, default: true },
  },
  { _id: false }
);

const clinicSchema = new mongoose.Schema(
  {
    /*
     * The practice this branch belongs to.
     *
     * Every clinic-module query is scoped by it, and staff grants are checked
     * against it: an account may only be given clinics whose ownerId matches
     * its own. That single comparison is what stops one practice granting
     * itself access to another's branch.
     */
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Owner",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 120 },

    /*
     * A short code — "SUN", "SUN2". Generated from the clinic's name at signup
     * and never accepted from the request.
     *
     * It prefixes the login ID and every numbered document the clinic issues,
     * so a collision does not merely look untidy: it merges two clinics'
     * sequences, and two businesses start handing out the same invoice numbers.
     * That is why it is unique platform-wide and generated with a collision
     * suffix rather than trusted from a form.
     */
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 12 },

    /* The public URL segment: /clinic/sunshine-diagnostics. Unique across the
     * platform, because it is an address a patient types and there is only one
     * internet. */
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 60 },

    address: { type: String, default: "", trim: true, maxlength: 300 },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    state: { type: String, default: "", trim: true, maxlength: 80 },
    pincode: { type: String, default: "", trim: true, maxlength: 10 },
    phone: { type: String, default: "", trim: true, maxlength: 20 },
    email: { type: String, default: "", lowercase: true, trim: true },
    logoUrl: { type: String, default: null },

    /*
     * The clinic's IANA timezone, and it is load-bearing rather than
     * decorative. Every "is this slot still in the future?" and every
     * "which day is today?" is answered in THIS zone.
     *
     * `new Date().toISOString().slice(0, 10)` rolls over at 05:30 in India,
     * which would expire a clinic's whole morning while patients are still
     * arriving for it.
     */
    timezone: { type: String, default: "Asia/Kolkata" },

    /* 0 is Sunday, matching JavaScript's getDay(). Stated because the other
     * plausible convention — ISO's Monday-as-1 — differs on every day of the
     * week, and the bug is a clinic advertising the wrong opening days. */
    workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "20:00" },

    /*
     * The switch that takes online booking down without deleting anything. A
     * clinic with this off answers 404 on its public page — not 403, which
     * would confirm the slug is real.
     */
    bookingEnabled: { type: Boolean, default: true },

    /*
     * How long a slot document outlives the day it was for, in hours.
     *
     * Forty-eight by default: the clinic has the rest of that day and all of
     * the next to reconcile what happened into their own workbook. After that
     * the slot and every booking inside it are removed by the TTL index, and
     * nothing on this server remembers the patients' names.
     *
     * Per clinic rather than global, because a practice that wants a shorter
     * window should be able to have one without a deployment — and because a
     * practice that reconciles weekly needs a longer one.
     */
    retentionHours: { type: Number, default: 48, min: 6, max: 24 * 30 },

    /* ================= the API key ================= */
    /*
     * Stored hashed, never in plain text, and shown to a human exactly once at
     * creation.
     *
     * sha256 rather than bcrypt: this value is 256 bits of randomness, not a
     * guessable password, so there is nothing to slow an attacker down about —
     * and a deliberately slow hash on the authentication path of an endpoint
     * the app polls is a way of loading the server rather than protecting it.
     *
     * A key list an administrator can read is a key list an attacker can read.
     */
    apiKeyHash: { type: String, default: null },
    /* The first few characters, kept in the clear so the admin list can say
     * WHICH key is installed without being able to reconstruct it. */
    apiKeyPrefix: { type: String, default: "" },
    apiKeyRotatedAt: { type: Date, default: null },

    /* ================= the published mirror ================= */
    doctors: { type: [publishedDoctorSchema], default: [] },
    services: { type: [publishedServiceSchema], default: [] },

    lastPublishAt: { type: Date, default: null },
    lastSlotPublishAt: { type: Date, default: null },
    lastPullAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

clinicSchema.index({ slug: 1 }, { unique: true });
clinicSchema.index({ code: 1 }, { unique: true });
/*
 * The public booking directory (GET /public/clinics). Every clause of that
 * query is here, so listing the bookable clinics is an index scan rather than a
 * pass over every clinic on the platform.
 */
clinicSchema.index({ isActive: 1, bookingEnabled: 1, name: 1 });
/* The owner's clinic list and switcher — served on every sign-in. */
clinicSchema.index({ ownerId: 1, isActive: 1, name: 1 });
/*
 * The authentication lookup, on every single sync request. Unique so two
 * clinics can never share a key, sparse so the clinics that have not been
 * issued one yet do not all collide on null.
 */
clinicSchema.index({ apiKeyHash: 1 }, { unique: true, sparse: true });

/* mck_live_… — the prefix is a convention worth keeping: a key that announces
 * what it is gets recognised by secret scanners when somebody pastes it into a
 * repository, which is how most leaked keys are actually caught. */
const KEY_PREFIX = "mck_live_";

function hashKey(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

/*
 * Mint a key. Returns the plaintext to the caller — the ONLY moment it exists
 * outside the clinic's own storage — and leaves the hash on the document for
 * the caller to save.
 */
clinicSchema.methods.issueApiKey = function issueApiKey() {
  const secret = crypto.randomBytes(24).toString("hex");
  const key = `${KEY_PREFIX}${secret}`;

  this.apiKeyHash = hashKey(key);
  /* Enough to identify it in a list, far too little to use. */
  this.apiKeyPrefix = key.slice(0, KEY_PREFIX.length + 6);
  this.apiKeyRotatedAt = new Date();

  return key;
};

module.exports = mongoose.model("Clinic", clinicSchema);
module.exports.hashKey = hashKey;
module.exports.KEY_PREFIX = KEY_PREFIX;
