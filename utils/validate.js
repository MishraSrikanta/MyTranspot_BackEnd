const { errors } = require("./apiError");

/*
 * Small parsers shared by every route. They all follow one rule: a bad value
 * throws a 400 with a field-level detail, rather than being coerced. Silently
 * reading "twelve thousand" as 0 would post a trip with no fuel cost and a
 * profit figure the owner would believe.
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
 * Money and quantities. Negative is refused everywhere: a "-5000" fuel entry
 * would silently work as a credit note and quietly inflate the trip's profit,
 * with nothing in the ledger to show what happened.
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

function parseEnum(raw, field, allowed, { fallback = null, label } = {}) {
  if (isNil(raw)) {
    if (fallback === null) {
      throw errors.validation(`${label || field} is required.`, {
        [field]: `must be one of: ${allowed.join(", ")}`,
      });
    }
    return fallback;
  }
  const value = String(raw).trim().toUpperCase();
  const match = allowed.find((a) => a.toUpperCase() === value);
  /*
   * An unrecognised value is refused rather than defaulted. Reading a mistyped
   * "FEUL" as "OTHER" would hide a fuel overspend inside the miscellaneous line
   * of every expense report that quarter.
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
   * office — so a report for September would silently drop anything that
   * happened in the first five and a half hours of the 1st, and would disagree
   * with the server's own default period, which is built from local parts.
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

function parseBoolean(raw, fallback = false) {
  if (isNil(raw)) return fallback;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

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
  parseEnum,
  parseDate,
  parseBoolean,
  parseRegistration,
  parsePhone,
  parseLatLng,
  parsePlace,
};
