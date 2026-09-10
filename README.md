# Backend — MyTransport + MyClinic

One Node/Express + MongoDB deployment serving two products as submodules.

```
backend/
  app.js  server.js  db.js  api/index.js
  routes/       auth.js · users.js (dispatcher)
  utils/        apiError · validate · auth · audit · permissions
  middleware/   auth · clinicScope · clinicKey · syncAuth · rateLimit
  models/       Account · AuditLog · Counter          ← shared
  modules/
    transport/  models/ routes/ utils/ scripts/ permissions.js
    clinic/     models/ routes/ utils/          permissions.js
  scripts/      check-indexes · migrate-counters
```

The two products share the error envelope, the validators, the rate limiter,
the account table and the database connection. `app.js` is the only file that
knows both exist — plus `routes/users.js`, which exists because `/users` is the
one path both products own.

---

## MyClinic is a hybrid, and the split is the whole design

| Domain | Owner | Where the app reads it |
|---|---|---|
| Accounts, sessions, staff, permissions | **Server** | `/auth/*`, `/users` |
| Slots **and the bookings inside them** | **Server** | `/slots`, `/tokens` |
| Clinic profile, doctors, services (public subset) | **Excel**, published up | `/sync/profile` |
| Patients, doctors, services, tests, reports, invoices, payments, expenses | **Excel** | local, never the server |

Slots and their bookings became cloud-only in v4. Nothing about who is booked
when is written to the workbook, read from it, or reconciled against it — which
is why `POST /sync/slots`, `GET /sync/bookings` and the acknowledgement
endpoint are **gone** rather than deprecated. There is nothing to publish and
nothing to pull, because the slot was never local.

The reason is the one that matters: a patient books online at midnight, so a
booking that exists only on one reception PC is not a booking. Whoever opens the
console next morning — another machine, a phone, the owner from another branch —
has to see the same day.

### The booking lives inside the slot

There is no Appointment collection, and no Token one. A slot is one document
carrying its capacity, its bookings, and a snapshot of the clinic and doctor it
belongs to.

Every question this product asks is *"what is free, and who is in the rest?"* —
a booking page, a reception grid, a token queue. With separate documents that is
a join on every render and a race on every booking. With the bookings inside the
slot it is one read, and taking the last place is one atomic update of one
document.

The snapshots are copies rather than references because they have to be: the
server has no access to the workbook and never will, so the only way a public
booking page can render a doctor's name is if it was written there when the slot
was created. It also gives the right behaviour when a clinic renames itself —
slots already created keep the old name, and a patient holding a confirmation
sees the name that was on it.

### What the clinic server still never stores

A booking holds a name and a mobile number, optionally a service name and a
note. No address, no date of birth, no diagnoses, no results, no billing, no
history. `patientId` is an opaque string from the clinic's own workbook that
this server stores and never resolves.

A patient booking online is not registering as a patient. Reception searches its
**own** workbook for that mobile number afterwards, links the booking to an
existing record or registers a new one locally, and bills and reports against
that. Which is why the server holds so little.

If this server is breached, what leaks is a list of appointment times — not a
medical record. That ceiling is a design property and the one thing here that
cannot be undone by a later release, because the data would already have been
collected.

### And it is working memory, not a record

Each slot carries an `expiresAt`: the end of its own day in the clinic's
timezone plus the practice's retention window, 48 hours by default. A MongoDB
TTL index removes the document and the bookings inside it go with it.

**Forty-eight hours is not a lot, and anything the clinic needs to keep must be
out before then.** What survives is whatever they wrote into their own workbook —
an invoice, a report, a patient record. The slot and its bookings are working
memory.

---

## Endpoints

### Auth

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |
| GET | `/api/v1/auth/modules` | none |
| POST | `/api/v1/auth/register` | developer code (clinic only) |
| POST | `/api/v1/auth/login` | none — email **or** login ID, 12-hour JWT |
| POST | `/api/v1/auth/driver-login` | none — transport handsets, 90-day token |
| GET | `/api/v1/auth/me` | Bearer |
| POST | `/api/v1/auth/change-password` | Bearer |

`register`, `login` and `me` all return the same clinic session:
`{ module, account, owner, clinics }`.

### Clinic — the console

| Method | Path | Permission |
|---|---|---|
| POST | `/api/v1/slots` | `slots.manage` + single clinic — expands a pattern |
| GET | `/api/v1/slots` | `slots.view` — all doctors unless `doctorId` is given |
| PATCH | `/api/v1/slots/:id` | `slots.manage` — block, unblock, capacity |
| DELETE | `/api/v1/slots/:id` | `slots.manage` — 409 with live bookings |
| DELETE | `/api/v1/slots?before=` | `appointments.purge` (owner) — bulk |
| POST | `/api/v1/slots/:id/book` | `appointments.manage` |
| POST | `/api/v1/slots/:id/bookings/:ref/cancel` | `appointments.cancel` |
| GET | `/api/v1/tokens/queue` | `tokens.view` |
| POST | `/api/v1/tokens/issue` · `/call-next` · `/:slotId/:ref/:action` | `tokens.manage` |
| GET · POST · PATCH | `/api/v1/users` | `users.manage` (owner) |
| GET | `/api/v1/users/permissions` | any session |
| GET · DELETE | `/api/v1/cloud/google/{connect,callback,status,disconnect}` | Bearer (callback: signed state) |
| POST · GET | `/api/v1/cloud/file/{upload,download,versions}` | Bearer |

