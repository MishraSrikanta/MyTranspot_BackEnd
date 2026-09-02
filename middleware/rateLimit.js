const { errors, sendError } = require("../utils/apiError");

/*
 * A small in-process rate limiter, applied to the two endpoints that are worth
 * protecting: sign-in, and the tracking upload.
 *
 * In-process is an honest limitation and is stated here rather than discovered
 * later: with more than one server instance behind a load balancer, each holds
 * its own counters and the effective limit multiplies by the instance count.
 * That is fine for what this is for — stopping a runaway handset and slowing a
 * password guesser — and the day it is not, this file is replaced by Redis
 * without any route changing.
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

/*
 * Sign-in. Keyed on the IP and the email together, so one office behind a
 * single connection cannot lock out its own staff by getting one password
 * wrong repeatedly — a real problem in a transport office where everybody
 * shares a broadband line.
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

module.exports = { rateLimit, loginRateLimit, trackingRateLimit, clientIp };
