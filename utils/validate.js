const { errors } = require("./apiError");

/*
 * Small parsers shared by every route. They all follow one rule: a bad value
 * throws a 400 with a field-level detail, rather than being coerced. Silently
 * reading "twelve hundred" as 0 would issue an invoice with no charge on it and
 * a balance the clinic would believe.
 */

const isNil = (v) => v === undefined || v === null || String(v).trim() === "";

/*
 * Deliberately loose: one @ with something either side. A stricter regex
 * rejects real addresses, and the only test that proves an address works is
 * sending mail to it.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmail(raw, field = "email") {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw errors.validation("Please enter a valid email address.", {
      [field]: "must be a valid email address",
    });
  }
  return email;
}

function parsePassword(raw, field = "password") {
  const password = String(raw ?? "");
  if (password.length < 3) {
    throw errors.validation("The password must be at least 3 characters.", {
      [field]: "must be at least 3 characters",
    });
  }
  if (password.length > 200) {
    throw errors.validation("That password is too long.", {
      [field]: "must be at most 200 characters",
    });
  }
  return password;
}

function parseText(raw, field, { min = 1, max = 200, label } = {}) {
  const value = String(raw ?? "").trim();
  if (value.length < min || value.length > max) {
    throw errors.validation(`${label || field} is required.`, {
      [field]: `must be ${min} to ${max} characters`,
    });
  }
  return value;
}

function parseOptionalText(raw, field, max = 200) {
  const value = String(raw ?? "").trim();
  if (value.length > max) {
    throw errors.validation(`That ${field} is too long.`, {
      [field]: `must be at most ${max} characters`,
    });
  }
  return value;
}

/*
 * Money and quantities. Negative is refused everywhere: a "-500" line on an
 * invoice would work as an undocumented credit note and quietly reduce the
 * bill, with nothing in the ledger to show who decided that.
 */
function parseAmount(raw, field, { required = false, max = 1e11 } = {}) {
  if (isNil(raw)) {
    if (required) {
      throw errors.validation(`${field} is required.`, { [field]: "is required" });
    }
    return 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw errors.validation(`${field} must be a positive amount.`, {
      [field]: "must be a number of 0 or more",
    });
  }
  if (n > max) {
    throw errors.validation(`${field} is unrealistically large.`, {
      [field]: `must be at most ${max}`,
    });
  }
  return Math.round(n * 100) / 100;
}

function parseInteger(raw, field, { min = 0, max = 1e9, fallback = null } = {}) {
  if (isNil(raw)) {
    if (fallback === null) {
      throw errors.validation(`${field} is required.`, { [field]: "is required" });
    }
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw errors.validation(`${field} is not valid.`, {
      [field]: `must be a whole number between ${min} and ${max}`,
    });
  }
  return n;
}

/*
 * A percentage. Separate from parseAmount because the ceiling is the point: a
 * tax or discount of 1800% is a typo for 18%, and letting it through turns a
 * ₹500 consultation into a ₹9,000 bill handed to a patient at a desk.
 */
function parsePercent(raw, field, { fallback = 0, max = 100 } = {}) {
  if (isNil(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw errors.validation(`${field} is not a valid percentage.`, {
      [field]: `must be between 0 and ${max}`,
    });
  }
  return Math.round(n * 100) / 100;
}

/*
 * Enums are matched case-insensitively but returned in the CASE THEY ARE
 * DECLARED IN, not upper-cased. MyTransport upper-cases because its statuses
 * are upper-case; every enum here is lower_snake ("checked_in", "sample_
 * collected") because that is what the frontend's types say, and returning
 * "CHECKED_IN" would fail the schema's own enum a line later.
 */
function parseEnum(raw, field, allowed, { fallback = null, label } = {}) {
  if (isNil(raw)) {
    if (fallback === null) {
      throw errors.validation(`${label || field} is required.`, {
        [field]: `must be one of: ${allowed.join(", ")}`,
      });
    }
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  const match = allowed.find((a) => String(a).toLowerCase() === value);
  /*
   * An unrecognised value is refused rather than defaulted. Reading a mistyped
   * "labb" as "other" would hide a laboratory overspend inside the
   * miscellaneous line of every expense report that quarter.
   */
  if (!match) {
    throw errors.validation(`That ${label || field} is not recognised.`, {
      [field]: `must be one of: ${allowed.join(", ")}`,
    });
  }
  return match;
}

function parseDate(raw, field, { required = false, fallback = null } = {}) {
  if (isNil(raw)) {
    if (required) {
      throw errors.validation(`${field} is required.`, { [field]: "is required" });
    }
    return fallback;
  }
  /*
   * A bare "2026-09-01" is parsed as LOCAL midnight, not UTC.
   *
   * `new Date("2026-09-01")` is UTC midnight by specification, which in India
   * is half past five in the morning on that date. Every date filter in this
   * product is a date somebody typed or picked meaning a day in their own
   * clinic — so a day's collection report would silently drop the first
   * appointments of the morning, and would disagree with the server's own
   * default period, which is built from local parts.
   *
   * A full timestamp is left exactly alone: if the caller sent an offset or a
   * Z, they meant an instant and it is not this function's business to move it.
   */
  const dateOnly = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
  const d = dateOnly
    ? (() => {
        const [year, month, day] = raw.trim().split("-").map(Number);
        return new Date(year, month - 1, day);
      })()
    : new Date(raw);

  if (Number.isNaN(d.getTime())) {
    throw errors.validation(`${field} is not a valid date.`, {
      [field]: "must be a date",
    });
  }
  return d;
}

/*
 * A calendar day as the string "YYYY-MM-DD", kept as a string on purpose.
 *
 * An appointment is on a DAY, not at an instant offset from one. Storing it as
 * a Date means every read has to reason about the timezone it is rendered in,
 * and the clinic that books a 9 a.m. appointment sees it move to the previous
 * evening the first time somebody opens the console on a laptop still set to
 * UTC. The day is what the clinic agreed with the patient; it is stored as
 * that, and only the derived timestamps carry an instant.
 */
function parseDateOnly(raw, field = "date", { required = true, fallback = null } = {}) {
  if (isNil(raw)) {
    if (required) {
      throw errors.validation(`${field} is required.`, { [field]: "is required" });
    }
    return fallback;
  }
  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw errors.validation(`${field} must be a date.`, {
      [field]: "must be in YYYY-MM-DD form",
    });
  }
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(y, m - 1, d);
  /* Catches 2026-02-31, which the regex is perfectly happy with and which
   * JavaScript would silently roll forward into March. */
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    throw errors.validation(`${field} is not a real date.`, {
      [field]: "must be a real calendar date",
    });
  }
  return value;
}

