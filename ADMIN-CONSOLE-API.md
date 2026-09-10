# The vendor console API

**Base: `/api/v1/admin` · Implemented in `routes/adminAccounts.js`**

This is the surface the vendor's own admin app calls — the one used to create
customers and their logins across both products. It is not a customer-facing
API and no customer session can reach it.

---

## 1. Why it is separate from everything else

Every other route on this backend answers a question a **customer** asks: a
haulage office reading its own trips, a practice publishing its own slots, an
owner managing their own staff through `/api/v1/users`. All of them are scoped
to the caller's own tenant, and that scoping *is* the isolation guarantee —
there is deliberately no code path on them that reads across tenants.

This file answers the other question, the one the person who **sells** the
software asks: who are my customers, create a login for this new one, add a
sub-login to that one, fix a name, remove a login that should not exist. Those
are cross-tenant by definition, which is why they live behind a different door
rather than being bolted onto the customer routes as a special case every future
edit has to remember.

---

## 2. The door

```
x-admin-secret: <ADMIN_SECRET>
```

The caller is not a person with an account, it is a console — there is no
session to have, so there is no session to check.

Guarded twice over, the same way the clinic provisioning routes are:

1. `requireAdminSecret` rejects a wrong or missing secret with **401**.
2. **`app.js` does not mount the router at all unless `ADMIN_SECRET` is set.** A
   deployment that was never given one does not have these endpoints to find.

> **`ADMIN_SECRET` is not currently set in `.env`,** so these routes are absent
> from the local deployment. Set it before pointing a console at it.

Rate limited by `consoleRateLimit` — **300 requests per 15 minutes per IP**, and
deliberately *not* the provisioning limiter (`adminRateLimit`, 20/15min), which
is sized for something done a handful of times per customer. A console lists
customers and logins on every refresh; twenty would be exhausted before the
first screen finished loading. The limiter runs **before** the secret check, so
failed guesses are counted — a limiter placed after authentication only ever
throttles people who already hold the credential.

---

## 3. One router, two products

`Account` is a single collection holding both products' logins, so every route
takes `module` and only the two things that genuinely differ branch on it:

| | `module=transport` | `module=clinic` |
| --- | --- | --- |
| tenant ("customer") | `Company` | `Owner` (the practice) |
| account scope field | `companyId` | `ownerId` |
| roles | `modules/transport/permissions` | `modules/clinic/permissions` |

**`module` defaults to `transport`.** Accounts predating the two-product split
carry no `module` field at all and are every one of them transport, so
`GET /accounts?module=transport` matches `{module: 'transport'}` **or** the field
being absent/null. Matching on the field alone would hide the entire legacy
customer base from the console meant to manage it.

Roles are each product's own, never merged — forcing one catalogue onto the
other gives a clinic a `driver` and a haulage company a `lab`:

```
transport   owner · manager · accountant · operations · driver · custom
clinic      owner · clinic_admin · receptionist · doctor · lab · accountant · custom
```

---

## 4. The endpoints

### `GET /catalogue`

Both products, their roles, their assignable staff roles, and their permission
lists. Served rather than duplicated in the console, for the same reason
`/api/v1/users/permissions` is: a role added on the server appears in the form
without a frontend release, and the two cannot drift into offering a role the
server would refuse.

### `GET /tenants?module=`

Every customer on one product, newest first, each with `accounts` — how many
logins it has. Counted in one aggregation rather than a query per row.

```json
{ "module": "transport", "total": 4,
  "tenants": [ { "id","module","name","contactName","email","phone","city",
                 "plan","isActive","createdAt","accounts" } ] }
```

`name` is what a person calls the customer (the company, or the practice's
business name); `contactName` is the human behind it, which a clinic stores and
a company does not.

### `POST /tenants`

A new customer **and their owner login, in one call** — the halves are
meaningless apart: a company with no login is a row nobody can reach, and an
owner account with no company fails every request it makes. Everything is rolled
back if the second half fails, for exactly that reason.

```json
{ "module": "transport", "name": "Ramesh", "businessName": "Balaji Transport",
  "email": "…", "password": "…", "phone": "…", "city": "…", "plan": "basic" }
```

```json
{ "module": "clinic", "name": "Dr Mehta", "businessName": "Sunshine Diagnostics",
  "clinicName": "Sunshine Kothrud", "email": "…", "password": "…", "expiresAt": null }
```

- The vendor may set `plan` (transport). Public signup cannot and takes the
  schema default — the difference between a customer choosing their own limits
  and the person who invoiced them recording what they bought.
