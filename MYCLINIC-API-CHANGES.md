# MyClinic — API changes

Everything here is **backward compatible**. No existing client has to change, and
no deployed clinic desktop app breaks. Each section says what moved, why, and
what a caller has to send to get the new behaviour.

Verified against a live server; the drive output is at the bottom.

---

## 1. `POST /api/v1/auth/register` — clinics may be objects, not just names

### The problem

`clinics` was a list of strings, and `createClinicFor` filled every other field
in from the owner: their phone, their email, their city, their state.

That is correct for a practice with **one** clinic, where the owner's details are
the clinic's. It is wrong the moment there are two. A practice registering a
Bhubaneswar clinic and a Cuttack clinic got two rows both saying Bhubaneswar and
both carrying the same phone number — and it was **uncorrectable**, because
nothing in the product could edit a clinic. The wrong city went onto the public
booking page and stayed there.

### What changed

Each entry in `clinics` may now be an object carrying its own details. The
owner's details became a **fallback** rather than the answer.

```jsonc
// still valid — a string means "this name, everything else from the owner"
"clinics": ["Alpha Clinic", "Beta Clinic"]

// new — each clinic carries its own
"clinics": [
  { "name": "BBSR Clinic",    "city": "Bhubaneswar", "phone": "9000000666", "address": "1 Janpath" },
  { "name": "Cuttack Clinic", "city": "Cuttack",     "phone": "9000000777", "address": "5 Ring Road",
    "bookingEnabled": false }
]
```

Per-clinic fields, all optional: `name` (required), `phone`, `email`, `address`,
`city`, `state`, `timezone`, `bookingEnabled`.

### The rule that matters

**Absent and empty are different.**

| sent | meaning |
| --- | --- |
| field omitted | inherit from the owner |
| `"city": ""` | deliberately blank — do **not** inherit |

The implementation uses `undefined` checks, not `||`, for exactly this reason. If
you build a form that posts every field whether or not it was filled in, every
clinic gets blanks instead of the practice's details. Drop empty strings before
posting, or send them on purpose.

### Validation

Errors are addressed **per row**: `clinics[2].phone`, not `phone`. A form showing
four clinics can put the message under the box that is actually wrong.

Unchanged: blank names are skipped, duplicate names are dropped
case-insensitively (`City Clinic` and `city clinic` are one clinic typed twice),
and more than `MAX_CLINICS_AT_SIGNUP` (10) is **refused**, not truncated.

---

## 1b. `POST /api/v1/admin/tenants` — `clinics[]`, so a practice is created whole

Auth: `x-admin-secret`.

It created exactly one clinic, named by `clinicName`. A practice with four
branches had to be created and then topped up three times through a different
endpoint — and each of those three inherited the head office's address.

It now takes the **same `clinics` shape as signup** (§1), parsed by the same
function, so the two cannot disagree about what counts as a duplicate.

```jsonc
POST /api/v1/admin/tenants
{
  "module": "clinic",
  "name": "Dr Mehta", "email": "...", "password": "...", "phone": "...",
  "businessName": "Mehta Diagnostics",
  "city": "Bhubaneswar", "state": "Odisha", "address": "HQ Road",
  "expiresAt": null,                       // one licence date for all of them
  "clinics": [
    { "name": "Mehta HQ" },                                       // inherits the practice
    { "name": "Mehta Cuttack", "city": "Cuttack", "phone": "…" }, // its own
    { "name": "Mehta Puri", "city": "Puri", "bookingEnabled": false }
  ]
}
```

Response gains `clinics[]` and `apiKeys[]` — **one key per clinic**, each shown
once. `clinic`, `apiKey` and `loginId` are still present and describe the first,
so no existing caller breaks.

`clinicName` still works and means a list of one. Omitting both creates one named
after the practice: a practice with no clinic cannot be booked into or synced.

Capped at 25 per call (signup stays at 10 — this side of the door is the vendor
provisioning a customer they have spoken to, not an anonymous form). **Rollback
is all-or-nothing across every clinic**: half a practice is worse than none,
because the next attempt with the same names collides with the wreckage.

---

## 2. `PATCH /api/v1/admin/clinics/:id` — **new**. A clinic can be edited

