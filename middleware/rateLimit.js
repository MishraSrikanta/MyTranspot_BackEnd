const { errors, sendError } = require("../utils/apiError");

/*
 * A small in-process rate limiter, applied to the endpoints worth protecting:
 * sign-in and the location upload on the transport side, and the whole
 * unauthenticated booking surface on the clinic side.
 *
 * In-process is an honest limitation and is stated here rather than discovered
 * later: with more than one server instance behind a load balancer, each holds
 * its own counters and the effective limit multiplies by the instance count.
 * That is fine for what this is for — slowing a password guesser, catching a
 * runaway handset, and stopping a bot filling a clinic's day — and the day it
 * is not, this file is replaced by Redis without any route changing.
 */

const buckets = new Map();

/*
 * Windows expire lazily, when their key is next touched, so a bucket for an IP
 * that never comes back would sit in memory for ever. The sweep is cheap
 * because the map only ever holds active callers, and it is unref'd so it can
 * never hold the process open on shutdown.
 */
const SWEEP_MS = 5 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

function rateLimit({ windowMs, max, keyFn, message }) {
  return function limit(req, res, next) {
    const key = keyFn(req);
    if (!key) return next();

    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return sendError(res, errors.rateLimited(message));
    }
    return next();
  };
}

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();

/* ================= transport ================= */

/*
 * Sign-in. Keyed on the IP and the email together, so one office behind a
 * single connection cannot lock out its own staff by getting one password wrong
 * repeatedly — a real problem in a transport office where everybody shares a
 * broadband line.
 */
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => `login:${clientIp(req)}:${String(req.body?.email || "").toLowerCase()}`,
  message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

/*
 * Location uploads, keyed per vehicle rather than per IP: a dozen lorries
 * sharing one mobile network gateway must not throttle each other.
 *
 * The limit is generous on purpose. A phone coming back from a day offline
 * legitimately uploads a large backlog in several batches, and throttling it
 * there would leave the queue on the handset — which is the one failure this
 * whole subsystem exists to prevent. It is set to catch a genuinely broken app
 * in a retry loop, not a busy one.
 */
const trackingRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => `track:${req.account ? String(req.account._id) : clientIp(req)}`,
  message: "Too many location uploads. Slow down and try again shortly.",
});

/* ================= clinic ================= */

/*
 * Public booking, keyed on the IP AND the mobile number.
 *
 * Either alone leaves a hole. IP alone throttles a family booking three
 * appointments from one home connection; mobile alone lets a script walk
 * through numbers from one machine. Together they stop the case this exists
 * for: a bot filling every slot in a clinic's day with bookings nobody will
 * attend, which costs the clinic a morning of empty rooms and is invisible
 * until the patients do not arrive.
 */
const publicBookingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  /*
   * The field is `patientMobile` in v4 and was `patient.mobile` in v2. Both are
   * read, because a limiter that silently reads a key that no longer exists
   * degrades to "everyone from this IP shares one bucket" — which looks like it
   * is working right up until a busy household or a clinic's own wifi is locked
   * out by a stranger.
   */
  keyFn: (req) =>
    `book:${clientIp(req)}:${String(
      req.body?.patientMobile || req.body?.patient?.mobile || req.body?.mobile || ""
    )}`,
  message: "Too many booking attempts. Please try again in a few minutes.",
});

/*
 * Cancelling, on its own budget and keyed on IP alone.
 *
 * Deliberately NOT the booking bucket. A cancellation request carries no
 * mobile number — the publicRef in the path is the whole credential — so it
 * would fall into the empty-key bucket and share one allowance with every
 * other credential-less request from that address.
 *
 * More generous than booking, too, because the failure modes are not
 * symmetrical: a bot that books fills a clinic's day, while a bot that cancels
 * needs an unguessable 128-bit reference per attempt and gets nowhere. What
 * this actually protects against is somebody hammering the endpoint with
 * random refs, and thirty a minute stops that without ever troubling a patient
 * who taps Cancel twice.
 */
const publicCancelRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `cancel:${clientIp(req)}`,
  message: "Too many requests. Please wait a moment and try again.",
});

/*
 * The public read surface — a clinic page and the slot lookup a date picker
 * calls on every change. Generous, because a patient choosing a date
 * legitimately makes a dozen of these in a minute, and keyed on IP alone
 * because there is no identity to key on before a booking exists.
 */
const publicReadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => `pubread:${clientIp(req)}`,
  message: "Too many requests. Please slow down and try again shortly.",
});

/*
 * The sync API, keyed per CLINIC rather than per IP.
 *
 * The limit is a property of the installation, not of the broadband line it is
 * behind: two clinics in one building must not throttle each other, and one
 * clinic that moves to a mobile hotspot must not get a fresh allowance.
 *
 * Thirty a minute is comfortable for the real pattern — a status poll every
 * half minute, a publish when the schedule changes, a pull every few minutes —
 * and tight enough to notice an app stuck in a retry loop.
 */
const syncRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `sync:${req.clinic ? String(req.clinic._id) : clientIp(req)}`,
  message: "Too many sync requests. The app will retry shortly.",
});

/*
 * Provisioning. Used a handful of times per customer, so anything past twenty
 * in a quarter of an hour is somebody guessing the admin secret rather than
 * somebody creating clinics.
 */
const adminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => `admin:${clientIp(req)}`,
  message: "Too many admin requests. Please wait a few minutes.",
});

/*
 * The vendor console (routes/adminAccounts.js).
 *
 * Deliberately NOT adminRateLimit, which is sized for provisioning — twenty in
 * a quarter of an hour, because creating clinics is something somebody does a
 * handful of times per customer. A console is the opposite pattern: opening it
 * lists customers and logins and reads the catalogue, and every edit is another
 * request. Twenty would be exhausted before the first screen finished loading,
 * and the operator would be locked out of their own tool.
 *
 * Three hundred is generous for a person clicking around and still a hard stop
 * on a script. Unlike the provisioning limiter this one is mounted BEFORE the
 * secret check, so failed guesses are counted too — a limiter that runs after
 * authentication only ever throttles people who already hold the credential.
 */
const consoleRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyFn: (req) => `console:${clientIp(req)}`,
  message: "Too many console requests. Please wait a few minutes.",
});
module.exports = {
  rateLimit,
  clientIp,
  loginRateLimit,
  trackingRateLimit,
  publicBookingRateLimit,
  publicCancelRateLimit,
  publicReadRateLimit,
  syncRateLimit,
  adminRateLimit,
  consoleRateLimit,
};
