const mongoose = require("mongoose");

/*
 * One database connection, reused.
 *
 * ================= why this is not just mongoose.connect() =================
 *
 * On a long-running server, connecting once at startup is the whole story. On a
 * serverless platform it is not: the function is invoked per request, the module
 * may be evaluated again on a cold start, and several invocations can be alive
 * at once in the same container. Calling `connect()` per invocation opens a new
 * connection pool every time, and a busy morning takes an Atlas cluster to its
 * connection limit — which surfaces as intermittent 500s that are impossible to
 * reproduce locally, because locally there is only ever one process.
 *
 * So the connection PROMISE is cached on the Node global. The global survives
 * between invocations that share a container, which is most of them, and the
 * promise rather than the connection is what is cached so that two requests
 * arriving during a cold start wait on the same connect rather than starting
 * two.
 *
 * `global` and not a module-level variable: a bundler can end up with two
 * copies of this module in one function, and two module scopes would each open
 * their own pool while both believing they were the only one.
 */

const cache = globalThis.__mytransportMongo || { connection: null, promise: null };
globalThis.__mytransportMongo = cache;

async function connectToDatabase() {
  if (cache.connection) return cache.connection;

  if (!cache.promise) {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error(
        "MONGO_URI is not set. Add it to the environment (locally: backend/.env; on Vercel: project settings → Environment Variables)."
      );
    }

    cache.promise = mongoose
      .connect(uri, {
        /*
         * Fail fast rather than hang. A serverless invocation has a hard time
         * limit, and the default 30-second server-selection timeout means a
         * misconfigured URI or an IP that is not on the Atlas allowlist shows up
         * as a request that times out with no explanation instead of an error
         * that names the problem.
         */
        serverSelectionTimeoutMS: 8000,
        /*
         * A small pool per container. Serverless scales by adding containers,
         * not by growing one pool, so the default of 100 per instance is how a
         * cluster runs out of connections while barely serving traffic.
         */
        maxPoolSize: 10,
      })
      .then((instance) => {
        cache.connection = instance;
        return instance;
      })
      .catch((err) => {
        /* A failed connect must not be cached, or every later request in this
         * container replays the failure for as long as it lives. */
        cache.promise = null;
        throw err;
      });
  }

  return cache.promise;
}

module.exports = { connectToDatabase };
