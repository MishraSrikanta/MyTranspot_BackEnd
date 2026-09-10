/*
 * Who may see and do what inside one transport company.
 *
 * The brief described four fixed roles — owner, manager, accountant,
 * operations. They are modelled here as PRESETS rather than as hard-coded
 * behaviour, and what is actually stored on a user is a list of permissions.
 * The reason is that no two transport offices divide the work the same way:
 * one owner wants the accountant to see the live map, the next does not want
 * the manager anywhere near driver fees. With presets, that is a tick box.
 * With hard-coded roles, it is a release.
 *
 * A role therefore only decides what the tick boxes START as. After the account
 * exists, the permission list is the truth and the role is a label.
 */

/*
 * Read and write are separate permissions throughout. An operations clerk who
 * may open a trip and log a toll must not be able to change what the customer
 * is being charged, and that distinction disappears the moment one "trips"
 * permission covers both.
 */
const PERMISSIONS = [
  "dashboard.view",

  "trips.view",
  "trips.manage",
  /* Starting and closing a trip is separated from editing one: closing banks
   * the profit figure and freezes the ledger. */
  "trips.close",

  "vehicles.view",
  "vehicles.manage",

  "drivers.view",
  "drivers.manage",
  "drivers.payments",

  "customers.view",
  "customers.manage",

  "estimates.view",
  "estimates.manage",

  "expenses.view",
  "expenses.manage",
  /* The audit gate. Approving somebody else's fuel bill is what moves it into
   * the trip cost, so it is never bundled with being able to add one. */
  "expenses.approve",

  "revenue.view",
  "revenue.manage",
  "payments.manage",

  /* Profit is split out from revenue on purpose: plenty of owners will show a
   * manager what a trip earns without showing what the business keeps. */
  "profit.view",
  "reports.view",

  "tracking.view",
  /* Changing how often driver phones report — a company-wide setting with a
   * data-cost consequence, so it is not part of merely watching the map. */
  "tracking.manage",

  "users.manage",
  "settings.manage",
];

const PERMISSION_SET = new Set(PERMISSIONS);

/* The label a user carries. "owner" is not in the presets below because an
 * owner is never checked against a list — see hasPermission. */
const ROLES = ["owner", "manager", "accountant", "operations", "driver", "custom"];

/*
 * The driver is the one role that is NOT a set of office permissions.
 *
 * Every other role is a desk in the same office looking at the same company:
 * more or less of it, but the same data. A driver is not that. A driver may see
 * exactly one thing — the trips they are on — and giving them `trips.view` would
 * grant the whole company's trip list, because that is what `trips.view` means
 * everywhere else in this codebase. Scoping it after the fact, endpoint by
 * endpoint, is how an authorisation bug eventually ships.
 *
 * So the driver's data lives behind its own router (routes/me.js) where every
 * query is bound to `req.account.driverId` by construction, and this preset is
 * deliberately EMPTY. A driver login holds no office permission at all: if the
 * driver module were deleted tomorrow, a driver's token would open nothing.
 *
 * `isDriverAccount` below is what the office endpoints use to keep a driver out
 * of them even if somebody later ticks a permission box by hand.
 */
const DRIVER_ROLE = "driver";

const ROLE_PRESETS = {
  /* Everything, always. Listed for display only. */
  owner: [...PERMISSIONS],

  /* Runs the yard: trips, lorries, drivers, day-to-day spend, and the reports
   * to argue about them. No user administration, no billing settings. */
  manager: [
    "dashboard.view",
    "trips.view",
    "trips.manage",
    "trips.close",
    "vehicles.view",
    "vehicles.manage",
    "drivers.view",
    "drivers.manage",
    "customers.view",
    "customers.manage",
    "estimates.view",
    "estimates.manage",
    "expenses.view",
    "expenses.manage",
    "revenue.view",
    "profit.view",
    "reports.view",
    "tracking.view",
  ],

  /* The books. Sees every rupee and approves what the drivers spent; has no
   * business assigning a lorry to a run. */
  accountant: [
    "dashboard.view",
    "trips.view",
    "customers.view",
    "estimates.view",
    "expenses.view",
    "expenses.manage",
    "expenses.approve",
    "revenue.view",
    "revenue.manage",
    "payments.manage",
    "drivers.view",
    "drivers.payments",
    "profit.view",
    "reports.view",
  ],

  /* The desk that actually dispatches. Everything operational, nothing
   * financial — deliberately no profit.view, so the person booking lorries
   * cannot read the margin on the load. */
  operations: [
    "dashboard.view",
    "trips.view",
    "trips.manage",
    "vehicles.view",
    "drivers.view",
    "customers.view",
    "expenses.view",
    "expenses.manage",
    "tracking.view",
  ],

  /* See DRIVER_ROLE above: intentionally empty, and not a mistake. */
  driver: [],

  /* Starts empty. The owner ticks what this person needs. */
  custom: ["dashboard.view"],
};

function presetFor(role) {
  if (role === DRIVER_ROLE) return [];
  return [...(ROLE_PRESETS[role] || ROLE_PRESETS.custom)];
}

/*
 * A login that belongs to a person who drives rather than to a desk.
 *
 * Checked by identity — the link to a driver record — and not only by the role
 * label, so a driver account whose role was edited to "operations" still cannot
 * be handed the office. The two together are the gate; either alone is a gap.
 */
function isDriverAccount(account) {
  return !!account && (account.role === DRIVER_ROLE || !!account.driverId);
}

/*
 * The one authorisation question in the product.
 *
 * An owner short-circuits to true and is never matched against a stored list.
 * That is not a convenience: it means an owner cannot be locked out of their
 * own company by a bad edit to their own permissions, which is the single
 * worst support call a system like this can generate.
 */
function hasPermission(account, permission) {
  if (!account) return false;
  if (account.role === "owner") return true;
  const held = account.permissions || [];
  return held.includes(permission);
}

/*
 * Validate a permission list coming off the wire. Unknown entries are dropped
 * rather than rejected: a slightly older admin screen posting a permission this
 * build has since renamed should still be able to save the rest of the form.
 */
function sanitisePermissions(raw, { allowEmpty = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const clean = raw
    .map((p) => String(p ?? "").trim())
    .filter((p) => PERMISSION_SET.has(p));
  /*
   * Everyone needs somewhere to land after signing in — except a driver, whose
   * landing page is their own trip list and who must not be given a company
   * dashboard by a default. `allowEmpty` is how the users route says so.
   */
  if (!allowEmpty && !clean.includes("dashboard.view")) clean.unshift("dashboard.view");
  return [...new Set(clean)];
}

/*
 * What the frontend uses to build its menu. Sending the resolved list rather
 * than the role means the sidebar never has to know what "accountant" implies,
 * and a permission added here appears in the UI without a frontend release.
 */
function effectivePermissions(account) {
  if (!account) return [];
  if (account.role === "owner") return [...PERMISSIONS];
  return [...(account.permissions || [])];
}

module.exports = {
  PERMISSIONS,
  ROLES,
  ROLE_PRESETS,
  DRIVER_ROLE,
  presetFor,
  hasPermission,
  isDriverAccount,
  sanitisePermissions,
  effectivePermissions,
};
