const Trip = require("../models/Trip");
const Vehicle = require("../models/Vehicle");
const Driver = require("../models/Driver");
const LocationPing = require("../models/LocationPing");
const TripExpense = require("../models/TripExpense");
const { errors } = require("../../../utils/apiError");
const { round, summarisePath, simplifyPath } = require("./geo");
const { recalculateTrip } = require("./tripFinance");

const { TRIP_FLOW, TRIP_ACTIVE } = Trip;

/*
 * The trip workflow: which status may follow which, what has to be true first,
 * and what else in the system moves when it does.
 *
 * Every status change in the product goes through `changeStatus` below. That is
 * the point of the file — if starting a trip also has to mark a lorry busy, and
 * closing one has to free it, bank the distance and settle the driver's fee,
 * then those things must happen in one place or they will eventually happen in
 * none of them. A lorry left marked ON_TRIP after its trip closed is invisible
 * to the dispatcher for ever.
 */

/*
 * The legal moves.
 *
 * Forward one step along the main line, and backward one step only while the
 * trip is still in the yard. Once a lorry is IN_TRANSIT there is no reversing:
 * un-starting a trip that has already collected fuel bills and GPS points would
 * leave a track and a ledger attached to a trip that claims never to have left.
 * A trip started by mistake is CANCELLED, which is honest and leaves the
 * evidence in place.
 */
const EXTRA_TRANSITIONS = {
  /* Skipping READY is normal for an owner keying in a trip that already left —
   * plenty of trips are entered into the system after the fact. */
  ASSIGNED: ["IN_TRANSIT"],
  /* Some yards do not use ARRIVED; the driver simply reports delivered. */
  IN_TRANSIT: ["DELIVERED"],
};

function legalNext(status) {
  const next = new Set();

  const i = TRIP_FLOW.indexOf(status);
  if (i >= 0) {
    if (i + 1 < TRIP_FLOW.length) next.add(TRIP_FLOW[i + 1]);
    /* Backwards, but only in the yard. */
    if (i > 0 && TRIP_FLOW.indexOf(status) <= TRIP_FLOW.indexOf("READY")) {
      next.add(TRIP_FLOW[i - 1]);
    }
    for (const extra of EXTRA_TRANSITIONS[status] || []) next.add(extra);
  }

  /* Exceptions can interrupt anything that is still running. */
  if (TRIP_ACTIVE.includes(status) || status === "PLANNED" || status === "DRAFT") {
    next.add("CANCELLED");
  }
  if (status !== "ON_HOLD" && status !== "DELAYED" && TRIP_ACTIVE.includes(status)) {
    next.add("ON_HOLD");
    next.add("DELAYED");
  }
  /* Coming back from an exception is handled by `resume`, which returns the
   * trip to wherever it was — see below. */
  if (status === "ON_HOLD" || status === "DELAYED") {
    next.add("RESUME");
    next.add("CANCELLED");
  }

  return [...next];
}

/*
 * What must be true before a status may be entered. These are the guards that
 * stop the data going quietly wrong; each one exists because the alternative
 * produces a record nobody can interpret later.
 */
const GUARDS = {
  ASSIGNED: (trip) => {
    if (!trip.vehicleId || !trip.driverId) {
      throw errors.validation(
        "Assign a vehicle and a driver before moving the trip to Assigned.",
        { vehicleId: "is required", driverId: "is required" }
      );
    }
  },
  IN_TRANSIT: (trip) => {
    if (!trip.vehicleId || !trip.driverId) {
      throw errors.validation("A trip cannot start without a vehicle and a driver.");
    }
    /*
     * A trip with no price can be started. That is deliberate: rate
     * negotiations run past loading all the time, and a system that refuses to
     * let the lorry leave until the paperwork is perfect gets bypassed, which
     * costs the owner the tracking as well as the paperwork. The dashboard
     * flags unpriced running trips instead.
     */
  },
  COMPLETED: (trip) => {
    if (trip.status !== "DELIVERED") {
      throw errors.badTransition("Only a delivered trip can be closed.", {
        allowed: legalNext(trip.status),
      });
    }
  },
};

/*
 * Move a trip to a new status and carry out everything that goes with it.
 *
 * `force` on the close step skips the pending-expense check, for the owner who
 * genuinely wants to close a trip and write off a claim nobody will ever
 * produce a receipt for. It is a deliberate override, never a default: closing
 * with unapproved expenses banks a profit figure that will change the next time
 * anybody touches that queue.
 */
