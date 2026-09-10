/*
 * The single error shape for everything under /api/v1 — trips, location pings
 * and patient bookings alike. One envelope means a client handles failures in
 * one place:
 *
 *   { "error": { "code": "SLOT_UNAVAILABLE", "message": "...", "details": null } }
 *
 * `code` is stable and machine-readable; `message` is shown to the user, so it
 * is written in plain language. `details` carries a field-level map for
 * validation errors and is null otherwise.
 *
 * Both modules share this file. The generic factories at the top are used by
 * everything; the two domain sections below are used by one module each, and
 * are kept apart so it is obvious which is which when a third module arrives.
 */
class ApiError extends Error {
  constructor(status, code, message, details = null, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    /*
     * Extra keys merged into the error object itself, for the contracts that
     * need to say more than a message: a 409 on a bad status change carries the
     * legal next statuses so the UI can grey out the wrong buttons instead of
     * letting the user find out by tapping.
     */
    this.extra = extra;
  }
}

const errors = {
  /* ================= generic ================= */
  validation: (message, details = null) =>
    new ApiError(400, "VALIDATION_FAILED", message, details),
  unauthenticated: (message = "Your session has expired. Please sign in again.") =>
    new ApiError(401, "UNAUTHENTICATED", message),
  /*
   * The same message and status for an unknown identity as for a wrong
   * password, so the endpoint cannot be used to discover which addresses and
   * login IDs are registered.
   *
   * The wording says "sign-in details" rather than "email" because the login
   * field accepts either an email or a clinic login ID — naming one of them
   * would tell a caller which kind the server thought it was looking at, which
   * is a small piece of exactly the enumeration this is avoiding.
   */
  badCredentials: () =>
    new ApiError(401, "UNAUTHENTICATED", "Those sign-in details are incorrect."),
  forbidden: (message = "You do not have permission to do that.") =>
    new ApiError(403, "FORBIDDEN", message),
  /*
   * Distinct from `forbidden` so the UI can tell the two apart: this one means
   * "ask your owner for the Expenses permission", not "you are signed out".
   */
  permissionDenied: (permission) =>
    new ApiError(
      403,
      "PERMISSION_DENIED",
      "Your account does not have access to this section.",
      { permission }
    ),
  subscriptionExpired: () =>
    new ApiError(
      403,
      "SUBSCRIPTION_EXPIRED",
      "Your subscription has ended. Please renew to carry on."
    ),
  planLimit: (message, details = null) =>
    new ApiError(403, "PLAN_LIMIT_REACHED", message, details),

  /* ================= not found =================
   * Every lookup in this API is already scoped by a tenant the caller cannot
   * choose, so a record belonging to somebody else is indistinguishable from
   * one that does not exist. That is deliberate: a 403 would confirm the record
   * is real and let anyone enumerate another business's ids.
   */
  notFound: (message = "That endpoint does not exist.") =>
    new ApiError(404, "NOT_FOUND", message),
  accountNotFound: () =>
    new ApiError(404, "ACCOUNT_NOT_FOUND", "That user no longer exists."),

  duplicate: (message, details = null) =>
    new ApiError(409, "DUPLICATE", message, details),
  emailTaken: () =>
    new ApiError(409, "EMAIL_TAKEN", "That email is already registered."),
  /*
   * Clinic signup is gated by a shared code, because registering publishes a
   * bookable page on the open internet and issues a licence, and there is no
   * email verification in this build to stand in the way of a bot.
   *
   * Its own code rather than a plain 403 so the signup form can put the message
   * against the right field instead of showing a general failure on a form the
   * user filled in correctly apart from one box.
   */
  invalidDeveloperCode: () =>
    new ApiError(403, "INVALID_DEVELOPER_CODE", "That developer code is not correct.", {
      developerCode: "is not correct",
    }),
  /*
   * A trip cannot jump from DRAFT to COMPLETED. The legal next statuses ride
   * along in `extra` so the client can show them rather than guess.
   */
  badTransition: (message, extra = null) =>
    new ApiError(409, "BAD_TRANSITION", message, null, extra),
  /*
   * One vehicle, one live trip. Refusing here is the whole reason a fleet map
   * can be trusted: two open trips on the same lorry means every location ping
   * has to be guessed at.
   */
  resourceBusy: (message, extra = null) =>
    new ApiError(409, "RESOURCE_BUSY", message, null, extra),

  payloadTooLarge: (message, details = null) =>
    new ApiError(413, "PAYLOAD_TOO_LARGE", message, details),
  rateLimited: (message = "Too many requests. Please slow down.") =>
    new ApiError(429, "RATE_LIMITED", message),
  serviceUnavailable: (message = "This service is not configured.") =>
    new ApiError(503, "SERVICE_UNAVAILABLE", message),

  /* ================= transport ================= */
  tripNotFound: () =>
    new ApiError(404, "TRIP_NOT_FOUND", "That trip no longer exists."),
  vehicleNotFound: () =>
    new ApiError(404, "VEHICLE_NOT_FOUND", "That vehicle no longer exists."),
  driverNotFound: () =>
    new ApiError(404, "DRIVER_NOT_FOUND", "That driver no longer exists."),
  customerNotFound: () =>
    new ApiError(404, "CUSTOMER_NOT_FOUND", "That customer no longer exists."),
  expenseNotFound: () =>
    new ApiError(404, "EXPENSE_NOT_FOUND", "That expense no longer exists."),
  estimateNotFound: () =>
    new ApiError(404, "ESTIMATE_NOT_FOUND", "That estimate no longer exists."),
  /*
   * Closing a trip while somebody's fuel bill is still waiting on the
   * accountant would bank a profit figure that is quietly wrong. The pending
   * expenses ride along so the UI can list them.
   */
  pendingApprovals: (message, extra = null) =>
    new ApiError(409, "PENDING_APPROVALS", message, null, extra),

  /* ================= clinic booking =================
   * A short list, because the whole clinic API is nineteen endpoints — against
   * the ninety the first draft of the spec called for. Everything else the
   * clinic product does happens offline in the workbook and never produces an
   * HTTP error at all.
   */
  clinicNotFound: () =>
    new ApiError(404, "CLINIC_NOT_FOUND", "That clinic page could not be found."),
  slotNotFound: () =>
    new ApiError(404, "SLOT_NOT_FOUND", "That appointment time is no longer listed."),
  bookingNotFound: () =>
    new ApiError(404, "BOOKING_NOT_FOUND", "That booking could not be found."),
  appointmentNotFound: () =>
    new ApiError(404, "APPOINTMENT_NOT_FOUND", "That appointment no longer exists."),
  /* Call Next with an empty waiting room. Its own code because it is not a
   * failure the desk did anything about — there is simply nobody there. */
  tokenQueueEmpty: () =>
    new ApiError(409, "TOKEN_QUEUE_EMPTY", "Nobody is waiting."),
  /*
   * The slot filled up between the page being drawn and the patient pressing
   * the button. Its own code rather than a generic conflict, because the client
   * has a specific and useful response: refresh the times and offer the next
   * one, rather than showing an error and losing the patient.
   */
  slotUnavailable: () =>
    new ApiError(
      409,
      "SLOT_UNAVAILABLE",
      "That time has just been taken. Please choose another."
    ),
  /*
   * Booking is not possible at all: the clinic has switched it off, or the time
   * has already passed. Distinct from SLOT_UNAVAILABLE because offering another
   * slot is not the answer — there are none to offer.
   */
  bookingClosed: (message = "Online booking is not available for this clinic.") =>
    new ApiError(409, "BOOKING_CLOSED", message),

  /*
   * An owner reading "all clinics" has no single branch to write into.
   *
   * A 400 rather than a 404 because nothing is missing: the request is
   * well-formed and simply under-specified. The frontend renders an inline
   * clinic picker on this code rather than losing the form, so it is a
   * supported answer and not a failure.
   */
  clinicRequired: (message = "Pick a single clinic first.") =>
    new ApiError(400, "CLINIC_REQUIRED", message, { clinicId: "is required" }),

  /*
   * The slot has no capacity left. Distinct from SLOT_UNAVAILABLE — which the
   * public page gets — because reception's answer is different: they can book
   * off-grid by omitting the slot entirely, which a patient cannot.
   */
  slotFull: () =>
    new ApiError(409, "SLOT_FULL", "That slot is already full."),

  /*
   * Deleting a slot somebody is holding a confirmation for.
   *
   * Refused rather than done, with the count so the UI can say "two patients
   * are booked into this" — because the person clicking almost never knows.
   * ?force=true overrides, and is owner-only and audited.
   */
  slotHasBookings: (count) =>
    new ApiError(
      409,
      "SLOT_HAS_BOOKINGS",
      count === 1
        ? "A patient is booked into this slot."
        : `${count} patients are booked into this slot.`,
      null,
      { bookings: count }
    ),

  /*
   * Lowering capacity below the number of people already in the slot.
   *
   * Its own code because the fix is specific: cancel somebody first, or leave
   * the capacity alone. Silently clamping to the booked count would leave the
   * clinic believing they had reduced it.
   */
  capacityBelowBooked: (booked) =>
    new ApiError(
      409,
      "CAPACITY_BELOW_BOOKED",
      `${booked} ${booked === 1 ? "patient is" : "patients are"} already booked into this slot.`,
      { capacity: `must be at least ${booked}` },
      { booked }
    ),
};

function sendError(res, err) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details === undefined ? null : err.details,
        ...(err.extra || {}),
      },
    });
  }

  /*
   * Mongoose's own failures are translated rather than passed through: a raw
   * ValidationError message names internal paths, and a duplicate-key error is
   * an 11000 with a stack. Neither is something to show a lorry driver or a
   * patient on a phone.
   */
  if (err && err.name === "ValidationError" && err.errors) {
    const details = {};
    for (const [path, e] of Object.entries(err.errors)) details[path] = e.message;
    return sendError(res, errors.validation("Some fields need fixing.", details));
  }
  if (err && err.code === 11000) {
    return sendError(res, errors.duplicate("That record already exists."));
  }
  if (err && err.name === "CastError") {
    return sendError(res, errors.validation("That id is not valid."));
  }

  /* Never leak a stack trace to the client. */
  console.error("[api/v1]", err);
  return res.status(500).json({
    error: {
      code: "SERVER_ERROR",
      message: "Something went wrong on our side. Please try again.",
      details: null,
    },
  });
}

/* Wrap an async handler so a thrown ApiError becomes the right response. */
const handler = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));

module.exports = { ApiError, errors, sendError, handler };