Auth: `x-admin-secret`. Only present when `ADMIN_SECRET` is set.

Until now nothing in the product could edit a clinic. Signup created it and that
was the last word. The only remedy for a wrong address was to delete the clinic
and lose its code, its slug and its bookings.

```
PATCH /api/v1/admin/clinics/:id
{ "city": "Puri", "address": "4 Beach Road", "bookingEnabled": false }

200 { "clinic": { ...adminClinic } }
```

Editable: `name`, `phone`, `email`, `address`, `city`, `state`, `timezone`,
`bookingEnabled`, `isActive`.

**Only the fields present are touched.** A PATCH that defaulted the absent ones
would let a form rendering four boxes blank out the six it does not know about —
which is how an address disappears when somebody edits a phone number.

### Deliberately NOT editable

| field | why |
| --- | --- |
| `code` | prefixes every login ID and numbered document the clinic has issued. Changing it orphans all of them. |
| `slug` | the public booking address, printed on cards and sent in texts. Settable once at creation, where somebody is choosing rather than correcting. |
| `ownerId` | moving a clinic between practices would silently move its bookings and staff scopes too. |

A **rename is allowed** — the name is a label and nothing keys off it.

Clearing `timezone` falls back to the current value, not to `Asia/Kolkata`:
relocating a clinic's timezone by accident would move every appointment time it
displays.

---

## 2b. `DELETE /api/v1/admin/clinics/:id` — **new**

Auth: `x-admin-secret`.

```
DELETE /api/v1/admin/clinics/:id            → refuses if anything below applies
DELETE /api/v1/admin/clinics/:id?force=true → clears the bookings refusal only

200 { "deleted": true, "id", "name",
      "removed": { "slots": 12, "liveBookings": 0, "loginsUnpinned": 1 } }
```

This is not deleting a row. It takes the licence, every slot published against
the clinic, and every booking inside those slots — patients expecting to be seen.
So three situations are refused outright rather than half-done and reported as
success:

| refusal | why | `force` clears it? |
| --- | --- | --- |
| the practice's **last** clinic | a practice with none cannot be booked into or synced | **no** |
| **live bookings** | people are expecting to be seen; the error says how many | **yes** |
| a login pinned **only** here | they would keep signing in with access to nothing — broken, not restricted. The error **names them**. | **no** |

A login scoped to this clinic **and others** is simply unpinned — no
confirmation, because nothing about their access breaks. Unpinning happens
*before* the clinic is removed, so no session ever holds a scope naming a clinic
that does not exist; anyone whose **default** was this clinic falls back to their
first remaining one, and their token version is bumped.

Renaming is via §2 (`PATCH`), and the `code` survives it.

---

## 3. `PATCH /api/v1/admin/accounts/:id` — accepts `clinicIds`

Auth: `x-admin-secret`.

Branch access could only be set at **creation**, so it was a decision nobody
could revise: a receptionist moved to the second branch had to be deleted and
recreated, losing their id and their history.

```
PATCH /api/v1/admin/accounts/:id
{ "clinicIds": ["<clinicId>", "<clinicId>"] }
```

- Ids are **filtered against the practice's own clinics**. This is the request
  that would otherwise let one practice's staff be pinned to another practice's
  clinic by pasting an id.
- An empty resulting list is a **400**. A login that can open nothing can still
  sign in, and looks broken rather than restricted.
- The default `clinicId` is pulled back inside the new scope if it fell outside.
- **Sessions are ended.** Access changed; a token carrying the old scope must not
  survive it.
- **Owners are excluded.** An owner's reach over every clinic is expressed by an
  **empty** `clinicIds`, so writing branches onto one would pin them to today's
  set and cut them out of the next clinic the practice opens.

---

## 4. `adminClinic` serialiser — five more fields

It returned only `city` out of the contact details. That was survivable while a
clinic's details were the practice's copied across and nothing could edit them.
Now that both are false, an edit form has to be able to **read** what it is about
to write — otherwise it shows `address` blank and blanks it on the next save.

Added: `phone`, `email`, `address`, `state`, `pincode`.

Affects `GET /admin/clinics`, `GET /admin/clinics/:id`, `POST /admin/clinics` and
the new PATCH. Purely additive.

