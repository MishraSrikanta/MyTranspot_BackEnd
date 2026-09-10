require("dotenv").config();

const mongoose = require("mongoose");
const { connectToDatabase } = require("../db");

/*
 * One-off migration: Counter.companyId → Counter.tenantId.
 *
 * ================= why this has to be run, not skipped =================
 *
 * The counter collection is now shared by both modules, so its tenant field was
 * renamed to something that is true for both — a companyId for a transport
 * tenant, a clinicId for a clinic one.
 *
 * A renamed field on an existing deployment means the old rows no longer match,
 * `nextSequence` upserts a fresh row, and every sequence RESTARTS AT 1. The
 * next trip created would be TRP-000001 — a number already printed on a
 * customer's invoice eighteen months ago. Duplicate document numbers are the
 * kind of thing that is noticed at an audit rather than at a deployment.
 *
 * Safe to run more than once: rows that have already been migrated no longer
 * match the filter.
 *
 *   node scripts/migrate-counters.js          # report what would change
 *   node scripts/migrate-counters.js --apply  # do it
 */

async function main() {
  const apply = process.argv.includes("--apply");

  await connectToDatabase();
  const counters = mongoose.connection.collection("counters");

  const pending = await counters.countDocuments({
    companyId: { $exists: true },
    tenantId: { $exists: false },
  });

  if (!pending) {
    console.log("[migrate-counters] nothing to do — no rows still use companyId.");
    return;
  }

  if (!apply) {
    const sample = await counters
      .find({ companyId: { $exists: true }, tenantId: { $exists: false } })
      .limit(5)
      .toArray();
    console.log(`[migrate-counters] ${pending} row(s) would be renamed. For example:`);
    for (const row of sample) {
      console.log(`  ${row.key.padEnd(12)} seq=${row.seq}  companyId=${row.companyId}`);
    }
    console.log("[migrate-counters] re-run with --apply to make the change.");
    return;
  }

  /*
   * $rename rather than a read-modify-write loop: it is a single server-side
   * operation, so there is no window in which a counter has neither field and a
   * concurrent request could upsert a duplicate alongside it.
   */
  const result = await counters.updateMany(
    { companyId: { $exists: true }, tenantId: { $exists: false } },
    { $rename: { companyId: "tenantId" } }
  );
  console.log(`[migrate-counters] renamed ${result.modifiedCount} row(s).`);

  /*
   * The old unique index goes too. Left in place it would still require
   * { companyId, key } to be unique — on a field no row has any more, which
   * means every counter collides on null and the first new sequence fails.
   */
  const indexes = await counters.indexes();
  const stale = indexes.find((i) => i.key && i.key.companyId === 1 && i.key.key === 1);
  if (stale) {
    await counters.dropIndex(stale.name);
    console.log(`[migrate-counters] dropped stale index ${stale.name}.`);
  }
}

main()
  .catch((err) => {
    console.error("[migrate-counters] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