async function changeStatus(trip, nextStatus, { account, note = "", force = false } = {}) {
  const from = trip.status;

  if (from === nextStatus) return trip;
  if (trip.isClosed()) {
    throw errors.badTransition(
      from === "CANCELLED"
        ? "This trip was cancelled and cannot be changed."
        : "This trip is closed. Its figures are final.",
      { allowed: [] }
    );
  }

  /* Coming off an exception goes back to wherever the trip actually was. */
  if (nextStatus === "RESUME") {
    const resumeTo = trip.statusBeforeException || "ASSIGNED";
    trip.statusBeforeException = null;
    return applyStatus(trip, resumeTo, { account, note: note || "Resumed" });
  }

  if (!legalNext(from).includes(nextStatus)) {
    throw errors.badTransition(
      `A trip cannot go from ${from} to ${nextStatus}.`,
      { from, allowed: legalNext(from) }
    );
  }

  if (GUARDS[nextStatus]) GUARDS[nextStatus](trip);

  if (nextStatus === "COMPLETED" && !force) {
    /* Recount first: the cached figure may predate the last approval. */
    await recalculateTrip(trip);
    if ((trip.actuals?.pendingCount || 0) > 0) {
      throw errors.pendingApprovals(
        `${trip.actuals.pendingCount} expense(s) on this trip are still waiting for approval. Approve or reject them first, or close with the override.`,
        {
          pendingCount: trip.actuals.pendingCount,
          pendingCost: trip.actuals.pendingCost,
        }
      );
    }
  }

  /* Remember where we were, so RESUME has somewhere to go back to. */
  if ((nextStatus === "ON_HOLD" || nextStatus === "DELAYED") && TRIP_FLOW.includes(from)) {
    trip.statusBeforeException = from;
  }

  return applyStatus(trip, nextStatus, { account, note });
}

async function applyStatus(trip, nextStatus, { account, note }) {
  const now = new Date();
  trip.status = nextStatus;
  trip.statusHistory.push({
    status: nextStatus,
    at: now,
    by: account?._id || null,
    byName: account?.name || "",
    note: note || "",
  });

  if (nextStatus === "IN_TRANSIT" && !trip.startedAt) {
    trip.startedAt = now;
    /*
     * The estimate is frozen the moment the wheels turn. An estimate that can
     * still be edited afterwards is not a budget, it is a way of making every
     * trip look like it came in on target — and it would make the whole
     * planned-versus-actual report worthless.
     */
    if (!trip.estimate.lockedAt) trip.estimate.lockedAt = now;
  }
  if (nextStatus === "ARRIVED" && !trip.arrivedAt) trip.arrivedAt = now;
  if (nextStatus === "DELIVERED" && !trip.deliveredAt) trip.deliveredAt = now;

  if (nextStatus === "COMPLETED" || nextStatus === "CANCELLED") {
    trip.closedAt = now;
    trip.closedBy = account?._id || null;
  }

  await trip.save();

  /* ---- the rest of the system follows the trip ---- */
  if (nextStatus === "ASSIGNED" || nextStatus === "IN_TRANSIT") {
    await occupy(trip);
  }
  if (nextStatus === "COMPLETED") {
    /*
     * Order matters here and is the reason closing is not just a status write.
     * The journey summary produces the distance, and the ledger recount
     * produces the cost; both have to be banked on the trip BEFORE `release`
     * copies them onto the lorry and the driver. Releasing first would add
     * zero kilometres and zero cost to the fleet totals, permanently.
     */
    await summariseJourney(trip);
    await recalculateTrip(trip);
  }
  if (nextStatus === "COMPLETED" || nextStatus === "CANCELLED") {
    await release(trip, { bankTotals: nextStatus === "COMPLETED" });
  }

  return trip;
}

/* Mark the lorry and the driver as being on this trip. */
async function occupy(trip) {
  if (trip.vehicleId) {
    await Vehicle.updateOne(
      { _id: trip.vehicleId, companyId: trip.companyId },
      { $set: { status: "ON_TRIP", currentTripId: trip._id, currentDriverId: trip.driverId } }
    );
  }
  if (trip.driverId) {
    await Driver.updateOne(
      { _id: trip.driverId, companyId: trip.companyId },
      { $set: { status: "ON_TRIP", currentTripId: trip._id, assignedVehicleId: trip.vehicleId } }
    );
  }
}

/*
 * Move the holds after the lorry or the driver on a trip has been swapped.
 *
 * A relay driver taking over at Nashik, or a breakdown putting a different
 * lorry on the load, is ordinary transport work — but it is also the one edit
 * that can quietly corrupt the fleet's own state. `occupy` marks a lorry
 * ON_TRIP and points it at the trip; nothing had been undoing that when the
 * trip was pointed at a DIFFERENT lorry. The lorry that was swapped out stayed
 * ON_TRIP for ever, invisible to every dispatcher, and the lorry swapped in was
 * never marked at all, so it could be double-booked onto a second trip.
 *
 * Only trips that are actually HOLDING their resources are touched. A trip
 * still in the yard holds nothing yet — the move to ASSIGNED is what occupies —
 * so reassigning a PLANNED trip must not free anything.
 *
 * The old vehicle is only freed if it is still pointed at THIS trip. If it has
 * already been given to another load, that trip's claim wins: releasing it here
 * would strand the newer trip with a lorry marked available.
 */
