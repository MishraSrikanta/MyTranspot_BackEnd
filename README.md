# MyTransport — Backend

A cloud transportation management and profitability API: trips, vehicles,
drivers, expenses, estimates and live vehicle tracking, with the actual
profitability of every trip.

Built to the same conventions as the FinanceGPT backend it was modelled on —
CommonJS, Express 5, Mongoose, JWT bearer auth, and one error envelope for the
whole API.

---

## The one architectural idea

**The trip is the spine. GPS is one of its attributes.**

A trip has a customer, a price, an expense ledger and a profit whether or not a
single phone ever reports a position. Live tracking *attaches to* a trip; it is
not the thing trips live inside. That is what keeps the business usable on the
day a driver's handset is flat, and it is why location history is a separate
collection referenced from the trip rather than the other way round.

```
Trip
├── Revenue          what the customer pays, itemised
├── Estimate         what it was budgeted to cost   (frozen when it starts)
├── Expenses         what it actually cost          (separate collection)
├── Vehicle / Driver / Customer
├── Planned route    + every superseded version
├── Location history (separate collection)
└── Profit           revenue − approved cost
```

## Multi-tenancy

Every document carries a `companyId`. Every query is scoped by it. That id is
read **from the authenticated account** — never from a header, a path segment or
a body field. There is no value a client can send that changes which company's
data it reads.

Trip numbers are per company, so two tenants can both hold `TRP-000102`.

---

## Running it

```bash
cd backend
npm install
cp .env.example .env        # then fill in MONGO_URI and JWT_SECRET
npm run dev                 # or: npm start
```

The server refuses to start without `MONGO_URI` and `JWT_SECRET`, because a
missing secret otherwise looks like a broken login rather than a missing
variable.

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Token signing key — long and random |
| `PORT` | Defaults to `5100` |
| `CORS_ORIGINS` | Comma-separated allowlist. `*` for local development only |

### Scripts

```bash
npm run seed             # demo company: owner + 3 sub-accounts, fleet, trips with a simulated GPS track
npm run seed -- --reset  # rebuild it
npm run ensure-owner "ABC Transport" owner@abc.test "Srikanta" secret123
npm run check-indexes    # build every index and print what the database has
```

Seed logins are all `transport123`: `owner@`, `manager@`, `accountant@`,
`operations@`, and `rajesh@` (driver app) at `abctransport.test`.

---

## Users and permissions

One owner per company plus sub-accounts. The brief's four roles exist as
**presets**, not as hard-coded behaviour — what is stored on a user is a list of
permissions, and the role only decides what that list starts as.

That matters because no two transport offices divide the work the same way. One
owner wants the accountant on the live map; the next does not want the manager
near driver fees. With presets that is a tick box. With hard-coded roles it is a
release.

| Role | Starts with |
|---|---|
| `owner` | everything, and short-circuits every check — an owner cannot lock themselves out |
| `manager` | trips, fleet, drivers, day-to-day spend, reports |
| `accountant` | every rupee, plus expense approval. No dispatching |
| `operations` | everything operational, **no** `profit.view` |
| `custom` | starts empty; the owner ticks what is needed |

Read and write are separate throughout (`trips.view` / `trips.manage`), and
three permissions are deliberately carved out on their own:

- `trips.close` — closing banks the profit and freezes the ledger
- `expenses.approve` — approving is what moves a claim into the trip cost
- `tracking.manage` — changing the reporting interval has a data-cost consequence

`GET /api/v1/users/permissions` serves the catalogue, so the frontend builds its
menu from the server and a new permission appears in the UI without a frontend
release.

---

## Live tracking, and how the 15-minute update actually works

The default reporting interval is **15 minutes**, set per company and
overridable per vehicle. The owner can change it at any time.

### The flow

1. The driver app samples GPS on the interval — **whether or not it has signal**
   — and queues each sample locally with the time it was *taken*.
2. When a connection is available it `POST`s the whole queue to
   `/api/v1/tracking/pings` and clears it on a `2xx`.
3. The response carries the **current interval**, so an owner's change in the
   office reaches every handset on its next upload. No push channel is needed,
   and it works on a phone that has been out of contact for two days.

This is the answer to "the lorry drove four hours through a valley with no
network". The alternative — send the current position, drop it if the network is
down — produces a straight line across Chhattisgarh and a distance total short by
a hundred kilometres, which is money, because the driver is paid per kilometre.

Three consequences run through the implementation:

- **`recordedAt` is authoritative, `receivedAt` is diagnostic.** Ordering,
  distance and speed all come from when the fix was taken.
- **Uploads are idempotent.** A unique index on `(vehicleId, recordedAt)` makes
  a re-sent batch a no-op, so a phone that lost the reply can simply send again.
- **A batch is processed in time order as one continuous track**, so distance
  across the offline gap is measured properly.

