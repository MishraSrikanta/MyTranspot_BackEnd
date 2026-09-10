require("dotenv").config();

const mongoose = require("mongoose");
const { connectToDatabase } = require("../db");

require("../modules/clinic/models/Slot");

/*
 * Drop the indexes the v4 Slot model left behind.
 *
 * ================= the bug this fixes =================
 *
 * Publishing a fortnight of slots created exactly ONE, and the API reported the
 * other sixty-three as "already existed".
 *
 * The cause was this index, built by the v2/v3 Slot schema and still on the
 * collection:
 *
 *     UNIQUE { clinicId: 1, clientId: 1 }
 *
 * `clientId` was the offline-sync key on the old schema. The v4 model has no
 * such field, and Mongo indexes a missing field as `null` — so a unique index
 * over it means "one slot per clinic, ever". The first insert of the batch won
 * and every subsequent one failed with E11000.
 *
 * ================= why it survived the rewrite =================
 *
 * Mongoose only ever CREATES indexes. `autoIndex` and `createIndexes()` both
 * add what the schema declares and neither removes what it no longer declares,
 * so dropping a schema field silently leaves its index in place — enforcing a
 * constraint that exists nowhere in the code. `scripts/check-indexes.js` prints
 * the collection's real indexes for exactly this reason; this script is the
 * other half of that, the part that removes.
 *
 * Safe to run more than once: an index that is already gone is reported and
 * skipped. Dropping an index is also reversible — the definitions are below,
 * should any of them ever turn out to be wanted again.
 *
 *   node scripts/drop-stale-slot-indexes.js
 *   node scripts/drop-stale-slot-indexes.js --dry-run
 */

/*
 * Every one of these names a field that no v4 slot document has. Listed by
 * name rather than matched by pattern: dropping an index is a deliberate act
 * and a pattern would eventually match one somebody still needs.
 */
const STALE = [
  {
    name: "clinicId_1_clientId_1",
    was: "UNIQUE { clinicId, clientId }",
    why: "clientId was the v2/v3 offline-sync key. Missing on every v4 document, so it indexes as null and permits ONE slot per clinic. This is the blocker.",
  },
  {
    name: "clinicId_1_date_1_doctorClientId_1_status_1",
    was: "{ clinicId, date, doctorClientId, status }",
    why: "doctorClientId and status are both gone — a doctor is a snapshot at doctor.id, and a slot has no status.",
  },
  {
    name: "clinicId_1_date_1_status_1",
    was: "{ clinicId, date, status }",
    why: "No status field. Superseded by { clinicId, date, available } for the public availability read.",
  },
  {
    name: "status_1",
    was: "{ status }",
    why: "No status field.",
  },
];

/*
 * The indexes the v4 model DOES declare. Checked afterwards, because the whole
 * point of the exercise is that the collection matches the schema — and a
 * missing unique index here would be the opposite failure: duplicate 10:15s,
 * two patients, one time.
 */
const REQUIRED = [
  "clinicId_1_doctor.id_1_date_1_startTime_1",
  "ownerId_1_clinicId_1_date_1_startTime_1",
  "clinicId_1_date_1_available_1",
  "expiresAt_1",
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  await connectToDatabase();
  const collection = mongoose.model("Slot").collection;
  console.log(`[drop-stale-slot-indexes] ${collection.dbName}.${collection.collectionName}`);
  if (dryRun) console.log("[drop-stale-slot-indexes] DRY RUN — nothing will be dropped");
  console.log("");

  const present = new Set((await collection.indexes()).map((ix) => ix.name));

  for (const index of STALE) {
    if (!present.has(index.name)) {
      console.log(`  · ${index.name}\n      already gone`);
      continue;
    }
    console.log(`  ${dryRun ? "would drop" : "DROPPING"} ${index.name}`);
    console.log(`      ${index.was}`);
    console.log(`      ${index.why}`);
    if (!dryRun) {
      await collection.dropIndex(index.name);
      console.log("      dropped");
    }
  }

  /*
   * Rebuild from the schema in the same run. A collection that has just had
   * indexes removed is the exact moment to confirm the ones that matter are
   * there — and `createIndexes()` is idempotent, so this costs nothing when
   * they already are.
   */
  if (!dryRun) {
    console.log("\n  rebuilding the declared indexes");
    await mongoose.model("Slot").createIndexes();
  }

  console.log("\n=== the collection now ===");
  const after = await collection.indexes();
  for (const ix of after) {
    const keys = Object.entries(ix.key)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
    const flags = [ix.unique ? "unique" : null, ix.expireAfterSeconds !== undefined ? `ttl=${ix.expireAfterSeconds}` : null]
      .filter(Boolean)
      .join(" ");
    console.log(`  ${ix.name}  { ${keys} }${flags ? `  [${flags}]` : ""}`);
  }

  const names = new Set(after.map((ix) => ix.name));
  const missing = REQUIRED.filter((n) => !names.has(n));
  const remaining = STALE.filter((s) => names.has(s.name));

  console.log("");
  if (missing.length) {
    console.log(`FAIL: the model declares indexes the collection does not have: ${missing.join(", ")}`);
    console.log("      Run node scripts/check-indexes.js");
    process.exitCode = 1;
  } else if (remaining.length && !dryRun) {
    console.log(`FAIL: still present: ${remaining.map((r) => r.name).join(", ")}`);
    process.exitCode = 1;
  } else if (dryRun) {
    console.log("Dry run complete. Re-run without --dry-run to apply.");
  } else {
    console.log("Done. Slot creation will now write every slot in the pattern.");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[drop-stale-slot-indexes] failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* Already down. */
  }
  process.exit(1);
});