### Clinic — public

| Method | Path |
|---|---|
| GET | `/api/v1/public/clinics` — the booking directory |
| GET | `/api/v1/public/clinics/:slug` |
| GET | `/api/v1/public/clinics/:slug/slots` — free slots only, no bookings |
| POST | `/api/v1/public/clinics/:slug/slots/:slotId/book` |
| GET · POST | `/api/v1/public/bookings/:publicRef[/cancel]` |

### Clinic — sync, admin, backup

`PUT /sync/profile` and `GET /sync/status` remain: the workbook still owns the
clinic's name, hours, doctors and services, and this server keeps a read-only
mirror for the public page. `/sync/profile` accepts **either** `X-Clinic-Key`
**or** a Bearer session.

The three `/admin/clinics` routes and `/backup/*` are unchanged.

**Dropped in v4:** `POST /sync/slots`, `GET /sync/bookings`,
`POST /sync/bookings/ack`, and the whole `/appointments` router.

### Cron

`POST|GET /api/cron/retention`, hourly, behind `CRON_SECRET`. There is no
`close-past` any more: a v4 slot has no lifecycle status to advance, and the
deletion happens on its own through the TTL index — this job makes it prompt and,
more importantly, makes it *countable*.

### Transport

Unchanged: `/api/v1/{me,company,customers,vehicles,drivers,employees,trips,expenses,estimates,tracking,payments,reports,dashboard}` and `/users`.

---

## Nine things worth understanding before changing this code

**1. Taking a place is one atomic conditional update.** Both the public path and
reception's go through `claimPlace` in `modules/clinic/routes/slots.js`:

```js
findOneAndUpdate(
  { _id, clinicId, isBlocked: false, available: { $gt: 0 }, date: { $gte: todayInClinicTZ } },
  { $inc: { booked: 1, available: -1 }, $push: { bookings: {...} } }
)
```

The filter **is** the concurrency control. Two patients tapping the last 10:15
at the same moment is not a rare case — it is what happens when a clinic posts
its link to a WhatsApp group. Covered by concurrency tests on both paths.

A `null` result means blocked, full, past or gone. The public route does not try
to tell them apart: every branch ends in "choose another time", and
distinguishing them on an unauthenticated endpoint would tell a stranger which
of a clinic's times are full.

**2. `available` is stored, not computed.** It is written in the same update as
the booking. Computing it per request means two readers can both see "1 free",
and storing it is what lets the filter above be an indexed comparison.

**3. Giving a place back is the same update in reverse.** `releasePlace` sets
the status and increments availability together, with `arrayFilters` matching
only a live booking — which is what makes a second cancellation match nothing
rather than pushing `available` above `capacity`. A cancellation that does not
free the place is a slot the clinic cannot resell, and they will not notice
until the day.

**4. `ref` is sequential; `publicRef` is the credential.** The patient's
cancellation link is addressed by 128 bits of randomness, never by
`APT-2026-004411`. Cancelling ...410, then ...411, then ...412 would otherwise
empty a clinic's whole day from a browser. `publicRef` is returned exactly once,
to the person who made the booking, and never appears in a console list.

**5. Re-publishing a fortnight is the normal case.** `POST /slots` is idempotent
on `(clinicId, doctor.id, date, startTime)` and existing rows are left exactly
as they are — capacity, bookings and all. A republish that reset `available`
would hand out places already taken.

**6. An owner's empty `clinicIds` means ALL clinics, not none.** Reading it the
other way locks an owner out of their own practice with an empty screen and no
error to explain it.

**7. A clinic outside your scope is 404, never 403.** A 403 confirms the id is
real, which is how one practice enumerates another's. The frontend also treats
401 as session-over, so a wrong clinic must never be a 401 either.
`CLINIC_REQUIRED` is likewise a contract rather than a failure: the frontend
renders an inline clinic picker on it and resubmits.

**8. Time is checked at read, in the clinic's own timezone.**
`new Date().toISOString().slice(0,10)` is UTC's today, which rolls over at 05:30
in India — using it would expire a clinic's whole morning while patients were
arriving. Everything goes through `modules/clinic/utils/clinicTime.js`. The TTL
index tidies expired slots about once a minute and is explicitly not a
guarantee; the read-time filter is what keeps the answers right in between.

**9. One product's token must not reach the other's routes.** Every transport
router is mounted behind `assertTokenModule("transport")`, and it is not
belt-and-braces — it closes a real leak. A clinic account passed transport's
`requireAuth` (a valid account), passed `requirePermission` (a clinic OWNER
short-circuits every permission check by design), and then queried
`{ companyId: req.companyId }` with `req.companyId` undefined — which Mongoose
**strips** from a filter rather than matching nothing. Three individually
reasonable behaviours composing into an unscoped, cross-tenant query.