### Fixes the server will not count

Stored anyway, with the reason, and left out of the distance:

| Reason | Why |
|---|---|
| `POOR_ACCURACY` | a cell-tower guess, over `maxAccuracyM` (default 500 m) |
| `IMPLAUSIBLE_JUMP` | implied speed over 140 km/h across more than 200 m |
| `OUT_OF_ORDER` | a late fix older than one already held |

Discarding them silently would make a tracker producing rubbish for a fortnight
look exactly like a lorry standing still.

### Settings

`PUT /api/v1/company/tracking`

| Field | Default | Notes |
|---|---|---|
| `intervalSeconds` | `900` | 10 s – 1 h. The floor is where GPS stops surviving a working day |
| `idleIntervalSeconds` | = interval | a parked lorry need not report as often |
| `routeDeviationKm` | `5` | loose on purpose — an alert nobody trusts is worse than none |
| `maxAccuracyM` | `500` | |
| `minStopMinutes` | `15` | below this it is a queue, not a stop |
| `maxOfflineBacklogHours` | `72` | how far back an upload may reach |
| `offlineAfterMissedIntervals` | `3` | derived, so a shorter interval also greys a lorry out sooner |

Per vehicle: `PUT /api/v1/company/vehicles/:id/tracking`.

---

## Routes: planned, changed, and actual

- `PUT /api/v1/trips/:id/route` sets the planned line. The **previous route is
  never overwritten** — it is pushed onto `routeHistory` with who changed it, why
  and when, and the revision number goes up.
- Distance is measured **on the server** from the points, never taken from the
  client: the driver's fee and the fuel estimate are calculated from it, and a
  wrong figure is not detectable later.
- Every ping is checked against the planned line. Past the threshold, the trip is
  flagged — **once, and the flag stays raised**. The owner wants to know it
  happened on Tuesday night, not only whether it is happening at this second.
- On close, `summariseJourney` walks the stored track and banks the **actual**
  distance, driving time and stops onto the trip.
- `GET /api/v1/trips/:id/route` returns the plan, every superseded version, the
  driven line, and `varianceKm` between planned and actual.

No map provider is called from the server. Distance, deviation and remaining
distance are business facts that decide a driver's fee and a customer's bill;
they must not stop working, or start costing per request, because a routing API
is down or unpaid. The frontend is free to draw a road-snapped line on top.

Polylines are thinned (Ramer–Douglas–Peucker) before being sent for drawing —
the corners survive, the motorway filler does not. Stored history is never
thinned; `?full=true` returns every point.

---

## Money

**Profit is measured against the pre-GST subtotal, never the invoice total.**
GST is collected on the government's behalf. A trip billed at ₹85,000 + 5% shows
₹89,250 on the invoice, and an owner shown a profit computed from ₹89,250 is
being told they made ₹4,250 they will have to hand over.

### Estimate vs actual

The estimate is **frozen when the trip starts**. An estimate that can still be
edited afterwards is not a budget — it is a way of making every trip look like it
came in on target, and it would make the whole planned-versus-actual report
worthless.

`GET /api/v1/trips/:id/variance` returns it line by line, with `direction`
(`under` / `over` / `on`) so colour coding is consistent everywhere.

### Approval

Only `APPROVED` expenses reach the profit. A driver's unverified ₹2,000 fuel
claim is real and is reported as `pendingCost`, but folding it into the margin
before anyone has seen the receipt is how a trip shows one profit today and
another tomorrow.

- Entries from a driver, or from anyone without `expenses.approve`, land
  `PENDING`.
- **Nobody approves their own claim.** Without that the workflow is decoration.
- Closing a trip with pending expenses is refused, with an audited override.
- Editing an approved amount drops it back into the queue.

The ledger recomputes the whole trip after every change rather than adjusting a
cached total by a delta — a delta applied twice, or missed because a request
failed halfway, leaves a number that is wrong for ever with nothing to detect it.

---

## API surface

All under `/api/v1`. Bearer token in `Authorization`.

**Auth** — `POST /auth/register` (company + owner), `/auth/login` (12 h token),
`/auth/driver-login` (90 d token, `aud: driver-app`), `GET /auth/me`,
`POST /auth/change-password`

**Users** — `GET|POST /users`, `PUT|DELETE /users/:id`, `GET /users/permissions`

**Company** — `GET|PUT /company`, `GET|PUT /company/tracking`,
`PUT /company/defaults`, `PUT /company/vehicles/:id/tracking`

**Masters** — `/customers`, `/vehicles` (+ `/documents`,
`/vehicles/documents/expiring`), `/drivers` (+ `/:id/payments`)

**Trips** — `GET|POST /trips`, `GET|PUT /trips/:id`, `PUT /trips/:id/revenue`,
`PUT /trips/:id/estimate`, `POST /trips/:id/status`, `GET|PUT /trips/:id/route`,
`GET /trips/:id/timeline`, `GET /trips/:id/variance`,
`POST /trips/:id/recalculate`

