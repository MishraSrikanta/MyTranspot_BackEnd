/*
 * Who may see and do what inside one practice.
 *
 * ================= why this grew back =================
 *
 * The v2 catalogue had four permissions, because the clinic backend was a
 * booking endpoint and nobody signed into it. That changed: the console is a
 * real signed-in application, an owner grants staff accounts, and the server
 * now owns appointments end to end. A receptionist who may book a walk-in must
 * not be able to purge last quarter, and that distinction has to live
 * somewhere.
 *
 * So the roles the brief listed are modelled as PRESETS rather than as
 * hard-coded behaviour, and what is stored on a user is a list of permissions.
 * No two practices divide the work the same way — one wants the receptionist
 * entering test results at a quiet branch, the next does not want anybody but
 * the lab near them. With presets that is a tick box; with hard-coded roles it
 * is a release.
 *
 * A role therefore only decides what the tick boxes START as. After the account
 * exists, the permission list is the truth and the role is a label.
 *
 * ================= permissions for data this server never sees =================
 *
 * Patients, invoices, reports and the rest live in the clinic's own workbook
 * and never reach this API — yet they have permissions here. That is
 * deliberate: the FRONTEND builds its menu from the resolved list this endpoint
 * returns, so "can Priya open the Patients screen?" is a decision the owner
 * makes here and the app enforces locally.
 *
 * Only the appointment, slot, user and settings permissions are ALSO enforced
 * server-side, because only those guard endpoints that exist. The distinction
 * matters when reading the routes: a missing check on `patients.view` is not an
 * oversight, it is that there is nothing to check.
 */

const PERMISSIONS = [
  "dashboard.view",

  /* Owner-level. A clinic admin runs a clinic; only the owner creates one. */
  "clinics.view",
  "clinics.manage",

  "patients.view",
  "patients.manage",
  "patients.archive",

  /* ================= server-enforced ================= */
  "appointments.view",
  "appointments.manage",
  /* Cancelling frees the slot and stays in the record forever. */
  "appointments.cancel",
  /*
   * Deleting is a different power from cancelling, and it is new in v3.
   *
   * A cancellation says the patient did not come. A deletion says the row
   * should never have existed — a test booking, a duplicate, a name typed into
   * the wrong clinic. It has no undo, which is exactly why a receptionist who
   * may cancel all day does not get it by default.
   */
  "appointments.delete",
  /* Bulk-deleting finished days. The most destructive thing in the product. */
  "appointments.purge",

  "slots.view",
  "slots.manage",

  "tokens.view",
  "tokens.manage",

  "doctors.view",
  "doctors.manage",
  "doctors.schedule",

  "services.view",
  "services.manage",

  "tests.view",
  "tests.manage",

  "testorders.view",
  "testorders.manage",
  /* The clinical gate. Typing a haemoglobin value is what a doctor acts on, so
   * it is never bundled with being able to raise the order. */
  "testresults.enter",

  "reports.view",
  "reports.generate",
  "reports.send",

  "billing.view",
  "billing.manage",

  "payments.view",
  "payments.manage",

  "expenses.view",
  "expenses.manage",

  /* Profit is split from revenue on purpose: plenty of owners will show a
   * manager what a visit earns without showing what the business keeps. */
  "revenue.view",
  "profit.view",

  "analytics.view",
  "exports.download",

  "users.manage",
  "settings.manage",
  "audit.view",
];

const PERMISSION_SET = new Set(PERMISSIONS);

const ROLES = [
  "owner",
  "clinic_admin",
  "receptionist",
  "doctor",
  "lab",
  "accountant",
  "custom",
];

/*
 * The three an owner keeps. Creating a clinic and granting staff are decisions
 * about the BUSINESS, and a clinic-pinned login is by construction not in a
 * position to make them.
 *
 * `appointments.purge` is here too: bulk-deleting finished days is irreversible
 * and practice-wide, and is not something to hand a branch by default.
 */
const OWNER_ONLY = new Set(["clinics.manage", "users.manage", "appointments.purge"]);
const CLINIC_ADMIN_PERMISSIONS = PERMISSIONS.filter((p) => !OWNER_ONLY.has(p));

