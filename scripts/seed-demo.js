require("dotenv").config();

const mongoose = require("mongoose");

const Company = require("../models/Company");
const Account = require("../models/Account");
const Customer = require("../models/Customer");
const Vehicle = require("../models/Vehicle");
const Driver = require("../models/Driver");
const Trip = require("../models/Trip");
const TripExpense = require("../models/TripExpense");
const LocationPing = require("../models/LocationPing");
const VehicleState = require("../models/VehicleState");
const Counter = require("../models/Counter");
const { hashPassword } = require("../utils/auth");
const { presetFor } = require("../utils/permissions");
const { computeRevenue, computeEstimate, recalculateTrip } = require("../utils/tripFinance");
const { summariseJourney } = require("../utils/tripLifecycle");
const { pathDistanceKm } = require("../utils/geo");

/*
 * A demonstration company with enough real shape to develop against: an owner
 * and three sub-accounts, a small fleet, and trips at every stage of the
 * lifecycle — including one finished run with a simulated GPS track, so the map,
 * the distance total and the trip-history screen all have something to show.
 *
 * The brief suggests simulating vehicle locations during development rather
 * than waiting for the driver app, and that is exactly what the track below is.
 *
 *   node scripts/seed-demo.js
 *   node scripts/seed-demo.js --reset     removes the demo company first
 *
 * It refuses to run twice without --reset, so it cannot quietly double every
 * figure in the reports.
 */

const DEMO_EMAIL = "owner@abctransport.test";
const DEMO_PASSWORD = "transport123";

/* A rough Bhubaneswar-Delhi line. Real enough that the distance, the progress
 * bar and the off-route check all behave the way they will in production. */
const BBSR_DELHI = [
  { lat: 20.2961, lng: 85.8245, name: "Bhubaneswar" },
  { lat: 20.4625, lng: 85.8828, name: "Cuttack" },
  { lat: 21.4934, lng: 84.0298, name: "Sambalpur" },
  { lat: 22.0797, lng: 82.159, name: "Raigarh" },
  { lat: 23.1815, lng: 79.9864, name: "Jabalpur" },
  { lat: 25.4358, lng: 78.5685, name: "Jhansi" },
  { lat: 27.1767, lng: 78.0081, name: "Agra" },
  { lat: 28.6139, lng: 77.209, name: "Delhi" },
];

