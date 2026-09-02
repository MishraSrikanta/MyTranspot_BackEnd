const TripExpense = require("../models/TripExpense");
const { errors } = require("./apiError");
const {
  parseAmount,
  parseEnum,
  parseDate,
  parseText,
  parseOptionalText,
  parseLatLng,
  isNil,
} = require("./validate");
const { hasPermission } = require("./permissions");
const { recalculateTrip } = require("./tripFinance");

const { EXPENSE_CATEGORIES, PAYMENT_METHODS, PAID_BY } = TripExpense;

/*
 * Booking a cost against a trip.
 *
 * This lives here rather than in routes/expenses.js because two callers now add
 * expenses and they must agree about every one of the rules below — what needs
 * approving, what is safe to retry, when the ledger is frozen. The office route
 * takes a trip id from the body and checks a permission; the driver route
 * (routes/me.js) takes the trip from the driver's own record and checks
 * nothing else, because it can only ever reach one trip. Everything after that
 * point is the same act and is written once.
 */
async function addExpense({ account, company, companyId, trip }, body) {
  /*
   * A closed trip's ledger is frozen. Its profit has been banked onto the
   * lorry, the driver and every report that has been run since; a new expense
   * arriving afterwards would make those figures silently disagree with the
   * trip they came from.
   */
  if (trip.isClosed()) {
    throw errors.badTransition(
      "This trip is closed and its costs are final. Re-open it only if the figures are genuinely wrong."
    );
  }

  const category = parseEnum(body.category, "category", EXPENSE_CATEGORIES, {
    label: "expense category",
  });
  let customCategory = "";
  if (category === "CUSTOM") {
    customCategory = parseText(body.customCategory, "customCategory", {
      max: 60,
      label: "Category name",
    });
  }

  const amount = parseAmount(body.amount, "amount", { required: true, max: 1e8 });
  if (amount <= 0) {
    throw errors.validation("An expense must be more than zero.", {
      amount: "must be greater than 0",
    });
  }

  /*
   * Who is adding it decides whether it needs checking. A driver's roadside
   * claim goes into the queue; so does an entry from anyone without the
   * approve permission. An owner or an accountant, who could approve it in
   * the next click anyway, is not made to.
   */
  const isDriver = !!account.driverId;
  const canApprove = hasPermission(account, "expenses.approve");
  const source = isDriver ? "DRIVER" : account.role === "owner" ? "OWNER" : "SUB_ACCOUNT";
  const needsApproval = isDriver || !canApprove;

  const doc = {
    companyId,
    tripId: trip._id,
    tripNumber: trip.tripNumber,
    vehicleId: trip.vehicleId,
    driverId: trip.driverId,
    category,
    customCategory,
    amount,
    quantity: isNil(body.quantity) ? null : parseAmount(body.quantity, "quantity"),
    unit: parseOptionalText(body.unit, "unit", 20),
    /*
     * When the money was spent, not when the row was keyed in. A driver
     * entering three days of tolls the evening the signal comes back must see
     * them at the plazas where they happened, or the trip timeline says the
     * lorry paid every toll on the Thursday.
     */
    spentAt: parseDate(body.spentAt, "spentAt", { fallback: new Date() }),
    location: parseOptionalText(body.location, "location", 160),
    paidBy: parseEnum(body.paidBy, "paidBy", PAID_BY, { fallback: "DRIVER" }),
    paymentMethod: parseEnum(body.paymentMethod, "paymentMethod", PAYMENT_METHODS, {
      fallback: "CASH",
    }),
    referenceNumber: parseOptionalText(body.referenceNumber, "referenceNumber", 80),
    receiptUrl: parseOptionalText(body.receiptUrl, "receiptUrl", 500),
    notes: parseOptionalText(body.notes, "notes", 1000),
    source,
    addedBy: account._id,
    addedByName: account.name,
    approvalStatus: needsApproval ? "PENDING" : "APPROVED",
    ...(needsApproval
      ? {}
      : { verifiedBy: account._id, verifiedByName: account.name, verifiedAt: new Date() }),
    /* Idempotency for the phone app. See the model for why "add expense" has
     * to be safe to retry. */
    clientKey: isNil(body.clientKey) ? null : parseOptionalText(body.clientKey, "clientKey", 100),
  };

  if (!isNil(body.lat) && !isNil(body.lng)) {
    const { lat, lng } = parseLatLng(body.lat, body.lng);
    doc.lat = lat;
    doc.lng = lng;
  }

  let expense;
  try {
    expense = await TripExpense.create(doc);
  } catch (err) {
    if (err.code === 11000 && doc.clientKey) {
      /*
       * The same entry, sent twice by a phone retrying over a bad line. The
       * existing row is returned rather than an error: from the app's point of
       * view the write succeeded, which is true, and treating it as a failure
       * would make it retry for ever.
       */
      const existing = await TripExpense.findOne({ companyId, clientKey: doc.clientKey });
      if (existing) return { expense: existing, duplicate: true, trip, needsApproval };
    }
    throw err;
  }

  const updated = await recalculateTrip(trip);

  return {
    expense,
    duplicate: false,
    trip: updated,
    needsApproval,
    category,
    amount,
    message: needsApproval
      ? "Saved. It will be added to the trip cost once it is approved."
      : "",
  };
}

module.exports = { addExpense };
