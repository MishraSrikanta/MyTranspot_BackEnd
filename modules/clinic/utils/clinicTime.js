/*
 * Dates and times in the clinic's own timezone.
 *
 * ================= why this file exists at all =================
 *
 * Every date in this module is a "YYYY-MM-DD" string and every time is an
 * "HH:mm" string, both meaning a wall-clock moment in the town the clinic is
 * in. That is the correct model — an appointment at nine is at nine, whatever
 * the server thinks — but it means "is this slot still in the future?" cannot
 * be answered by comparing to `new Date()`.
 *
 * The specific trap, and it is not hypothetical:
 *
 *   new Date().toISOString().slice(0, 10)
 *
 * That is UTC's idea of today, and in India it rolls over at 05:30 local. Use
 * it to expire yesterday's slots and, every single morning between midnight and
 * half past five, the clinic's entire working day is marked expired while
 * patients are arriving for it.
 *
 * So every comparison goes through here, and every one of them takes the
 * clinic's IANA timezone.
 *
 * Intl rather than a date library: the timezone database ships with Node, it is
 * kept current by the runtime rather than by a dependency somebody has to
 * remember to update, and this module needs exactly two operations from it.
 */

/*
 * Today, in the clinic's timezone, as "YYYY-MM-DD".
 *
 * "en-CA" is not a stylistic choice: it is the locale whose short date format
 * is already ISO order, so this needs no reassembly and cannot get the parts
 * the wrong way round.
 */
function todayIn(timezone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch (err) {
    /*
     * An unrecognised timezone — a typo in a clinic row, or a Node build with a
     * trimmed ICU — must not take the booking page down. Falling back to the
     * product's home timezone is wrong by at most a few hours for one clinic,
     * where throwing is wrong by the whole endpoint for everybody.
     */
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
}

/* The current wall-clock time there, as "HH:mm", 24-hour and zero-padded. */
function timeNowIn(timezone, now = new Date()) {
  const format = (tz) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);

  let value;
  try {
    value = format(timezone || "Asia/Kolkata");
  } catch (err) {
    value = format("Asia/Kolkata");
  }
  /* Some ICU builds render midnight as "24:00". Normalised, because "24:00"
   * sorts after every real time and would make the whole of the following day
   * look as though it had already passed. */
  return value === "24:00" ? "00:00" : value;
}