---

## 5. `POST /api/v1/admin/tenants` — the first clinic inherits the practice address

A practice provisioned from the console got a first clinic with **no address,
city or state at all**, while one that registered itself got them filled in.
Same product, two different results depending on who typed it in.

`address`, `city` and `state` are now carried onto the first clinic, matching
`createClinicFor`. They are a starting point, not a verdict — the second branch
is somewhere else, and both are correctable via §2.

---

## 6. `GET /api/v1/admin/catalogue` — now serves `plans`

```jsonc
{ "modules": [
  { "module": "transport", "roles": [...], "staffRoles": [...], "permissions": [...],
    "plans": ["trial", "basic", "professional", "enterprise"] },
  { "module": "clinic", ..., "plans": [] }
]}
```

Served rather than hard-coded in the console, for the same reason the roles are:
a tier added to `models/Company.js` appears in the form without a frontend
release, and the console cannot offer one the server would refuse. Empty for
clinic, whose entitlement is a per-branch licence rather than a tier.

---

## 7. Two fixes to existing behaviour

**`app.js` — router order.** `clinicAdminRoutes` was mounted before
`adminAccountRoutes` on the same `/api/v1/admin` prefix. A router's `router.use`
runs for every request reaching the prefix, matched route or not, and the clinic
router's chain opens with `adminRateLimit` — 20 per 15 minutes, sized for
provisioning. Console traffic was spending that budget on its way past and the
operator was locked out of a screen they had just opened. The console router is
now mounted first.

**`routes/adminAccounts.js` — the plan lives at `subscription.plan`.** Four
places read and wrote flat `tenant.plan`. Mongoose strict mode drops an
undeclared path, so the save succeeded, the response echoed the new tier back off
the in-memory document, and the company stayed on the old one. Every upgrade
reported success and no customer's limits ever moved.

---

## Drive output

```
ok  the catalogue now serves transport plans — ["trial","basic","professional","enterprise"]
ok  ...and none for clinic — []
ok  the first clinic inherits the practice city — Bhubaneswar
ok  a second clinic keeps its OWN city — Cuttack
ok  ...its own address — 9 Ring Road
ok  ...its own phone — 9000000333
ok  ...and does NOT inherit the practice city
ok  a clinic can now be EDITED — city — Puri
ok  ...address — 4 Beach Road
ok  ...bookings can be switched off — false
ok  ...and untouched fields survive — 9000000333
ok  ...and the code is unchanged — CUT2 -> CUT2
```

Registration, both shapes, read back from the database:

```
Alpha Clinic    city=Bhubaneswar  phone=9000000444  addr=-            bookable=true   <- legacy strings
Beta Clinic     city=Bhubaneswar  phone=9000000444  addr=-            bookable=true   <- legacy strings
BBSR Clinic     city=Bhubaneswar  phone=9000000666  addr=1 Janpath    bookable=true   <- objects
Cuttack Clinic  city=Cuttack      phone=9000000777  addr=5 Ring Road  bookable=false  <- objects
```

Many clinics, rename and delete:

```
ok  four clinics created in one call — 4
ok  ...one API key each, all distinct
ok  ...and all four are listed — Multi HQ, Multi Cuttack, Multi Puri, Multi Rourkela
ok  the head office inherits the practice city
ok  a branch keeps its own city
ok  ...and its own address
ok  ...and per-clinic bookingEnabled
ok  a clinic can be RENAMED — Multi Rourkela West
ok  ...and keeps its code — MUL4 -> MUL4
ok  a clinic can still be added later
ok  a clinic can be DELETED — {"slots":0,"liveBookings":0,"loginsUnpinned":0}
ok  ...and is gone from the list — 4
ok  deleting the only clinic a login can open is refused
ok  ...but allowed once they can open another — {"loginsUnpinned":1}
ok  ...and the staff member is unpinned from it
ok  the practice's LAST clinic cannot be deleted
```

Clinic scoping:

```
ok  a staff login is pinned to one branch
ok  access can be WIDENED after creation
ok  ...and narrowed
ok  ...and the default branch follows the new scope
ok  an empty scope is refused
ok  another practice's clinic is refused
ok  the owner still has an EMPTY scope (= all clinics)
```