async function main() {
  const reset = process.argv.includes("--reset");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("connected");

  const existing = await Company.findOne({ name: "ABC Transport" });
  if (existing) {
    if (!reset) {
      console.log(
        "Demo company already exists. Re-run with --reset to rebuild it.\n" +
          `  sign in: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`
      );
      await mongoose.disconnect();
      return;
    }
    console.log("removing the existing demo company...");
    const id = existing._id;
    /* Order does not matter here — nothing cascades — but every collection that
     * carries a companyId has to be listed, or the next seed inherits orphans
     * that belong to a company that no longer exists. */
    await Promise.all([
      LocationPing.deleteMany({ companyId: id }),
      TripExpense.deleteMany({ companyId: id }),
      Trip.deleteMany({ companyId: id }),
      Vehicle.deleteMany({ companyId: id }),
      Driver.deleteMany({ companyId: id }),
      Customer.deleteMany({ companyId: id }),
      Account.deleteMany({ companyId: id }),
      Counter.deleteMany({ companyId: id }),
      VehicleState.deleteMany({ companyId: id }),
      mongoose.connection.collection("auditlogs").deleteMany({ companyId: id }),
      Company.deleteOne({ _id: id }),
    ]);
  }

  const company = await Company.create({
    name: "ABC Transport",
    legalName: "ABC Transport Pvt Ltd",
    city: "Bhubaneswar",
    state: "Odisha",
    phone: "+91 9000000000",
    email: "office@abctransport.test",
    subscription: { plan: "professional" },
    defaults: {
      gstPercent: 5,
      dieselRatePerLitre: 92,
      averageKmPerLitre: 4,
      driverFeePerTrip: 4000,
      foodAllowancePerDay: 800,
      nightAllowancePerNight: 500,
      tollPerKm: 1.8,
      targetMarginPercent: 30,
    },
    /* Left at the default fifteen minutes, which is the setting the brief
     * asks for and the one the owner can change from the settings screen. */
  });
  console.log(`company: ${company.name}`);

  const password = await hashPassword(DEMO_PASSWORD);
  const owner = await Account.create({
    companyId: company._id,
    name: "Srikanta",
    email: DEMO_EMAIL,
    role: "owner",
    password,
  });

  /* The three sub-accounts from the brief, each on its role preset — which the
   * owner can then tick and untick, because the presets are a starting point
   * and not a hard-coded role. */
  for (const [name, role] of [
    ["Manager", "manager"],
    ["Accountant", "accountant"],
    ["Operations", "operations"],
  ]) {
    await Account.create({
      companyId: company._id,
      name,
      email: `${role}@abctransport.test`,
      role,
      permissions: presetFor(role),
      password,
    });
  }
  console.log("users: owner + manager + accountant + operations");

  const customers = await Customer.insertMany([
    { companyId: company._id, name: "XYZ Industries", city: "Bhubaneswar", creditDays: 30 },
    { companyId: company._id, name: "Odisha Steels", city: "Rourkela", creditDays: 15 },
    { companyId: company._id, name: "Kalinga Cement", city: "Cuttack", creditDays: 45 },
  ]);

  const vehicles = await Vehicle.insertMany([
    {
      companyId: company._id,
      registrationNumber: "OD02AB1234",
      type: "TRUCK",
      make: "Tata",
      model: "Signa 4825",
      capacityTons: 20,
      averageKmPerLitre: 4,
      documents: [
        {
          type: "Insurance",
          number: "INS-99812",
          /* Deliberately close, so the expiry dashboard has something on it the
           * first time it is opened. */
          expiresOn: new Date(Date.now() + 20 * 86400000),
        },
        { type: "Fitness", number: "FIT-2231", expiresOn: new Date(Date.now() + 200 * 86400000) },
      ],
    },
    {
      companyId: company._id,
      registrationNumber: "OD02CD5678",
      type: "TRAILER",
      make: "Ashok Leyland",
      capacityTons: 30,
      averageKmPerLitre: 3.4,
    },
    {
      companyId: company._id,
      registrationNumber: "OD02EF9999",
      type: "CONTAINER",
      make: "Eicher",
      capacityTons: 16,
      averageKmPerLitre: 5,
      /* One lorry on a tighter interval than the fleet, to exercise the
       * per-vehicle override. */
      trackingIntervalSeconds: 300,
    },
    {
      companyId: company._id,
      registrationNumber: "OD02GH4545",
      type: "TIPPER",
      capacityTons: 12,
      status: "MAINTENANCE",
    },
  ]);

  const drivers = await Driver.insertMany([
    {
      companyId: company._id,
      name: "Rajesh Kumar",
      phone: "+91 9811111111",
      licenceNumber: "OD0220110001",
      licenceExpiry: new Date(Date.now() + 400 * 86400000),
      defaultTripFee: 4000,
    },
    {
      companyId: company._id,
      name: "Suresh Behera",
      phone: "+91 9822222222",
      licenceNumber: "OD0220120044",
      licenceExpiry: new Date(Date.now() + 25 * 86400000),
      defaultTripFee: 3800,
    },
    {
      companyId: company._id,
      name: "Amit Sahoo",
      phone: "+91 9833333333",
      licenceNumber: "OD0220150077",
      defaultTripFee: 4200,
    },
  ]);

  /* A phone login for the first driver, so the tracking endpoints can be
   * exercised end to end without inventing one by hand. */
  const driverAccount = await Account.create({
    companyId: company._id,
    name: drivers[0].name,
    email: "rajesh@abctransport.test",
    role: "custom",
    permissions: ["dashboard.view", "trips.view", "expenses.manage"],
    driverId: drivers[0]._id,
    password,
  });
  await Driver.updateOne({ _id: drivers[0]._id }, { $set: { accountId: driverAccount._id } });
  console.log("drivers: 3 (Rajesh has a phone login)");

  /* ---- a completed trip, with a simulated track ---- */
  const completed = await makeTrip({
    company,
    owner,
    customer: customers[0],
    vehicle: vehicles[1],
    driver: drivers[1],
    origin: "Bhubaneswar",
    destination: "Delhi",
    revenue: { freightCharges: 75000, loadingCharges: 5000, unloadingCharges: 5000 },
    estimate: { fuel: 20000, toll: 3000, driver: 5000, food: 2000, other: 2000 },
    daysAgo: 12,
  });
  await simulateTrack(completed, BBSR_DELHI, company);
  await addExpenses(completed, owner, [
    ["FUEL", 18500, "Cuttack", 0.2],
    ["TOLL", 2700, "Sambalpur", 0.5],
    ["DRIVER_FEE", 4000, "", 0.6],
    ["FOOD", 2200, "Jabalpur", 0.7],
    ["ALLOWANCE", 2000, "", 0.8],
    ["PARKING", 500, "Agra", 0.9],
    ["REPAIR", 1200, "Jhansi", 0.85],
    ["LOADING", 1000, "Bhubaneswar", 0.05],
  ]);
  await advance(completed, owner, ["PLANNED", "ASSIGNED", "READY", "IN_TRANSIT", "ARRIVED", "DELIVERED", "COMPLETED"]);
  console.log(`trip ${completed.tripNumber}: completed, with track and full ledger`);

  /* ---- one running, so the live map and the dashboard have content ---- */
  const running = await makeTrip({
    company,
    owner,
    customer: customers[1],
    vehicle: vehicles[0],
    driver: drivers[0],
    origin: "Bhubaneswar",
    destination: "Delhi",
    revenue: { freightCharges: 82000, loadingCharges: 4000 },
    estimate: { fuel: 21000, toll: 3200, driver: 4000, food: 2400, other: 1500 },
    daysAgo: 1,
  });
  await advance(running, owner, ["PLANNED", "ASSIGNED", "READY", "IN_TRANSIT"]);
  /* Only part of the way, so progress and remaining distance are non-trivial. */
  await simulateTrack(running, BBSR_DELHI.slice(0, 4), company, { partial: true });
  await addExpenses(running, owner, [
    ["FUEL", 9500, "Cuttack", 0.2],
    ["TOLL", 1400, "Sambalpur", 0.6],
  ]);
  console.log(`trip ${running.tripNumber}: in transit`);

  /* ---- one planned and one draft, for the board ---- */
  const planned = await makeTrip({
    company,
    owner,
    customer: customers[2],
    vehicle: vehicles[2],
    driver: drivers[2],
    origin: "Cuttack",
    destination: "Hyderabad",
    revenue: { freightCharges: 46000 },
    estimate: { fuel: 12000, toll: 1800, driver: 3500, food: 1200, other: 800 },
    daysAgo: 0,
  });
  await advance(planned, owner, ["PLANNED", "ASSIGNED"]);

  await makeTrip({
    company,
    owner,
    customer: customers[0],
    origin: "Bhubaneswar",
    destination: "Kolkata",
    revenue: { freightCharges: 18000 },
    daysAgo: 0,
  });

  console.log("\n----------------------------------------");
  console.log("Demo data ready.");
  console.log(`  owner       ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  manager     manager@abctransport.test / ${DEMO_PASSWORD}`);
  console.log(`  accountant  accountant@abctransport.test / ${DEMO_PASSWORD}`);
  console.log(`  operations  operations@abctransport.test / ${DEMO_PASSWORD}`);
  console.log(`  driver app  rajesh@abctransport.test / ${DEMO_PASSWORD}`);
  console.log("----------------------------------------");

  await mongoose.disconnect();
}

