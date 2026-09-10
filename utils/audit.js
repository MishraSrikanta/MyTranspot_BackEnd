const AuditLog = require("../models/AuditLog");

/*
 * Writing the audit trail.
 *
 * Two rules, both learned the hard way in systems like this:
 *
 * 1. Auditing never fails the action. If the log write throws — a replica
 *    stepping down, a disk full — the invoice it was recording has already been
 *    cancelled, and turning that into a 500 would leave the client retrying a
 *    cancellation that already went through. The failure is logged to the
 *    console and swallowed.
 *
 * 2. It is fire-and-forget from the caller's point of view. The route does not
 *    await it, so an audit write never sits between the user and their
 *    response.
 *
 * The signature is the same for both modules. Which tenant field a row lands in
 * is worked out here from the account, so no route has to know whether it is
 * running inside a haulage company or a clinic group.
 */

function record(req, { action, entityType, entityId, entityLabel, changes, note, clinicId }) {
  const account = req.account;
  if (!account) return;

  const module = account.module || "transport";

  AuditLog.create({
    module,
    /* companyId for transport, ownerId for clinic — the account knows which. */
    tenantId: module === "clinic" ? account.ownerId : account.companyId,
    /*
     * The clinic the action happened in. Taken from the caller when given —
     * an owner acting on one branch while scoped to All Clinics — and otherwise
     * from the account, which is the right answer for a clinic login and null
     * for everyone else.
     */
    clinicId: clinicId || account.clinicId || null,
    action,
    entityType,
    entityId: entityId || null,
    entityLabel: entityLabel || "",
    actorId: account._id,
    actorName: account.name,
    actorRole: account.role,
    changes: changes || null,
    note: note || "",
    /* Behind a load balancer the client address is in the forwarded header;
     * only the first entry is the original client, the rest are proxies. */
    ip: String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(),
  }).catch((err) => {
    console.error("[audit] failed to record", action, err.message);
  });
}

/*
 * Before/after for just the fields that moved. Comparing as JSON catches nested
 * objects (a revenue block, a permission list) without a deep-equality library,
 * and an audit row is not on any hot path.
 */
function diff(before, after, fields) {
  const changes = {};
  for (const f of fields) {
    const a = before ? before[f] : undefined;
    const b = after ? after[f] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes[f] = { from: a === undefined ? null : a, to: b === undefined ? null : b };
    }
  }
  return Object.keys(changes).length ? changes : null;
}

module.exports = { record, diff };
