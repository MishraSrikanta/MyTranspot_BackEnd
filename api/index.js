const app = require("../app");
const { connectToDatabase } = require("../db");

/*
 * The serverless entry point.
 *
 * ================= what is different from server.js =================
 *
 * A serverless function is invoked per request. There is no port to listen on,
 * no startup to fail at, and no process whose lifetime matches the
 * application's — so the three things a normal server file does at the bottom
 * all have to be done differently:
 *
 *   LISTENING     the platform owns the socket. The export below IS the server;
 *                 Express apps are already (req, res) handlers, which is why
 *                 this can hand the app straight over.
 *
 *   CONNECTING    once per container rather than once per process, and reused
 *                 across invocations. See db.js — connecting per request is how
 *                 a quiet morning exhausts an Atlas connection limit.
 *
 *   FAILING       \`process.exit(1)\` on a missing environment variable is right
 *                 for a server that must not start half-configured. Here it
 *                 kills a request that could have said what was wrong, and the
 *                 platform reports it as an opaque crash. A misconfiguration
 *                 returns a 503 that names the missing variable instead.
 *
 * ================= why the connection is awaited here =================
 *
 * It could be middleware inside the app, and then the local server and this one
 * would take different paths through the same code — which is exactly the sort
 * of difference that makes a deployment behave unlike development. The app is
 * identical in both; only its surroundings differ, and this file is the
 * surroundings.
 */
module.exports = async function handler(req, res) {
  if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
    return fail(res, "MONGO_URI is not set on this deployment.");
  }
  if (!process.env.JWT_SECRET) {
    /*
     * Caught before the request reaches a route, because without it every
     * sign-in throws inside jsonwebtoken and surfaces as a 500 that says
     * nothing about the actual cause.
     */
    return fail(res, "JWT_SECRET is not set on this deployment.");
  }

  try {
    await connectToDatabase();
  } catch (err) {
    return fail(res, `Could not reach the database: ${err.message}`);
  }

  return app(req, res);
};

/*
 * A configuration failure, in the same envelope every other error in this API
 * uses — so the frontend's error handling shows the message rather than falling
 * back to "something went wrong".
 */
function fail(res, message) {
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json");
  /* The browser has to be able to read this. A configuration error that is
   * blocked by CORS is a configuration error nobody can see. */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(
    JSON.stringify({
      error: {
        code: "SERVICE_UNCONFIGURED",
        message,
        details: null,
      },
    })
  );
}
