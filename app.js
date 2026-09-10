/*
 * The Express application, built and exported — and nothing else.
 *
 * ================= why this is separate from server.js =================
 *
 * There are two ways this API runs, and they disagree about the last ten lines
 * of a normal server file:
 *
 *   LOCALLY      a long-running process: connect to Mongo once, listen on a
 *                port, close the connection on SIGTERM. That is server.js.
 *
 *   DEPLOYED     a serverless function: no port to listen on, no process to
 *                exit, and a connection that has to be reused across
 *                invocations rather than opened per request. That is
 *                api/index.js, and `process.exit(1)` on a missing env var — the
 *                right behaviour for a server that must not start half-working
 *                — would there take down a request that could have returned a
 *                readable error instead.
 *
 * Everything above that line is identical, so it lives here and both entry
 * points import it.
 */

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const { sendError, errors } = require("./utils/apiError");
const { assertTokenModule } = require("./middleware/auth");

/*
 * ================= two products, one deployment =================
 *
 * This backend serves two things, and they are shaped very differently:
 *
 *   MyTransport  a conventional multi-user SaaS. Every screen is behind a
 *                login, every record lives in this database, and the API is
 *                the product.
 *
 *   MyClinic     a hybrid. Patients, billing, reports and the catalogue live
 *                in an Excel workbook on the clinic's own machines and never
 *                reach this server. Accounts, staff, SLOTS and the bookings
 *                inside them are cloud-only, because a patient books online at
 *                midnight and a booking that exists on one reception PC is not
 *                a booking. The slots are working memory: each expires a couple
 *                of days after its date and takes its bookings with it. No
 *                patient medical data, either way — see modules/clinic.
 *
 * They share the error envelope, the validators, the rate limiter and the
 * database connection. They share nothing else, and each lives under
 * modules/<name>/ with its own models, routes and utilities. The only file that
 * knows both exist is this one.
 */

/* Shared: one login form for both products. Registration asks which. */
const authRoutes = require("./routes/auth");

/* ================= transport ================= */
const userRoutes = require("./routes/users");
const meRoutes = require("./modules/transport/routes/me");
const employeeRoutes = require("./modules/transport/routes/employees");
const companyRoutes = require("./modules/transport/routes/company");
const customerRoutes = require("./modules/transport/routes/customers");
const vehicleRoutes = require("./modules/transport/routes/vehicles");
const driverRoutes = require("./modules/transport/routes/drivers");
const tripRoutes = require("./modules/transport/routes/trips");
const expenseRoutes = require("./modules/transport/routes/expenses");
const estimateRoutes = require("./modules/transport/routes/estimates");
const trackingRoutes = require("./modules/transport/routes/tracking");
const paymentRoutes = require("./modules/transport/routes/payments");
const reportRoutes = require("./modules/transport/routes/reports");
const dashboardRoutes = require("./modules/transport/routes/dashboard");

/* ================= clinic ================= */
const clinicPublicRoutes = require("./modules/clinic/routes/public");
const clinicSlotRoutes = require("./modules/clinic/routes/slots");
const clinicTokenRoutes = require("./modules/clinic/routes/tokens");
const clinicCloudRoutes = require("./modules/clinic/routes/cloud");
const clinicSyncRoutes = require("./modules/clinic/routes/sync");
const clinicAdminRoutes = require("./modules/clinic/routes/admin");

/* Shared: the vendor console's own surface — customers and their logins, across
 * both products. See routes/adminAccounts.js. */
const adminAccountRoutes = require("./routes/adminAccounts");
const clinicBackupRoutes = require("./modules/clinic/routes/backup");
const clinicCronRoutes = require("./modules/clinic/routes/cron");

const app = express();

/* ================= middleware ================= */

/*
 * CORS is an allowlist read from the environment. The wildcard is available for
 * local development and is what CORS_ORIGINS defaults to, but a comma-separated
 * list is what should be deployed: this API is opened by browser apps carrying
 * a bearer token, and a permissive policy in production means any page on the
 * internet can drive a signed-in owner's session.
 */
