require("dotenv").config();

const mongoose = require("mongoose");

/* Requiring the models is what registers their schemas — and therefore their
 * index definitions — with Mongoose. Nothing else in this file uses them. */
require("../models/Company");
require("../models/Account");
require("../models/Customer");
require("../models/Driver");
require("../models/Vehicle");
require("../models/Trip");
require("../models/TripExpense");
require("../models/LocationPing");
require("../models/VehicleState");
require("../models/Estimate");
require("../models/Payment");
require("../models/AuditLog");
require("../models/Counter");

/*
 * Build every index the models declare, then print what the database actually
 * has.
 *
 * Mongoose creates indexes in the background on connect by default, which is
 * fine in development and is not something to rely on in production: index
 * creation on a collection with millions of location pings is a job that should
 * be run deliberately, watched, and known to have finished — not something that
 * happens silently while the first request of the morning waits on it.
 *
 *   node scripts/check-indexes.js
 *
 * The output is worth reading rather than skimming. The two indexes that decide
 * whether this product stays fast are on LocationPing — (tripId, recordedAt)
 * for replay and (vehicleId, recordedAt) unique for the offline-batch dedupe —
 * and the compound companyId indexes on Trip, which every report depends on.
 */

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected to ${mongoose.connection.name}\n`);

  const models = mongoose.modelNames().sort();

  for (const name of models) {
    const model = mongoose.model(name);
    process.stdout.write(`${name}: building... `);
    try {
      await model.createIndexes();
      console.log("ok");
    } catch (err) {
      /*
       * The usual cause is real data that violates a unique index being added
       * after the fact — two vehicles sharing a plate, say. It is reported and
       * the run continues, because the other collections' indexes are still
       * worth building and stopping here would hide them.
       */
      console.log(`FAILED: ${err.message}`);
      continue;
    }

    const indexes = await model.collection.indexes();
    const count = await model.collection.estimatedDocumentCount();
    console.log(`  documents: ~${count}`);
    for (const idx of indexes) {
      const keys = Object.entries(idx.key)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
      const flags = [
        idx.unique ? "unique" : null,
        idx.sparse ? "sparse" : null,
        idx.partialFilterExpression ? "partial" : null,
      ].filter(Boolean);
      console.log(`  - ${idx.name}  {${keys}}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
    }
    console.log("");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
