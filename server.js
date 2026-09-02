require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const { sendError, errors } = require("./utils/apiError");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const meRoutes = require("./routes/me");
const employeeRoutes = require("./routes/employees");
const companyRoutes = require("./routes/company");
const customerRoutes = require("./routes/customers");
const vehicleRoutes = require("./routes/vehicles");
const driverRoutes = require("./routes/drivers");
const tripRoutes = require("./routes/trips");
const expenseRoutes = require("./routes/expenses");
const estimateRoutes = require("./routes/estimates");
const trackingRoutes = require("./routes/tracking");
const paymentRoutes = require("./routes/payments");
const reportRoutes = require("./routes/reports");
const dashboardRoutes = require("./routes/dashboard");

/*
 * MyTransport — a cloud transportation management and profitability API.
 *
 * The whole product is built around one idea, and it is worth stating at the
 * entry point because every design decision downstream follows from it:
 *
 *   the TRIP is the spine, and GPS is one of its attributes.
 *
 * A trip has a customer, a price, an expense ledger and a profit whether or not
 * a single phone ever reports a position. Live tracking attaches to a trip; it
 * is not the thing trips live inside. That is what keeps the business usable on
 * the day a driver's handset is flat, and it is why the location history is a
 * separate collection referenced from the trip rather than the other way round.
 *
 * Everything is multi-tenant from the first commit. Every document carries a
 * companyId, every query is scoped by it, and that id is read from the
 * authenticated account — never from a header, a path or a body field.
 */

const app = express();

/* ================= middleware ================= */

/*
 * CORS is an allowlist read from the environment. The wildcard is available for
 * local development and is what CORS_ORIGINS defaults to, but a comma-separated
 * list is what should be deployed: this API is opened by a browser app carrying
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
       * call. Those are not subject to the browser's same-origin rules in the
       * first place, so refusing them here would block the driver app while
       * protecting nobody. */
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options(/.*/, cors());

/*
 * The body limit is 1 MB rather than Express's 100 kB default, because of one
 * endpoint: a driver phone that has been offline for two days uploads its whole
 * backlog in a single batch. Several hundred location fixes with their speeds,
 * headings and accuracies runs past 100 kB comfortably, and it would be
 * rejected by the body parser before the route ever saw it — as a parser error
 * rather than as this API's own 413.
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/*
 * Behind a load balancer, so `req.ip` is the client rather than the proxy. The
 * rate limiter and the audit log both record it, and without this every request
 * in production appears to come from the same address.
 */
app.set("trust proxy", 1);

/* ================= routes =================
 * Everything is under /api/v1. Versioning the path from the first release is
 * nearly free now and is the only thing that makes a breaking change possible
 * later without a flag day across every deployed driver phone — handsets that
 * update when their owner remembers, if ever.
 */
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
/* The driver's own module. Identity-scoped — see routes/me.js. */
app.use("/api/v1/me", meRoutes);
app.use("/api/v1/company", companyRoutes);
app.use("/api/v1/customers", customerRoutes);
app.use("/api/v1/vehicles", vehicleRoutes);
app.use("/api/v1/drivers", driverRoutes);
/* Drivers, helpers and labour as one payroll — see routes/employees.js. */
app.use("/api/v1/employees", employeeRoutes);
app.use("/api/v1/trips", tripRoutes);
app.use("/api/v1/expenses", expenseRoutes);
app.use("/api/v1/estimates", estimateRoutes);
app.use("/api/v1/tracking", trackingRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/dashboard", dashboardRoutes);

/*
 * A health check that does not touch the database, so a load balancer probing
 * it every few seconds cannot itself become load — and so a database outage
 * shows up as failing requests rather than as an instance being killed and
 * restarted into the same outage.
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "mytransport-api",
    /* 1 is connected, in Mongoose's own vocabulary. Reported rather than acted
     * on: this endpoint answers whether the process is alive. */
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    time: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({ service: "MyTransport API", version: "1.0.0", docs: "/api/v1" });
});

/* Unknown /api/v1 paths answer in the contract's error shape, not Express HTML.
 * A driver app parsing JSON should never be handed a stack-trace page. */
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

/* ================= start ================= */

const PORT = Number(process.env.PORT) || 5100;

if (!process.env.MONGO_URI || !process.env.JWT_SECRET) {
  /*
   * Refusing to start is the right behaviour. A missing JWT_SECRET makes
   * jsonwebtoken throw on every sign-in, which looks like a broken login rather
   * than a missing environment variable, and costs an afternoon on the wrong
   * question.
   */
  console.error(
    "[startup] MONGO_URI and JWT_SECRET must both be set. Copy .env.example to .env."
  );
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("[startup] MongoDB connected");
    app.listen(PORT, () => {
      console.log(`[startup] MyTransport API listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[startup] could not connect to MongoDB:", err.message);
    process.exit(1);
  });

/*
 * Close the database connection on shutdown so in-flight writes finish rather
 * than being cut off mid-batch — which, for the tracking endpoint, means a
 * phone's backlog that was accepted but not stored.
 */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log(`[shutdown] ${signal} received`);
    await mongoose.connection.close().catch(() => {});
    process.exit(0);
  });
}

module.exports = app;
