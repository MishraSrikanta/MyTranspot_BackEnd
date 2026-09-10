const mongoose = require("mongoose");

/*
 * One reported position. This is `location_history` from the brief, and it is
 * the highest-volume collection in the system by two orders of magnitude.
 *
 * Everything about its shape follows from that. It is written in batches and
 * read almost never — the live map reads `trip.lastPosition`, not this — so it
 * carries the minimum a track needs and one compound index. Trip history and
 * the distance total are computed from it when a trip closes, and the result is
 * banked on the trip so nobody has to read a hundred thousand points twice.
 *
 * ---- how a fix gets here ----
 *
 * The driver phone samples GPS on the company interval (fifteen minutes by
 * default) whether or not it has signal, and keeps what it samples. When it has
 * a connection it POSTs the backlog to /api/v1/tracking/pings in one batch.
 * That is why `recordedAt` and `receivedAt` are two separate fields and why the
 * ordering that matters is `recordedAt`: a lorry that spent four hours in a
 * dead zone in Chhattisgarh uploads sixteen points at once, and they describe
 * where it was four hours ago, not where it is now. Sorting or drawing by
 * arrival time would put a kink in the map and inflate the distance.
 */

const pingSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      required: true,
      index: true,
    },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: "Vehicle", required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null },

    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    /* As reported by the handset. Kept as sent rather than recomputed, because
     * a phone's own speed reading is usually better than one derived from two
     * coarse fixes fifteen minutes apart. */
    speedKmh: { type: Number, default: 0 },
    headingDeg: { type: Number, default: null },
    accuracyM: { type: Number, default: null },
    altitudeM: { type: Number, default: null },

    /* When the phone took the fix. */
    recordedAt: { type: Date, required: true },
    /* When the server got it. The gap between the two is how long the phone was
     * offline, which is worth being able to see when a driver claims the app
     * was running and the map says otherwise. */
    receivedAt: { type: Date, default: Date.now },

    /* True when this point arrived in a backlog rather than live. Purely
     * diagnostic — it is what tells an owner "the tracker did not fail, the
     * network did". */
    wasOffline: { type: Boolean, default: false },

    /* Battery on the handset, when the app sends it. A track that stops has
     * usually stopped for this reason, and knowing that saves a phone call. */
    batteryPercent: { type: Number, default: null, min: 0, max: 100 },

    /* ================= what the server worked out ================= */
    /* Distance from the previous ACCEPTED fix on this trip. Stored so the trip
     * total is a sum rather than a re-walk of the whole track. */
    distanceFromPrevKm: { type: Number, default: 0 },
    /* How far off the planned route, and which revision of it — a trip whose
     * route was redrawn mid-run must not have its early pings judged against a
     * line that did not exist yet. */
    offRouteKm: { type: Number, default: null },
    routeRevision: { type: Number, default: null },

    /*
     * A fix the server would not count towards distance: a cell-tower guess
     * with a huge accuracy radius, or an impossible jump. It is STORED anyway,
     * with the reason, rather than dropped. A discarded fix is invisible, and a
     * tracker quietly producing rubbish for a fortnight looks exactly like a
     * lorry standing still.
     */
    accepted: { type: Boolean, default: true },
    rejectReason: { type: String, default: null },
  },
  /* No updatedAt: a ping is written once and never edited. */
  { timestamps: { createdAt: true, updatedAt: false } }
);

/*
 * The only index that matters. Every read of this collection is "the track of
 * one trip, in the order it happened" — replaying a trip, or summarising it at
 * close. Sorting by recordedAt rather than _id is the point: an offline backlog
 * inserts points whose ids are newer than their timestamps.
 */
pingSchema.index({ tripId: 1, recordedAt: 1 });
/* Used by the offline-batch dedupe, and to answer "when did this lorry last
 * report" for a vehicle with no open trip. */
pingSchema.index({ vehicleId: 1, recordedAt: -1 });

/*
 * The same fix uploaded twice — a phone that sent a batch, lost signal before
 * the reply, and sent it again — must land once. A vehicle cannot be in two
 * places at one instant, so the vehicle and the fix's own timestamp are enough
 * of a natural key, and it needs nothing from the client to work.
 */
pingSchema.index({ vehicleId: 1, recordedAt: 1 }, { unique: true });

module.exports = mongoose.model("LocationPing", pingSchema);