async function makeTrip({
  company,
  owner,
  customer,
  vehicle,
  driver,
  origin,
  destination,
  revenue,
  estimate,
  daysAgo,
}) {
  const seq = await Counter.nextSequence(company._id, "trip");
  const route = BBSR_DELHI.map((p) => ({ lat: p.lat, lng: p.lng }));

  const trip = new Trip({
    companyId: company._id,
    tripNumber: Counter.formatNumber(company.tripPrefix, seq),
    sequence: seq,
    customerId: customer?._id || null,
    customerName: customer?.name || "",
    vehicleId: vehicle?._id || null,
    vehicleRegistration: vehicle?.registrationNumber || "",
    driverId: driver?._id || null,
    driverName: driver?.name || "",
    origin: { name: origin, lat: BBSR_DELHI[0].lat, lng: BBSR_DELHI[0].lng },
    destination: {
      name: destination,
      lat: BBSR_DELHI[BBSR_DELHI.length - 1].lat,
      lng: BBSR_DELHI[BBSR_DELHI.length - 1].lng,
    },
    scheduledStart: new Date(Date.now() - daysAgo * 86400000),
    expectedArrival: new Date(Date.now() - (daysAgo - 3) * 86400000),
    createdBy: owner._id,
    status: "DRAFT",
    statusHistory: [
      {
        status: "DRAFT",
        at: new Date(Date.now() - daysAgo * 86400000),
        by: owner._id,
        byName: owner.name,
      },
    ],
    plannedRoute: {
      points: route,
      distanceKm: pathDistanceKm(route),
      source: "MANUAL",
      revision: 1,
      updatedAt: new Date(),
    },
    revenue: computeRevenue({ gstPercent: company.defaults.gstPercent, ...revenue }),
    estimate: estimate ? computeEstimate(estimate) : undefined,
  });

  await trip.save();
  return trip;
}