**Expenses** — `GET|POST /expenses`, `PUT|DELETE /expenses/:id`,
`POST /expenses/:id/approve|reject`, `GET /expenses/pending`

**Estimates** — `POST /estimates/calculate` (prices without saving — the one the
owner uses with a customer on the phone), `GET|POST /estimates`,
`GET|PUT /estimates/:id`, `POST /estimates/:id/send|accept|reject`.
Accepting creates the trip, carrying the quote's cost lines across as the trip's
budget and its price as the trip's revenue.

**Tracking** — `GET /tracking/config`, `POST /tracking/pings` *(driver app)*,
`POST /tracking/ping`, `GET /tracking/live`, `GET /tracking/live/:tripId`,
`GET /tracking/history/:tripId`, `POST /tracking/history/:tripId/resummarise`,
`GET /tracking/vehicle/:vehicleId`

**Money & reporting** — `GET|POST /payments`, `GET /dashboard`,
`GET /reports/profit|expenses|vehicles|drivers|customers|routes|variance|receivables`

Reports count **closed trips only** — a trip still on the road has half its fuel
bills unentered, and including it would make last month's margin change every
time a driver adds a toll.

### Error shape

```json
{ "error": { "code": "TRIP_NOT_FOUND", "message": "That trip no longer exists.", "details": null } }
```

`code` is stable and machine-readable; `message` is shown to the user; `details`
carries a field-level map for validation errors. Some codes add context —
`BAD_TRANSITION` carries `allowed`, so the UI can grey out the wrong buttons
instead of letting the driver find out by tapping.

---

## Trip lifecycle

```
DRAFT → PLANNED → ASSIGNED → READY → IN_TRANSIT → ARRIVED → DELIVERED → COMPLETED
                                  exceptions: ON_HOLD · DELAYED · CANCELLED
```

Forward one step, and backward one step **only while the trip is still in the
yard**. Once a lorry is `IN_TRANSIT` there is no reversing: un-starting a trip
that has collected fuel bills and GPS points would leave a track and a ledger
attached to a trip claiming never to have left. A trip started by mistake is
`CANCELLED`, which is honest and keeps the evidence.

`ASSIGNED` and `IN_TRANSIT` mark the lorry and driver busy. `COMPLETED`
summarises the journey, recounts the ledger, then banks distance, revenue, cost
and driver fees onto the vehicle and driver — **in that order**, because
releasing first would add zero kilometres to the fleet totals, permanently.

`ON_HOLD` / `DELAYED` remember where the trip was; `RESUME` puts it back.

---

## Data model

| Collection | Notes |
|---|---|
| `companies` | the tenant: settings, tracking config, standing rates, plan |
| `accounts` | logins; `permissions[]` is the authority, `role` is a label |
| `customers` `drivers` `vehicles` | masters, archived rather than deleted |
| `trips` | the spine, with cached `actuals`, `journey` and `lastPosition` |
| `tripexpenses` | own collection: highest-written, queried across trips |
| `locationpings` | highest-volume by two orders of magnitude; two indexes |
| `vehiclestates` | **one row per lorry**, upserted — what the live map reads |
| `estimates` | quotes, so pricing can be compared against outturn |
| `payments` | both directions, one `kind` discriminator |
| `auditlogs` | only actions somebody may have to answer for |
| `counters` | atomic `$inc` per company — `count()+1` gives two trips one number |

### Three deliberate denormalisations

- **`trip.lastPosition`** — the live map reads it instead of sorting the newest
  ping per trip out of the largest collection in the system on every refresh.
- **`vehiclestates`** — one row per lorry, so the fleet map is a single indexed
  find, and so a lorry parked at the yard with no open trip still has a position.
- **`vehicle.totals` / `driver.totals`** — advanced once at close, so the
  profitability tables do not aggregate every trip ever run on each page load.

Names (customer, plate, driver) are snapshotted onto trips and expenses: a trip
closed in 2026 must still print what it ran with after the driver leaves.

---

## Known limits

Stated plainly rather than left to be discovered:

- **No token revocation.** Changing a password issues a new token; the old one
  stays valid until it expires.
- **Rate limiting is in-process.** Behind more than one instance the effective
  limit multiplies by the instance count. Enough to stop a runaway handset and
  slow a password guesser; replace with Redis when it is not.
- **No file storage.** `receiptUrl` and `fileUrl` take a URL; uploading is the
  caller's problem for now.
- **No mail or SMS.** `POST /estimates/:id/send` marks a quote as given to the
  customer and starts the clock; it does not deliver it.
- **No billing.** Plan limits are enforced; nothing is charged.
- **Reports aggregate live** rather than from a rollup, which is why the window
  is capped at two years.
