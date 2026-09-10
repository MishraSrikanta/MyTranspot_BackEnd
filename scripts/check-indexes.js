require("dotenv").config();

const mongoose = require("mongoose");
const { connectToDatabase } = require("../db");

/*
 * Build every index both modules declare, and say what happened.
 *
 * Mongoose creates indexes in the background on first use by default, which is
 * fine in development and is not a plan for production: the first slow morning
 * is the wrong moment to discover that the delta feed has been doing a
 * collection scan since launch. Running this at deploy time makes index
 * creation a step somebody watches rather than a side effect nobody sees.
 *
 *   node scripts/check-indexes.js
 */

/* Shared. */
require("../models/Account");
require("../models/AuditLog");
require("../models/Counter");

/* Transport. */
require("../modules/transport/models/Company");
require("../modules/transport/models/Customer");
require("../modules/transport/models/Driver");
require("../modules/transport/models/Employee");
require("../modules/transport/models/Vehicle");
require("../modules/transport/models/VehicleState");
require("../modules/transport/models/Trip");
require("../modules/transport/models/TripExpense");
require("../modules/transport/models/LocationPing");
require("../modules/transport/models/Estimate");
require("../modules/transport/models/Payment");

/* Clinic. */
require("../modules/clinic/models/Owner");
require("../modules/clinic/models/Clinic");
require("../modules/clinic/models/ClinicLicense");
require("../modules/clinic/models/Slot");
require("../modules/clinic/models/CloudConnection");

async function main() {
  await connectToDatabase();
  console.log("[check-indexes] connected\n");

  const names = mongoose.modelNames().sort();

  for (const name of names) {
    const model = mongoose.model(name);
    try {
      await model.createIndexes();
      const indexes = await model.collection.indexes();
      console.log(`${name} (${model.collection.collectionName})`);
      for (const index of indexes) {
        const keys = Object.entries(index.key)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ");
        const flags = [
          index.unique ? "unique" : null,
          index.sparse ? "sparse" : null,
          index.expireAfterSeconds !== undefined ? `ttl ${index.expireAfterSeconds}s` : null,
        ]
          .filter(Boolean)
          .join(" ");
        console.log(`  { ${keys} }${flags ? `  ${flags}` : ""}`);
      }
      console.log("");
    } catch (err) {
      /*
       * Reported rather than thrown, and the run continues.
       *
       * The usual cause is a unique index that cannot be built because the data
       * already violates it — two clinics on one slug, a duplicate slot for a
       * doctor. That is exactly the thing worth knowing about, and stopping at
       * the first one would hide the rest.
       */
      console.error(`${name}: ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}

main()
  .catch((err) => {
    console.error("[check-indexes] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