---

## Public responses are allowlists, never spreads

`modules/clinic/utils/serialise.js` builds every public shape field by field.
`{ ...doctor }` minus a couple of keys publishes a personal mobile and a
registration number the day somebody adds a field, on a page Google indexes
within hours.

A slot document carries the clinic's capacity, its other patients' names and
their telephone numbers. The patient gets a time, a doctor, and one number:
`available`. The console's booking shape omits `publicRef`, which is the
patient's own credential — a diary list carrying it would put every patient's
cancellation link into the browser of anybody who can open the grid.

---

## Signing up

`POST /auth/register` takes `module` first, because the rest of the form differs.

`module: "transport"` creates a Company and its owner.

`module: "clinic"` requires `developerCode` and creates a practice, its clinics,
the owner account, and one API key per clinic — the keys shown once and never
again.

- **`clinics` is optional.** A list of names, capped at ten, blanks dropped and
  duplicates removed case-insensitively. Over the cap is refused, not truncated.
- **`code`, `slug` and `loginId` are generated, never accepted.** The code
  prefixes login IDs and numbered documents, so a chosen one lets two practices
  collide their sequences; a chosen slug is a way to squat on a competitor's
  public address. Collisions get a suffix — `SUN2`, `sunshine-diagnostics-2`.
- **`role` in the body is ignored entirely.** Signup creates an owner of a *new*
  practice; what must never be possible is joining an existing one.
- **No catalogue is seeded.** This reverses v2: a seeded price is a price nobody
  at that clinic agreed to, sitting somewhere an invoice can be raised from.

Sign-in takes **either an email or a login ID in the same field**, because users
do not reliably know which they hold. The minimum password is **3 characters** —
deliberate: this login is shared at a reception desk, and forcing `Xk9$mQ2!`
onto that desk produces a sticky note on the monitor. The rate limiter is what
actually stops guessing.

---

## Google Drive

The customer pastes nothing. They press Connect, approve Google's consent
screen, and the backend creates the folder and the file on first upload and
stores both ids.

Storing them is not an optimisation. The `drive.file` scope grants access only
to files this app created, which is the right scope — full `drive` triggers a
Google security review nobody needs — and it means the app **cannot search the
user's Drive for the workbook by name**. After a reinstall those ids are the
only route back to the file.

The callback carries no bearer token, because Google issues it. The session
travels in the OAuth `state` parameter, **signed** and expiring in ten minutes:
a raw account id there would be an account-takeover hole, since anyone could
complete a consent flow with somebody else's id in it.

The refresh token is stored **encrypted** (AES-256-GCM under
`CLOUD_ENCRYPTION_KEY`) and is never returned by any endpoint. A Google refresh
token does not expire, so a plain-text leak is a standing key to every connected
practice's patient history. Disconnect revokes it at Google *and* deletes the
row; dropping the row alone leaves a live grant the customer can see and this
product cannot.

Google Cloud Console, once: create a project → enable the Drive API → consent
screen → add **only** `.../auth/drive.file` → create a Web application client →
add your origin to **Authorized JavaScript origins** → add the callback to
**Authorized redirect URIs** character for character, no trailing slash. A
mismatch there is `redirect_uri_mismatch`, the single most common failure in
this flow. Add yourself as a test user while the screen is unverified, or Google
returns `access_blocked` with no useful detail.

---

## Running it

```bash
npm install
cp .env.example .env        # MONGO_URI and JWT_SECRET at minimum
npm run dev
npm run check-indexes       # build every declared index and report
npm run seed                # transport demo data
```

`server.js` is the local entry point and `api/index.js` the serverless one; both
import the same `app.js`. A missing environment variable should stop a process
from starting, and should *not* take down a serverless request that could have
returned a readable error.

Run `check-indexes` at deploy time rather than relying on Mongoose's background
creation. It has now caught two indexes that were silently failing to build: a
`Driver` index specifying both `sparse` and `partialFilterExpression`, and a
`ClinicLicense` index declared twice so its `unique` option was dropped. In both
cases the constraint the model appeared to promise did not exist.

### Upgrading an existing deployment

```bash
npm run migrate-counters -- --apply   # Counter.companyId -> tenantId
```

Skipping it restarts every sequence at 1 — the next trip would be `TRP-000001`,
a number already on a customer's invoice.

Transport sessions and driver handsets are unaffected: the token issuer is
unchanged, accounts without a `module` default to `transport`, and tokens minted
before `tokenVersion` existed are accepted until they expire.

**The clinic slot collection changed shape completely in v4** — a slot now
carries its bookings, its snapshots and an `expiresAt`, and the `appointments`
collection is gone. There is no migration, because there is nothing worth
migrating: slots are working memory with a two-day lifetime, so the correct
upgrade is to drop `slots` and `appointments` and let each clinic publish its
calendar again.

Clinic sessions from v2 also end once, because the clinic tenant claim moved
from the branch to the practice.
