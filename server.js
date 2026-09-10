require("dotenv").config();

const app = require("./app");
const { connectToDatabase } = require("./db");
const mongoose = require("mongoose");

/*
 * Running the API as a long-lived local process.
 *
 * This is the development and self-hosted entry point. The serverless one is
 * api/index.js; both share backend/app.js, which is the whole application.
 */

const PORT = process.env.PORT || 5100;

if (!process.env.MONGO_URI || !process.env.JWT_SECRET) {
  /*
   * Refusing to start is the right behaviour for a process. A missing
   * JWT_SECRET makes jsonwebtoken throw on every sign-in, which looks like a
   * broken login rather than a missing environment variable, and costs an
   * afternoon on the wrong question.
   *
   * The serverless entry point deliberately does NOT do this — see api/index.js.
   */
  console.error(
    "[startup] MONGO_URI and JWT_SECRET must both be set. Copy .env.example to .env."
  );
  process.exit(1);
}

connectToDatabase()
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