/* Walk the trip through its lifecycle using the real transition rules, so the
 * seeded data cannot contain a state the API itself would refuse to produce. */
async function advance(trip, owner, statuses) {
  const { changeStatus } = require("../utils/tripLifecycle");
  for (const status of statuses) {
    await changeStatus(trip, status, { account: owner, note: "seeded" });
  }
  return trip;
}

/*
 * Fabricate a GPS track along a route.
 *
 * Points are interpolated between the waypoints at the company's own reporting
 * interval, with a little lateral noise so the line is not suspiciously
 * straight and the distance total is realistic rather than the exact
 * great-circle figure.
 */
async function simulateTrack(trip, waypoints, company, { partial = false } = {}) {
  const interval = company.trackingConfig().intervalSeconds;

  /* Build the points first so the track can be anchored by its END. */
  const steps = 12;
  const shape = [];
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    for (let s = 0; s < steps; s += 1) {
      const f = s / steps;
      shape.push({
        lat: a.lat + (b.lat - a.lat) * f + (Math.random() - 0.5) * 0.01,
        lng: a.lng + (b.lng - a.lng) * f + (Math.random() - 0.5) * 0.01,
      });
    }
  }
  if (shape.length === 0) return;

  /*
   * The track is anchored to when it FINISHED, and walked backwards from there.
   *
   * Anchoring it to trip.startedAt was wrong, and wrong in the expensive
   * direction: a trip is moved to IN_TRANSIT before its track is generated, so
   * startedAt is "now" and the points ran forward from it — putting the whole
   * journey up to nine hours into the future. The live map then showed a lorry
   * whose newest fix had not happened yet, and any genuine ping from the driver
   * app was rejected as out-of-order against it.
   *
   * A running trip ends its track now; a finished one ended two days ago.
   */
  const endAt = partial ? Date.now() : Date.now() - 2 * 86400000;
  let t = endAt - (shape.length - 1) * interval * 1000;

  const docs = shape.map((point) => {
    const recordedAt = new Date(t);
    t += interval * 1000;
    return {
      companyId: trip.companyId,
      tripId: trip._id,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      lat: point.lat,
      lng: point.lng,
      speedKmh: 40 + Math.round(Math.random() * 25),
      headingDeg: Math.round(Math.random() * 360),
      accuracyM: 8 + Math.round(Math.random() * 12),
      recordedAt,
      receivedAt: recordedAt,
      accepted: true,
    };
  });

  await LocationPing.insertMany(docs, { ordered: false }).catch(() => {});

  const first = docs[0];
  const last = docs[docs.length - 1];

  /* Keep the trip's own dates consistent with the track it now has. A trip that
   * claims to have started an hour ago with three days of history behind it
   * makes every duration on the screen nonsense. */
  trip.startedAt = first.recordedAt;
  if (!partial) {
    trip.arrivedAt = last.recordedAt;
    trip.deliveredAt = last.recordedAt;
  }

  trip.lastPosition = {
    lat: last.lat,
    lng: last.lng,
    speedKmh: last.speedKmh,
    headingDeg: last.headingDeg,
    accuracyM: last.accuracyM,
    recordedAt: last.recordedAt,
    receivedAt: new Date(),
    isOffRoute: false,
    coveredKm: 0,
    remainingKm: 0,
  };

  await trip.save();
  await summariseJourney(trip);

  /*
   * The live map reads VehicleState, not the ping history — one row per lorry,
   * upserted. Seeding the pings without this leaves the map empty even though
   * the trips clearly have tracks, which looks like a broken feature rather
   * than missing demo data.
   *
   * Only a trip that is still running gets one. A completed trip's lorry is
   * back in the yard, and leaving it on the map as "moving" would be a lie the
   * dashboard then repeats in its fleet summary.
   */
  if (partial) {
    const vehicle = await Vehicle.findById(trip.vehicleId).select("registrationNumber");
    await VehicleState.updateOne(
      { vehicleId: trip.vehicleId },
      {
        $set: {
          companyId: trip.companyId,
          registrationNumber: vehicle?.registrationNumber || "",
          tripId: trip._id,
          tripNumber: trip.tripNumber,
          driverId: trip.driverId,
          driverName: trip.driverName,
          lat: last.lat,
          lng: last.lng,
          speedKmh: last.speedKmh,
          headingDeg: last.headingDeg,
          accuracyM: last.accuracyM,
          recordedAt: last.recordedAt,
          receivedAt: new Date(),
          movementState: "MOVING",
          stateSince: new Date(Date.now() - 20 * 60 * 1000),
          isOffRoute: false,
          coveredKm: trip.journey?.distanceKm || 0,
          remainingKm: Math.max(
            0,
            (trip.plannedRoute?.distanceKm || 0) - (trip.journey?.distanceKm || 0)
          ),
          intervalSeconds: company.trackingConfig().intervalSeconds,
          lastUploadWasOffline: false,
        },
      },
      { upsert: true }
    );
  }
}

async function addExpenses(trip, owner, rows) {
  const start = new Date(trip.startedAt || trip.createdAt).getTime();
  const span = 3 * 86400000;

  await TripExpense.insertMany(
    rows.map(([category, amount, location, fraction]) => ({
      companyId: trip.companyId,
      tripId: trip._id,
      tripNumber: trip.tripNumber,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      category,
      amount,
      location,
      spentAt: new Date(start + span * fraction),
      paidBy: "DRIVER",
      paymentMethod: "CASH",
      source: "OWNER",
      addedBy: owner._id,
      addedByName: owner.name,
      approvalStatus: "APPROVED",
      verifiedBy: owner._id,
      verifiedByName: owner.name,
      verifiedAt: new Date(),
    }))
  );

  await recalculateTrip(trip);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