/*
 * A wall-clock time, "HH:mm", 24-hour. Same reasoning as parseDateOnly: a
 * clinic opens at half nine in its own town, and that is not an instant.
 * Normalised to two digits so "9:05" and "09:05" sort and compare as the same
 * time — string comparison on this format is ordering, which is what the slot
 * overlap check relies on.
 */
function parseTime(raw, field = "time", { required = true, fallback = null } = {}) {
  if (isNil(raw)) {
    if (required) {
      throw errors.validation(`${field} is required.`, { [field]: "is required" });
    }
    return fallback;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!match) {
    throw errors.validation(`${field} must be a time.`, {
      [field]: "must be in HH:mm form",
    });
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw errors.validation(`${field} is not a valid time.`, {
      [field]: "must be between 00:00 and 23:59",
    });
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/*
 * The clinic's public URL segment — /clinic/sunshine-diagnostics.
 *
 * Unique across the whole platform rather than per owner, because it is the
 * address a patient types. Reserved words are refused so a clinic cannot claim
 * a slug that would shadow a route of the app itself.
 */
const RESERVED_SLUGS = new Set([
  "api", "admin", "app", "www", "clinic", "clinics", "book", "booking",
  "login", "signin", "signup", "register", "public", "assets", "static",
  "health", "platform", "support", "help", "about",
]);

function parseSlug(raw, field = "slug") {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    /* Spaces and punctuation become hyphens so "Sunshine Diagnostics" typed
     * into the field is usable rather than rejected. */
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (value.length < 3 || value.length > 60) {
    throw errors.validation("Please choose a valid web address for the clinic.", {
      [field]: "must be 3 to 60 characters, letters and numbers",
    });
  }
  if (RESERVED_SLUGS.has(value)) {
    throw errors.validation("That web address is reserved. Please choose another.", {
      [field]: "is reserved",
    });
  }
  return value;
}

function parseBoolean(raw, fallback = false) {
  if (isNil(raw)) return fallback;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function parsePhone(raw, field = "phone", { required = false } = {}) {
  const value = String(raw ?? "").trim();
  if (!value) {
    if (required) {
      throw errors.validation("A phone number is required.", {
        [field]: "is required",
      });
    }
    return "";
  }
  if (!/^[+0-9][0-9\s-]{6,19}$/.test(value)) {
    throw errors.validation("Please enter a valid phone number.", {
      [field]: "must be 7 to 20 digits",
    });
  }
  return value;
}

/*
 * An Indian mobile number, normalised to ten bare digits.
 *
 * Stricter than parsePhone on purpose, and used everywhere a number is an
 * IDENTITY rather than a contact detail: the reception desk's phone lookup and
 * the public booking form both match a patient on it. "+91 98765 43210",
 * "09876543210" and "9876543210" are one person, and storing all three shapes
 * is how the same patient ends up in the system three times with three
 * separate histories.
 *
 * A landline is a valid contact number and is not valid here, which is
 * deliberate — a WhatsApp confirmation sent to one goes nowhere.
 */
function parseMobile(raw, field = "mobile", { required = true } = {}) {
  const raw10 = String(raw ?? "").replace(/[\s-()]/g, "");
  if (!raw10) {
    if (required) {
      throw errors.validation("A mobile number is required.", {
        [field]: "is required",
      });
    }
    return "";
  }
  const stripped = raw10.replace(/^(\+91|91|0)/, "");
  if (!/^[6-9]\d{9}$/.test(stripped)) {
    throw errors.validation("Please enter a valid 10-digit mobile number.", {
      [field]: "must be a 10-digit Indian mobile number",
    });
  }
  return stripped;
}

const GENDERS = ["male", "female", "other"];

function parseGender(raw, field = "gender", { fallback = null } = {}) {
  return parseEnum(raw, field, GENDERS, { fallback, label: "gender" });
}

/*
 * Blood group, normalised to the standard notation. Optional throughout — it is
 * frequently unknown at registration, and forcing a guess into a clinical field
 * is worse than leaving it blank.
 */
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

function parseBloodGroup(raw, field = "bloodGroup") {
  if (isNil(raw)) return "";
  const value = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (!BLOOD_GROUPS.includes(value)) {
    throw errors.validation("That is not a recognised blood group.", {
      [field]: `must be one of: ${BLOOD_GROUPS.join(", ")}`,
    });
  }
  return value;
}

/*
 * An id from the wire. Checked for shape before it reaches Mongoose, so a
 * malformed one is a 400 naming the field rather than a CastError translated
 * into a generic "that id is not valid" with no field attached.
 */
function parseObjectId(raw, field, { required = true } = {}) {
  if (isNil(raw)) {
    if (required) {
      throw errors.validation(`${field} is required.`, { [field]: "is required" });
    }
    return null;
  }
  const value = String(raw).trim();
  if (!/^[0-9a-fA-F]{24}$/.test(value)) {
    throw errors.validation(`That ${field} is not valid.`, { [field]: "is not a valid id" });
  }
  return value;
}

/*
 * The list envelope's inputs, in one place.
 *
 * The cap of 200 is not tidiness: without it, `?limit=100000` on the patient
 * list is a request that reads a clinic's entire history into memory and times
 * out — and it is the first thing anybody tries when they want to export.
 * Exports have their own endpoint for exactly that reason.
 */
function parsePaging(query, { defaultLimit = 25, maxLimit = 200 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/* The one list shape every collection endpoint returns. */
function pageResult(items, total, { page, limit }) {
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/* ================= transport-specific parsers =================
 * Used only by the transport module, and kept here rather than beside it so
 * that there is exactly ONE file a route imports a parser from. A second
 * validate.js per module is how two subtly different parsePhone implementations
 * end up in one codebase, disagreeing about whether a landline is a phone
 * number.
 */

/*
 * An Indian registration plate, normalised to no-spaces upper case so
 * "od 02 ab 1234" and "OD02AB1234" are the same lorry. Format is not enforced
 * beyond length: trailers, other states and older series all differ, and a
 * regex that rejects a real plate stops a real trip being created.
 */
function parseRegistration(raw, field = "registrationNumber") {
  const value = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (value.length < 4 || value.length > 20) {
    throw errors.validation("Please enter a valid registration number.", {
      [field]: "must be 4 to 20 characters",
    });
  }
  return value;
}

/*
 * A latitude/longitude pair. (0, 0) is refused: it is in the Gulf of Guinea,
 * and in practice it means a phone answered with an empty GPS fix rather than a
 * lorry that has driven to the Atlantic. Letting it through puts a marker in
 * the ocean and ruins the trip distance total.
 */
function parseLatLng(rawLat, rawLng, prefix = "") {
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  const latField = prefix ? `${prefix}.lat` : "lat";
  const lngField = prefix ? `${prefix}.lng` : "lng";

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw errors.validation("That latitude is not valid.", {
      [latField]: "must be between -90 and 90",
    });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw errors.validation("That longitude is not valid.", {
      [lngField]: "must be between -180 and 180",
    });
  }
  if (lat === 0 && lng === 0) {
    throw errors.validation("That location looks like an empty GPS fix.", {
      [latField]: "must not be the null island (0, 0)",
    });
  }
  return { lat, lng };
}

/* A place on the map, with the human name the owner actually reads. */
function parsePlace(raw, field, { required = true } = {}) {
  if (isNil(raw) || typeof raw !== "object") {
    if (required) {
      throw errors.validation(`${field} is required.`, { [field]: "is required" });
    }
    return null;
  }
  const name = parseText(raw.name, `${field}.name`, { max: 160, label: field });
  const out = {
    name,
    address: parseOptionalText(raw.address, `${field}.address`, 300),
  };
  /*
   * Coordinates are optional. An owner keying in a trip at eleven at night
   * knows "Rayagada" and should not have to look up a decimal degree before the
   * trip can exist; the map fills them in later.
   */
  if (!isNil(raw.lat) && !isNil(raw.lng)) {
    const { lat, lng } = parseLatLng(raw.lat, raw.lng, field);
    out.lat = lat;
    out.lng = lng;
  }
  return out;
}

module.exports = {
  isNil,
  parseEmail,
  parsePassword,
  parseText,
  parseOptionalText,
  parseAmount,
  parseInteger,
  parsePercent,
  parseEnum,
  parseDate,
  parseDateOnly,
  parseTime,
  parseSlug,
  parseBoolean,
  parsePhone,
  parseMobile,
  parseGender,
  parseBloodGroup,
  parseObjectId,
  parsePaging,
  pageResult,
  parseRegistration,
  parseLatLng,
  parsePlace,
  GENDERS,
  BLOOD_GROUPS,
};
