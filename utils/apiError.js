/*
 * The single error shape for everything under /api/v1 — trips, expenses and
 * location pings alike. One envelope means a client handles failures in one
 * place:
 *
 *   { "error": { "code": "TRIP_NOT_FOUND", "message": "...", "details": null } }
 *
 * `code` is stable and machine-readable; `message` is shown to the user, so it
 * is written in plain language. `details` carries a field-level map for
 * validation errors and is null otherwise.
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
     * letting the driver find out by tapping.
     */
    this.extra = extra;
  }
}

const errors = {
  validation: (message, details = null) =>
    new ApiError(400, "VALIDATION_FAILED", message, details),
  unauthenticated: (message = "Your session has expired. Please sign in again.") =>
    new ApiError(401, "UNAUTHENTICATED", message),
  /*
   * The same message and status for an unknown email as for a wrong password,
   * so the endpoint cannot be used to discover which emails are registered.
   */
  badCredentials: () =>
    new ApiError(401, "UNAUTHENTICATED", "Email or password is incorrect."),
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
   * Every lookup in this API is already scoped by companyId, so a record
   * belonging to another company is indistinguishable from one that does not
   * exist. That is deliberate: a 403 would confirm the record is real and let
   * anyone enumerate another transporter's trip numbers.
   */
  notFound: (message = "That endpoint does not exist.") =>
    new ApiError(404, "NOT_FOUND", message),
  accountNotFound: () =>
    new ApiError(404, "ACCOUNT_NOT_FOUND", "That user no longer exists."),
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

  /* ================= conflicts ================= */
  emailTaken: () =>
    new ApiError(409, "EMAIL_TAKEN", "That email is already registered."),
  duplicate: (message, details = null) =>
    new ApiError(409, "DUPLICATE", message, details),
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
  /*
   * Closing a trip while somebody's fuel bill is still waiting on the
   * accountant would bank a profit figure that is quietly wrong. The pending
   * expenses ride along so the UI can list them.
   */
  pendingApprovals: (message, extra = null) =>
    new ApiError(409, "PENDING_APPROVALS", message, null, extra),

  payloadTooLarge: (message, details = null) =>
    new ApiError(413, "PAYLOAD_TOO_LARGE", message, details),
  rateLimited: (message = "Too many requests. Please slow down.") =>
    new ApiError(429, "RATE_LIMITED", message),
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
   * an 11000 with a stack. Neither is something to show a lorry driver.
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