- Clinic creation also mints the **first branch, its licence and its API key**,
  using the same identifier allocator public signup and the provisioning route
  use. Three code paths inventing identifiers by different rules is how "SUN"
  ends up meaning two clinics.
- **The clinic API key is returned once and never again.** The document holds a
  sha256 and a six-character prefix, neither of which can be turned back into a
  working credential.
- No `developerCode` is asked for — the door it is already behind is the admin
  secret rather than an invite.

`201 { module, tenant, account, clinic?, loginId?, apiKey?, warning? }`

### `GET /accounts?module=&tenantId=`

Every login on one product, or one customer's logins with `tenantId`. Unpaged on
purpose: this is a vendor's customer list, which is hundreds rather than
millions, and a total that silently covers the first page only is a wrong number
presented as a right one.

### `POST /accounts`

A **sub-login** under an existing customer — the vendor's version of what
`/api/v1/users` does for a customer managing its own staff.

```json
{ "module": "clinic", "tenantId": "…", "name": "Rekha", "email": "…",
  "password": "…", "role": "receptionist", "clinicIds": ["…"], "permissions": ["…"] }
```

- **`owner` is refused by name.** There is one owner per customer, created with
  the customer; a second would be a second unconditionally authorised login on
  somebody's business, added from a console that business cannot see.
- **No plan limit is enforced**, unlike `/api/v1/users`. A limit exists to stop a
  customer quietly exceeding what they bought; the vendor adding a login is the
  person who decides what they bought.
- Permissions come from an explicit list or the role's preset, and either way
  pass that module's allowlist — a permission belonging to the other product can
  never be stored.
- **Clinic sub-logins must name at least one branch.** An empty `clinicIds` on a
  non-owner means *no* branch, not every branch (see `models/Account.js`), so the
  default is every branch the practice currently has rather than a login that can
  open nothing and looks broken on its first morning.

### `GET /accounts/:id` · `PATCH /accounts/:id` · `DELETE /accounts/:id`

`PATCH` changes only the fields present: `name`, `phone`, `email`, `role`,
`permissions`, `isActive`, `password`.

- **An owner's role cannot be changed** (`400`). Demoting the only owner of a
  business leaves it with nobody who can grant anything — including nobody who
  can undo the demotion.
- Changing `role` moves permissions to the new role's preset unless an explicit
  list is sent. Otherwise a promoted receptionist keeps a receptionist's
  permissions and the new job title quietly means nothing.
- **A new password and a suspension each end every live session** by bumping
  `tokenVersion`, which `middleware/auth.js` checks. A suspension that leaves the
  desk signed in until tomorrow is not a suspension.

`DELETE` is permanent and **refuses an owner who still has other logins**
(`409 RESOURCE_BUSY`, with the count). Refused rather than cascaded: deleting a
customer's owner would take every sub-login with it as a side effect of one
click, and the receptionist who cannot sign in tomorrow morning has no way to
find out why.

**It does not delete the company or the practice.** A tenant with no logins is
recoverable by creating one; a deleted tenant takes its trips, its clinics and
its licences with it, and that is not a decision an account screen should make on
somebody's behalf. Removing a customer outright is a deliberate, separate act.

---

## 5. Errors

The backend's standard envelope, unchanged:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": { "field": "…" } } }
```

Codes this surface returns: `UNAUTHENTICATED` (bad secret), `RATE_LIMITED`,
`VALIDATION_FAILED`, `EMAIL_TAKEN`, `ACCOUNT_NOT_FOUND`, `RESOURCE_BUSY`.

---

## 6. Verified against the live cluster

Exercised end to end on 2026-09-09 against the Atlas deployment, then cleaned up
so the database was left exactly as found:

- missing and wrong secret → `401`; correct secret → served
- `GET /catalogue` → both products' real role and permission lists
- `GET /tenants` → 4 transport customers with per-tenant login counts
- `POST /tenants` (clinic) → practice + branch + licence + owner login + one-time
  API key; owner correctly pinned to no branch (`clinicId: null`)
- `POST /accounts` → receptionist under that practice, 19 preset permissions,
  pinned to the one branch
- `PATCH` owner role → refused; `PATCH` sub-login to `doctor` → permissions
  followed the role (19 → 13)
- `DELETE` owner with staff → `409` naming the count; after removing the staff
  login, the owner deleted cleanly

Three transport companies in the cluster currently have **zero logins**
(`Probe Group`, `MoTransport`, and one other) — leftovers worth a look, since a
company with no login is a row nobody can reach.