async function reassign(trip, previous = {}) {
  if (!TRIP_ACTIVE.includes(trip.status)) return;

  const changed = (before, after) => String(before || "") !== String(after || "");

  if (previous.vehicleId && changed(previous.vehicleId, trip.vehicleId)) {
    await Vehicle.updateOne(
      { _id: previous.vehicleId, companyId: trip.companyId, currentTripId: trip._id },
      { $set: { status: "AVAILABLE", currentTripId: null, currentDriverId: null } }
    );
  }
  if (previous.driverId && changed(previous.driverId, trip.driverId)) {
    await Driver.updateOne(
      { _id: previous.driverId, companyId: trip.companyId, currentTripId: trip._id },
      { $set: { status: "AVAILABLE", currentTripId: null } }
    );
  }

  /* Claim whatever is on the trip now. Idempotent, so an edit that changed the
   * driver but not the lorry simply re-states what was already true. */
  await occupy(trip);
}

/*
 * Free the lorry and the driver, and bank the trip's numbers onto them.
 *
 * The totals are advanced here, once, rather than counted on every read of a
 * vehicle or driver profile. The vehicle-profitability table would otherwise
 * aggregate every trip that lorry has ever run, every time somebody opened the
 * fleet list.
 *
 * A CANCELLED trip frees the resources but banks nothing: it earned nothing and
 * its distance is not work done.
 */
async function release(trip, { bankTotals }) {
  if (trip.vehicleId) {
    const update = { $set: { status: "AVAILABLE", currentTripId: null } };
    if (bankTotals) {
      update.$inc = {
        "totals.trips": 1,
        "totals.distanceKm": round(trip.journey?.distanceKm || 0),
        "totals.revenue": round(trip.revenue?.subTotal || 0),
        "totals.cost": round(trip.actuals?.approvedCost || 0),
        odometerKm: round(trip.journey?.distanceKm || 0),
      };
    }
    await Vehicle.updateOne({ _id: trip.vehicleId, companyId: trip.companyId }, update);
  }

  if (trip.driverId) {
    const update = { $set: { status: "AVAILABLE", currentTripId: null } };
    if (bankTotals) {
      /*
       * What the driver earned on this trip is what was actually booked against
       * it as a driver fee, not what the estimate said. Reading it from the
       * ledger means a fee revised on the road is the fee the driver is owed.
       */
      const fees = await TripExpense.aggregate([
        {
          $match: {
            tripId: trip._id,
            category: { $in: ["DRIVER_FEE", "ALLOWANCE"] },
            approvalStatus: "APPROVED",
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      update.$inc = {
        "totals.trips": 1,
        "totals.distanceKm": round(trip.journey?.distanceKm || 0),
        "totals.feesEarned": round(fees[0]?.total || 0),
      };
    }
    await Driver.updateOne({ _id: trip.driverId, companyId: trip.companyId }, update);
  }
}

/*
 * Turn the trip's location history into the summary the owner reads afterwards:
 * total distance, driving time, and where it stopped.
 *
 * Run when the trip is closed, and re-runnable at any time. It reads the full
 * track once, banks the answer on the trip, and stores a thinned version of the
 * line for the map. Everything after that — the driver's per-kilometre fee, the
 * vehicle's lifetime distance, the trip-history screen — reads the banked
 * figure and never touches the ping collection again.
 *
 * Only ACCEPTED fixes count towards distance. A cell-tower guess that put the
 * lorry two kilometres into a field would otherwise add four kilometres to the
 * distance the driver is paid for, twice a day, for the life of the fleet.
 */
async function summariseJourney(trip, { minStopMinutes = 15 } = {}) {
  const pings = await LocationPing.find({ tripId: trip._id, accepted: true })
    .select("lat lng recordedAt")
    .sort({ recordedAt: 1 })
    .lean();

  if (pings.length < 2) {
    /*
     * No usable track. The planned distance is NOT substituted here: an owner
     * looking at a trip with no tracking should see a blank, not a number that
     * looks measured and is not. The trip screen offers the planned figure
     * alongside, clearly labelled as planned.
     */
    trip.journey = {
      ...(trip.journey?.toObject?.() || {}),
      pingCount: pings.length,
      summarisedAt: new Date(),
    };
    await trip.save();
    return trip.journey;
  }

  const summary = summarisePath(pings, { minStopMinutes });

  trip.journey = {
    distanceKm: summary.distanceKm,
    durationMinutes: summary.durationMinutes,
    movingMinutes: summary.movingMinutes,
    stoppedMinutes: summary.stoppedMinutes,
    stopCount: summary.stops.length,
    averageKmh: summary.averageKmh,
    maxKmh: summary.maxKmh,
    pingCount: pings.length,
    /* 50 m tolerance: keeps every turn a lorry actually made, drops the
     * hundreds of near-identical points a motorway produces. */
    simplifiedPath: simplifyPath(
      pings.map((p) => ({ lat: p.lat, lng: p.lng })),
      0.05
    ).map((p) => ({ lat: p.lat, lng: p.lng })),
    summarisedAt: new Date(),
  };

  await trip.save();
  return trip.journey;
}

module.exports = {
  legalNext,
  changeStatus,
  summariseJourney,
  occupy,
  reassign,
  release,
};