/* The weekday there, 0 = Sunday — the same convention as Clinic.workingDays. */
function weekdayIn(timezone, dateString) {
  /* Parsed as UTC noon rather than midnight. A date-only string is UTC by
   * specification, and midnight UTC is the previous evening in the Americas and
   * the same morning in Asia — noon is far enough from both edges that no
   * timezone on earth reads it as a different day. */
  const at = new Date(`${dateString}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;

  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "Asia/Kolkata",
    weekday: "short",
  }).format(at);

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/*
 * Is this slot still ahead of the clinic's own clock?
 *
 * Compared as strings, which works precisely because both formats are
 * zero-padded and big-endian: "2026-09-12" > "2026-09-08" and "10:15" > "09:15"
 * as text exactly as they do as times. No parsing, no offset arithmetic, and
 * nothing that can drift by an hour when the clocks change.
 *
 * This is called on every read of the slot list and on every booking — §5.2 of
 * the spec, the read-time filter that means a missed cron run cannot let
 * somebody book yesterday.
 */
function isFuture(timezone, date, startTime, now = new Date()) {
  const today = todayIn(timezone, now);
  if (date > today) return true;
  if (date < today) return false;
  return String(startTime) > timeNowIn(timezone, now);
}

/*
 * The UTC instant of a wall-clock time in the clinic's zone.
 *
 * ================= why this is not one line =================
 *
 * There is no way to ask JavaScript "what instant is 23:59 on this date in
 * Asia/Kolkata?" directly. Intl only converts the other way — instant to local
 * parts — so this guesses, measures how wrong the guess was, and corrects it.
 *
 * The guess is the same wall-clock reading interpreted as UTC. Formatting that
 * guess back into the target zone says how far the zone is from UTC at that
 * moment, and subtracting the difference lands on the real instant.
 *
 * Done twice, because the offset itself can change between the guess and the
 * answer: on a daylight-saving night the first correction can step across the
 * transition, and the second settles it. India has no DST, so in practice the
 * second pass is a no-op here — it is there so that a clinic in a zone that
 * does have one is not an hour out twice a year.
 *
 * ================= and why each pass starts from `wall` =================
 *
 * Every correction is measured against the ORIGINAL wall-clock reading, never
 * against the previous pass's output. Chaining them — `instant = instant -
 * offset(instant)` — subtracts the offset again on every iteration instead of
 * refining one subtraction, which is a real bug this code had:
 *
 *   pass 1:  23:59Z − 5:30  =  18:29Z   ← correct
 *   pass 2:  18:29Z − 5:30  =  12:59Z   ← five and a half hours early
 *
 * Every slot's expiresAt was written 5½ hours before the end of its retention
 * window, so the TTL monitor deleted the day's bookings while a clinic in India
 * was still reconciling them. Starting from `wall` each time makes the loop
 * converge — pass two returns the same instant as pass one unless the offset
 * genuinely differs there, which is exactly the DST case it exists for.
 */
function zonedTimeToUtc(timezone, date, time = "00:00") {
  const zone = timezone || "Asia/Kolkata";

  /* The wall-clock reading, interpreted as UTC. This is the fixed point every
   * pass measures from; it is never reassigned. */
  const wall = new Date(`${date}T${time}:00.000Z`);
  if (Number.isNaN(wall.getTime())) return null;

  let instant = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = new Date(wall.getTime() - offsetMsAt(instant, zone));
  }
  return instant;
}

/* How far ahead of UTC the zone is at a given instant, in milliseconds. */
function offsetMsAt(instant, zone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
  } catch (err) {
    /* An unrecognised zone must not take the booking page down. */
    return 5.5 * 60 * 60 * 1000;
  }

  const at = {};
  for (const part of parts) if (part.type !== "literal") at[part.type] = Number(part.value);
  const asUtc = Date.UTC(
    at.year,
    at.month - 1,
    at.day,
    /* Some ICU builds render midnight as hour 24. */
    at.hour % 24,
    at.minute,
    at.second
  );
  return asUtc - instant.getTime();
}

/*
 * When a slot document should die: the end of its day in the clinic's own
 * timezone, plus the practice's retention window.
 *
 * The end of the DAY rather than the end of the slot, so a clinic reconciling
 * the morning at six in the evening still has every slot from that day in front
 * of them rather than only the late ones.
 */
function slotExpiresAt(timezone, date, retentionHours = 48) {
  const endOfDay = zonedTimeToUtc(timezone, date, "23:59");
  if (!endOfDay) return null;
  return new Date(endOfDay.getTime() + Math.max(1, retentionHours) * 60 * 60 * 1000);
}

/*
 * Every date from `from` to `to` inclusive, as "YYYY-MM-DD".
 *
 * Walked at UTC noon so that adding a day never lands on a daylight-saving
 * boundary and produces the same date twice — the classic off-by-one in any
 * date arithmetic done at midnight. Bounded, because an unbounded range from a
 * typo would expand into a loop nothing stops.
 */
function eachDate(from, to, limit = 400) {
  const out = [];
  const at = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (Number.isNaN(at.getTime()) || Number.isNaN(end.getTime())) return out;

  while (at <= end && out.length < limit) {
    out.push(at.toISOString().slice(0, 10));
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return out;
}

/*
 * The weekday of a "YYYY-MM-DD" in the clinic's zone, 0 = Sunday — the same
 * convention as Clinic.workingDays and JavaScript's own getDay().
 */
function weekdayOf(timezone, date) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "Asia/Kolkata",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00Z`));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/*
 * Walk a start time to an end time in fixed steps, skipping a break.
 *
 * Returns [{ startTime, endTime }]. A step that would run past `endTime` is
 * dropped rather than truncated: half a consultation slot is not a slot, and
 * offering one produces an appointment nobody has time for.
 */
function expandTimes({ startTime, endTime, slotMinutes, breakStart, breakEnd }) {
  const toMinutes = (t) => {
    const [h, m] = String(t).split(":").map(Number);
    return h * 60 + m;
  };
  const toTime = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  const out = [];
  const end = toMinutes(endTime);
  const breakFrom = breakStart ? toMinutes(breakStart) : null;
  const breakTo = breakEnd ? toMinutes(breakEnd) : null;

  for (let at = toMinutes(startTime); at + slotMinutes <= end; at += slotMinutes) {
    const stop = at + slotMinutes;
    /* Any overlap with the break at all, not merely a start inside it: a slot
     * that begins at 10:50 and runs to 11:05 is half a lunch hour. */
    const inBreak =
      breakFrom !== null && breakTo !== null && at < breakTo && stop > breakFrom;
    if (inBreak) continue;
    out.push({ startTime: toTime(at), endTime: toTime(stop) });
  }
  return out;
}

/* The cursor the delta feed pages on: `updatedAt` in milliseconds and the id,
 * so two bookings written in the same millisecond cannot hide each other. */
function encodeCursor(updatedAt, id) {
  return `${new Date(updatedAt).getTime()}_${String(id)}`;
}

/*
 * Read a cursor back. A malformed one — an old client, a truncated value
 * pasted by hand — returns null and is treated as "from the beginning", which
 * re-sends bookings the app has already acknowledged. That is the safe
 * direction to fail: a duplicate is matched away by clientId in the workbook,
 * whereas skipping ahead loses an appointment.
 */
function decodeCursor(raw) {
  if (!raw) return null;
  const match = /^(\d+)_([0-9a-fA-F]{24})$/.exec(String(raw).trim());
  if (!match) return null;
  return { updatedAt: new Date(Number(match[1])), id: match[2] };
}

module.exports = {
  todayIn,
  zonedTimeToUtc,
  slotExpiresAt,
  eachDate,
  weekdayOf,
  expandTimes,
  timeNowIn,
  weekdayIn,
  isFuture,
  encodeCursor,
  decodeCursor,
};