const allowedOrigins = String(process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      /* No Origin header at all: a mobile app, curl, or a server-to-server
       * call — which includes the clinic's desktop app posting its slots.
       * Those are not subject to the browser's same-origin rules in the first
       * place, so refusing them here would block the sync while protecting
       * nobody. */
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    /* The two credential headers this API accepts, alongside the bearer token.
     * A header missing from this list is a header the browser silently drops,
     * which surfaces as an inexplicable 401. */
    allowedHeaders: ["Content-Type", "Authorization", "X-Clinic-Key", "X-Admin-Secret"],
  })
);
app.options(/.*/, cors());

/*
 * The body limit is 1 MB rather than Express's 100 kB default, because of two
 * endpoints. A driver phone that has been offline for two days uploads its
 * whole backlog in a single batch; a clinic publishes a fortnight of slots in
 * one request, which for six doctors at fifteen-minute intervals is around
 * eight hundred rows. Both run past 100 kB comfortably, and would be rejected
 * by the body parser before the route ever saw them — as a parser error rather
 * than as this API's own 413.
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/*
 * A request with no body gets an empty object rather than `undefined`.
 *
 * Express 5 changed this: its JSON parser used to leave `req.body` as `{}` when
 * there was nothing to parse, and now leaves it unset. Every route that reads
 * an optional field off the body — `req.body.reason` on a cancellation, say —
 * then throws a TypeError and returns a 500 for a request that was perfectly
 * valid.
 *
 * Defaulting once here is better than `req.body?.` at ninety call sites,
 * because the ninety-first is the one somebody forgets, and it fails on the
 * path where the caller sent nothing — which is exactly the path nobody tests
 * by hand.
 */
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  return next();
});

/*
 * Behind a load balancer, so `req.ip` is the client rather than the proxy. The
 * rate limiter and the audit log both record it, and without this every request
 * in production appears to come from the same address — which would make the
 * public booking limiter throttle an entire city as one caller.
 */
app.set("trust proxy", 1);

/* ================= routes =================
 * Everything is under /api/v1. Versioning the path from the first release is
 * nearly free now and is the only thing that makes a breaking change possible
 * later without a flag day across every deployed driver phone and every
 * installed clinic app — clients that update when their owner remembers, if
 * ever.
 */

/* Shared. */
app.use("/api/v1/auth", authRoutes);

/*
 * Staff management. The one path both products own, dispatched on the token's
 * module claim — see routes/users.js for why it is not two prefixed paths.
 */
app.use("/api/v1/users", userRoutes);

/* ---------- transport ---------- */
/*
 * Every transport router sits behind the module gate.
 *
 * Its own requireAuth is not enough alone: a clinic OWNER short-circuits every
 * permission check by design, and the transport queries scope by
 * `req.companyId` — which is undefined for a clinic account, and an undefined
 * value is STRIPPED from a Mongoose filter rather than matching nothing. Three
 * reasonable behaviours composing into an unscoped query. See
 * middleware/auth.js.
 */
const transportOnly = assertTokenModule("transport");

/* The driver's own module. Identity-scoped — see modules/transport/routes/me.js. */
app.use("/api/v1/me", transportOnly, meRoutes);
app.use("/api/v1/company", transportOnly, companyRoutes);
app.use("/api/v1/customers", transportOnly, customerRoutes);
app.use("/api/v1/vehicles", transportOnly, vehicleRoutes);
app.use("/api/v1/drivers", transportOnly, driverRoutes);
/* Drivers, helpers and labour as one payroll. */
app.use("/api/v1/employees", transportOnly, employeeRoutes);
app.use("/api/v1/trips", transportOnly, tripRoutes);
app.use("/api/v1/expenses", transportOnly, expenseRoutes);
app.use("/api/v1/estimates", transportOnly, estimateRoutes);
app.use("/api/v1/tracking", transportOnly, trackingRoutes);
app.use("/api/v1/payments", transportOnly, paymentRoutes);
app.use("/api/v1/reports", transportOnly, reportRoutes);
app.use("/api/v1/dashboard", transportOnly, dashboardRoutes);

