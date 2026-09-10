/*
 * The permission dispatcher.
 *
 * ================= why this file exists =================
 *
 * This backend serves two products from one deployment: MyTransport, which
 * runs a haulage office, and MyClinic, which runs a group of clinics. They
 * share an account table, an error envelope and a session; they share almost
 * nothing about what a user is allowed to do. "expenses.approve" means a fuel
 * bill in one and a laboratory invoice in the other, and half the permissions
 * in each catalogue are meaningless in the other.
 *
 * The wrong fix is one merged catalogue: it would offer a clinic owner a tick
 * box for "tracking.manage" and a transport owner one for "testresults.enter",
 * and every screen listing permissions would have to filter by module anyway.
 *
 * So each module owns its own catalogue — modules/transport/permissions.js and
 * modules/clinic/permissions.js — and this file picks between them using
 * `account.module`. Nothing outside a module needs to know which catalogue it
 * is looking at, which is what lets middleware/auth.js hold ONE permission
 * check for the whole backend.
 */

const transport = require("../modules/transport/permissions");
const clinic = require("../modules/clinic/permissions");

/* The two products. Also the enum on Account.module and the choice a signup
 * form has to make before it can ask anything else. */
const MODULES = ["transport", "clinic"];
const DEFAULT_MODULE = "transport";

const CATALOGUES = { transport, clinic };

/*
 * A module label a person will read. Kept here rather than in the frontend so
 * the registration screen's module picker is served, the same way the
 * permission catalogue is — one place to add the third product.
 */
const MODULE_LABELS = {
  transport: "MyTransport — fleet, trips and profitability",
  clinic: "MyClinic — clinics, appointments and diagnostics",
};

/*
 * An unknown module resolves to transport rather than throwing.
 *
 * Accounts created before this backend served two products have no `module`
 * field at all, and they are all transport accounts. Defaulting keeps every one
 * of them signing in; throwing would turn a schema addition into an outage for
 * the existing customer base.
 */
function moduleOf(accountOrModule) {
  if (!accountOrModule) return DEFAULT_MODULE;
  const value =
    typeof accountOrModule === "string" ? accountOrModule : accountOrModule.module;
  return MODULES.includes(value) ? value : DEFAULT_MODULE;
}

function catalogueFor(accountOrModule) {
  return CATALOGUES[moduleOf(accountOrModule)];
}

/* The full permission list for one module — what GET /users/permissions serves. */
function permissionsFor(accountOrModule) {
  return [...catalogueFor(accountOrModule).PERMISSIONS];
}

function rolesFor(accountOrModule) {
  return [...catalogueFor(accountOrModule).ROLES];
}

function rolePresetsFor(accountOrModule) {
  return catalogueFor(accountOrModule).ROLE_PRESETS;
}

/* What a role's tick boxes START as. After the account exists the stored list
 * is the truth and the role is a label — in both modules. */
function presetFor(module, role) {
  return catalogueFor(module).presetFor(role);
}

/* Every role either module recognises, for the Account schema's enum. Owner
 * appears in both, hence the Set. */
const ALL_ROLES = [...new Set(MODULES.flatMap((m) => CATALOGUES[m].ROLES))];

/*
 * The one authorisation question in the product.
 *
 * An owner short-circuits to true and is never matched against a stored list.
 * That is not a convenience: it means an owner cannot be locked out of their
 * own business by a bad edit to their own permissions, which is the single
 * worst support call a system like this can generate.
 */
function hasPermission(account, permission) {
  if (!account) return false;
  if (account.role === "owner") return true;
  const held = account.permissions || [];
  return held.includes(permission);
}

/*
 * Validate a permission list coming off the wire, against the catalogue of the
 * account's OWN module. Unknown entries are dropped rather than rejected: a
 * slightly older admin screen posting a permission this build has since renamed
 * should still be able to save the rest of the form — and a clinic permission
 * posted at a transport account is dropped for the same reason it should be,
 * without needing its own error path.
 */
function sanitisePermissions(module, raw, options) {
  return catalogueFor(module).sanitisePermissions(raw, options);
}

/*
 * What the frontend uses to build its menu. Sending the RESOLVED list rather
 * than the role means the sidebar never has to know what "receptionist"
 * implies, and a permission added on the server appears in the UI without a
 * frontend release.
 */
function effectivePermissions(account) {
  if (!account) return [];
  return catalogueFor(account).effectivePermissions(account);
}

module.exports = {
  MODULES,
  DEFAULT_MODULE,
  MODULE_LABELS,
  ALL_ROLES,
  moduleOf,
  catalogueFor,
  permissionsFor,
  rolesFor,
  rolePresetsFor,
  presetFor,
  hasPermission,
  sanitisePermissions,
  effectivePermissions,
};