const ROLE_PRESETS = {
  /* Everything, always. Listed for display only — an owner is never matched
   * against this array. */
  owner: [...PERMISSIONS],

  /* Runs one clinic end to end, short of buying another one or hiring for it.
   * Keeps `appointments.delete` — a branch manager clearing a duplicate is
   * ordinary — but not `appointments.purge`. */
  clinic_admin: [...CLINIC_ADMIN_PERMISSIONS],

  /*
   * The front desk. Books, checks in, drives the token queue, raises the bill
   * and takes the money — the whole of a patient's visit except the clinical
   * part.
   *
   * Notably absent: `appointments.delete`. A receptionist cancels; a
   * cancellation is recoverable and auditable, and a deletion is neither.
   */
  receptionist: [
    "dashboard.view",
    "patients.view",
    "patients.manage",
    "appointments.view",
    "appointments.manage",
    "appointments.cancel",
    "slots.view",
    "tokens.view",
    "tokens.manage",
    "doctors.view",
    "services.view",
    "tests.view",
    "testorders.view",
    "testorders.manage",
    "reports.view",
    "billing.view",
    "billing.manage",
    "payments.view",
    "payments.manage",
  ],

  /* The consulting room. Sees patients and their history, drives their own
   * queue, orders tests and signs reports. No billing at all — deliberately:
   * the doctor deciding a test is needed and the desk charging for it are meant
   * to be two people. */
  doctor: [
    "dashboard.view",
    "patients.view",
    "appointments.view",
    "appointments.manage",
    "tokens.view",
    "tokens.manage",
    "doctors.view",
    "services.view",
    "tests.view",
    "testorders.view",
    "testorders.manage",
    "reports.view",
    "reports.generate",
  ],

  /* The laboratory. Enters results and produces reports, and can look up the
   * patient a sample belongs to. Cannot book, cannot bill. */
  lab: [
    "dashboard.view",
    "patients.view",
    "tests.view",
    "testorders.view",
    "testorders.manage",
    "testresults.enter",
    "reports.view",
    "reports.generate",
    "reports.send",
  ],

  /* The books. Every rupee in and out, and the analysis to argue about it; no
   * clinical access beyond reading a report attached to an invoice. */
  accountant: [
    "dashboard.view",
    "patients.view",
    "appointments.view",
    "billing.view",
    "billing.manage",
    "payments.view",
    "payments.manage",
    "expenses.view",
    "expenses.manage",
    "revenue.view",
    "profit.view",
    "reports.view",
    "analytics.view",
    "exports.download",
  ],

  /* Starts with somewhere to land. The owner ticks what this person needs. */
  custom: ["dashboard.view"],
};

function presetFor(role) {
  return [...(ROLE_PRESETS[role] || ROLE_PRESETS.custom)];
}

/*
 * An owner short-circuits to true and is never matched against a stored list.
 * That is not a convenience: it means an owner cannot be locked out of their
 * own practice by a bad edit to their own permissions, which is the single
 * worst support call a system like this can generate.
 */
function hasPermission(account, permission) {
  if (!account) return false;
  if (account.role === "owner") return true;
  return effectivePermissions(account).includes(permission);
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
  /* Everyone needs somewhere to land after signing in. */
  if (!allowEmpty && !clean.includes("dashboard.view")) clean.unshift("dashboard.view");
  return [...new Set(clean)];
}

/*
 * The RESOLVED list — what the frontend builds its menu from.
 *
 * An owner gets every permission spelled out rather than an empty array and a
 * special case.
 *
 * A non-owner with an EMPTY stored list falls back to their role's preset,
 * because an empty array from the users endpoint means "use the preset" and not
 * "no permissions at all". The frontend resolves it the same way; the two
 * agreeing is the whole point of serving this rather than duplicating it.
 */
function effectivePermissions(account) {
  if (!account) return [];
  if (account.role === "owner") return [...PERMISSIONS];
  if (account.permissions && account.permissions.length) return [...account.permissions];
  return presetFor(account.role);
}

/*
 * Grouped for the permissions editor, so forty tick boxes read as seven
 * decisions rather than one wall. Served with the catalogue rather than
 * duplicated in the frontend — the two can then never drift into showing a tick
 * box that authorises nothing.
 */
const PERMISSION_GROUPS = [
  {
    label: "Overview",
    permissions: ["dashboard.view", "analytics.view", "exports.download", "audit.view"],
  },
  { label: "Clinics", permissions: ["clinics.view", "clinics.manage"] },
  { label: "Patients", permissions: ["patients.view", "patients.manage", "patients.archive"] },
  {
    label: "Appointments & queue",
    permissions: [
      "appointments.view",
      "appointments.manage",
      "appointments.cancel",
      "appointments.delete",
      "appointments.purge",
      "slots.view",
      "slots.manage",
      "tokens.view",
      "tokens.manage",
    ],
  },
  { label: "Doctors", permissions: ["doctors.view", "doctors.manage", "doctors.schedule"] },
  {
    label: "Clinical",
    permissions: [
      "services.view",
      "services.manage",
      "tests.view",
      "tests.manage",
      "testorders.view",
      "testorders.manage",
      "testresults.enter",
      "reports.view",
      "reports.generate",
      "reports.send",
    ],
  },
  {
    label: "Money",
    permissions: [
      "billing.view",
      "billing.manage",
      "payments.view",
      "payments.manage",
      "expenses.view",
      "expenses.manage",
      "revenue.view",
      "profit.view",
    ],
  },
  { label: "Administration", permissions: ["users.manage", "settings.manage"] },
];

module.exports = {
  PERMISSIONS,
  PERMISSION_GROUPS,
  ROLES,
  ROLE_PRESETS,
  OWNER_ONLY,
  presetFor,
  hasPermission,
  sanitisePermissions,
  effectivePermissions,
};