/* ---------- clinic ---------- */
/* Patient-facing. No authentication of any kind — see the module's routes. */
app.use("/api/v1/public", clinicPublicRoutes);
/*
 * The console's own surfaces, behind a session.
 *
 * Slots are cloud-only and each one carries its own bookings, so there is no
 * /appointments router any more — a booking is not a document of its own. The
 * queue is a projection of today's slots rather than a collection of its own
 * either. See modules/clinic/models/Slot.js.
 */
app.use("/api/v1/slots", clinicSlotRoutes);
app.use("/api/v1/tokens", clinicTokenRoutes);
/* Google Drive: the OAuth handshake and the workbook backup. */
app.use("/api/v1/cloud", clinicCloudRoutes);
/* The clinic app, authenticating with its long-lived X-Clinic-Key. */
app.use("/api/v1/sync", clinicSyncRoutes);
/* Cloud backup of the clinic's workbook — same key, same rate-limit bucket.
 * Mounted unconditionally: the routes answer honestly when no bucket is
 * configured, which is more useful than a path that does not exist. */
app.use("/api/v1/backup", clinicBackupRoutes);

/*
 * Provisioning, mounted only when there is a secret to guard it with.
 *
 * Not merely hidden: a deployment without ADMIN_SECRET does not have these
 * routes at all, and the 404 an unknown path already produces is the honest
 * answer. An admin API that opens itself when a variable is missing is an admin
 * API that is wide open on the first deployment where somebody forgets one.
 */
if (process.env.ADMIN_SECRET) {
  /*
   * Mounted alongside, not instead. The two routers share the prefix and split
   * cleanly by path — this one owns /tenants and /accounts, provisioning owns
   * /clinics — so neither has to know the other exists.
   *
   * **The order matters, and not for the usual reason.** A router's `router.use`
   * runs for every request that reaches the mount prefix, matched route or not,
   * and the clinic router's chain opens with `adminRateLimit`: twenty requests
   * per fifteen minutes, sized for provisioning a clinic, not for a console that
   * lists every tenant the moment it loads. Mounted second, this router's
   * traffic spent that budget on its way past, and the operator was locked out
   * of a screen they had only just opened. First, its own paths are answered
   * before the clinic chain is entered at all.
   */
  app.use("/api/v1/admin", adminAccountRoutes);
  app.use("/api/v1/admin", clinicAdminRoutes);
}

/*
 * The scheduled sweep that closes past days.
 *
 * Deliberately NOT under /api/v1: it is not part of the product's contract, it
 * is machinery, and putting it under the versioned path would imply a client
 * somewhere is entitled to call it. Guarded by CRON_SECRET, and likewise only
 * mounted when there is one.
 */
if (process.env.CRON_SECRET) {
  app.use("/api/cron", clinicCronRoutes);
}

/*
 * A health check that does not touch the database, so a load balancer probing
 * it every few seconds cannot itself become load — and so a database outage
 * shows up as failing requests rather than as an instance being killed and
 * restarted into the same outage.
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "myclinic-api",
    modules: ["transport", "clinic"],
    /* 1 is connected, in Mongoose's own vocabulary. Reported rather than acted
     * on: this endpoint answers whether the process is alive. */
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    time: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "MyTransport + MyClinic API",
    version: "4.0.0",
    modules: {
      transport: "/api/v1/{trips,vehicles,drivers,…}",
      clinic: "/api/v1/{public,slots,tokens,sync,cloud}",
    },
    docs: "/api/v1",
  });
});

/* Unknown /api/v1 paths answer in the contract's error shape, not Express HTML.
 * A driver app or a clinic sync parsing JSON should never be handed a
 * stack-trace page. */
app.use("/api/v1", (req, res) => sendError(res, errors.notFound()));

/*
 * The last line of defence. A malformed body is rejected by the parser before
 * any route runs, so it is translated here rather than in every handler — and
 * this is also what guarantees no stack trace ever reaches a client.
 */
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return sendError(
      res,
      errors.payloadTooLarge("That request is too large. Send it in smaller batches.")
    );
  }
  if (err && err.type === "entity.parse.failed") {
    return sendError(res, errors.validation("The request body is not valid JSON."));
  }
  if (err && err.message === "Not allowed by CORS") {
    return sendError(res, errors.forbidden("This origin is not allowed to call the API."));
  }
  return sendError(res, err);
});

module.exports = app;
