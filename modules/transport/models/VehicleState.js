const mongoose = require("mongoose");

/*
 * Where each lorry is, right now. Exactly one document per vehicle, overwritten
 * in place.
 *
 * The live map needs "every lorry in this fleet, with its latest fix" in one
 * query, and it needs it every few seconds with the whole office watching. Two
 * other shapes were considered and rejected:
 *
 *   - reading the newest LocationPing per vehicle: a sort over the largest
 *     collection in the system, repeated per lorry, on every map refresh;
 *   - reading it off the open trips: works for a running trip, but the fleet
 *     map also has to show the lorry that finished this morning and is parked
 *     at the yard, and that has no open trip to read.
 *
 * So the current position lives here, in a collection with one row per lorry,
 * and the history lives in LocationPing. That is the whole reason for the
 * duplication.
 */

/* What the map shows, and the colour of the dot. Derived when a ping lands
 * rather than at read time, so a list of forty lorries does not compute forty
 * staleness windows on every refresh. */
const MOVEMENT_STATES = ["MOVING", "IDLE", "STOPPED", "OFFLINE", "NO_DATA"];

const vehicleStateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
      unique: true,
    },
    /* Snapshotted so the map can label a marker without joining three
     * collections for every pin on screen. */
    registrationNumber: { type: String, default: "", trim: true, uppercase: true },

    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", default: null, index: true },
    tripNumber: { type: String, default: "" },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null },
    driverName: { type: String, default: "" },

    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    speedKmh: { type: Number, default: 0 },
    headingDeg: { type: Number, default: null },
    accuracyM: { type: Number, default: null },
    batteryPercent: { type: Number, default: null },

    recordedAt: { type: Date, default: null, index: true },
    receivedAt: { type: Date, default: null },

    movementState: { type: String, enum: MOVEMENT_STATES, default: "NO_DATA", index: true },
    /* Since when it has been in that state — "stopped for 3h 20m" is the part
     * an owner actually reacts to, not the word "stopped". */
    stateSince: { type: Date, default: null },

    offRouteKm: { type: Number, default: null },
    isOffRoute: { type: Boolean, default: false },
    /* The last fix was too coarse to measure with — a browser positioning by
     * Wi-Fi rather than a GPS. The map marks it so nobody reads a two-kilometre
     * guess as a street address. */
    isApproximate: { type: Boolean, default: false },
    /* Progress along the current trip, copied here so the map sidebar shows a
     * bar per lorry without opening each trip. */
    coveredKm: { type: Number, default: 0 },
    remainingKm: { type: Number, default: 0 },

    /*
     * How the vehicle's phone is configured, resolved from the per-vehicle
     * override and the company setting. Echoed here so an owner watching the
     * map can see that a lorry reporting sparsely is on a fifteen-minute
     * interval rather than broken.
     */
    intervalSeconds: { type: Number, default: null },
    /* True when the last batch arrived as a backlog: the tracker is fine, the
     * network was not. */
    lastUploadWasOffline: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* The live map: one company, ordered by who reported most recently. */
vehicleStateSchema.index({ companyId: 1, recordedAt: -1 });

module.exports = mongoose.model("VehicleState", vehicleStateSchema);
module.exports.MOVEMENT_STATES = MOVEMENT_STATES;
