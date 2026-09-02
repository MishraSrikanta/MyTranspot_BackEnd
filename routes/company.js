const express = require("express");

const Company = require("../models/Company");
const Vehicle = require("../models/Vehicle");
const { errors, handler } = require("../utils/apiError");
const { serialiseCompany } = require("../utils/auth");
const {
  parseText,
  parseOptionalText,
  parsePhone,
  parseInteger,
  parseAmount,
} = require("../utils/validate");
const { requireAuth, requirePermission } = require("../middleware/auth");
const audit = require("../utils/audit");

const {
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} = Company;

const router = express.Router();
router.use(requireAuth);

/* ================= GET /api/v1/company ================= */
router.get(
  "/",
  handler(async (req, res) => res.json({ company: serialiseCompany(req.company) }))
);

/* ================= PUT /api/v1/company ================= */
router.put(
  "/",
  requirePermission("settings.manage"),
  handler(async (req, res) => {
    const company = req.company;
    const before = { name: company.name, gstin: company.gstin, timezone: company.timezone };

    if (req.body.name !== undefined) {
      company.name = parseText(req.body.name, "name", { max: 120, label: "Company name" });
    }
    for (const [field, max] of [
      ["legalName", 160],
      ["gstin", 20],
      ["pan", 15],
      ["address", 400],
      ["city", 80],
      ["state", 80],
      ["timezone", 60],
    ]) {
      if (req.body[field] !== undefined) {
        company[field] = parseOptionalText(req.body[field], field, max);
      }
    }
    if (req.body.phone !== undefined) company.phone = parsePhone(req.body.phone);
    if (req.body.email !== undefined) {
      company.email = parseOptionalText(req.body.email, "email", 160).toLowerCase();
    }

    /*
     * The numbering prefixes are editable while a company is new and stop being
     * a good idea once trips exist — changing TRP to TRIP mid-year leaves an
     * office with two visually different series for the same year and a
     * spreadsheet that no longer sorts. It is allowed rather than blocked
     * because a brand-new customer correcting their prefix on day one is the
     * common case, and the alternative is a support request.
     */
    if (req.body.tripPrefix !== undefined) {
      company.tripPrefix = parseText(req.body.tripPrefix, "tripPrefix", {
        max: 6,
        label: "Trip prefix",
      }).toUpperCase();
    }
    if (req.body.estimatePrefix !== undefined) {
      company.estimatePrefix = parseText(req.body.estimatePrefix, "estimatePrefix", {
        max: 6,
        label: "Estimate prefix",
      }).toUpperCase();
    }

    await company.save();

    const changes = audit.diff(before, company.toObject(), ["name", "gstin", "timezone"]);
    if (changes) {
      audit.record(req, {
        action: "company.updated",
        entityType: "Company",
        entityId: company._id,
        entityLabel: company.name,
        changes,
      });
    }

    return res.json({ company: serialiseCompany(company) });
  })
);

/* ================= GET /api/v1/company/tracking =================
 * The live tracking configuration, as both the console and the driver app read
 * it.
 */
router.get(
  "/tracking",
  handler(async (req, res) => res.json({ tracking: req.company.trackingConfig() }))
);

/* ================= PUT /api/v1/company/tracking =================
 * Change how often driver phones report their position.
 *
 * This is the setting the brief calls for: fifteen minutes by default, and the
 * owner can change it. It is worth being explicit about how the change reaches
 * a phone, because there is no push channel and none is needed:
 *
 *   - the app asks for this configuration when it signs in;
 *   - every location upload comes back with the current configuration attached;
 *   - the app applies whatever it was last told and keeps it across restarts.
 *
 * So a change made in the office takes effect on each handset at its next
 * upload — within one interval for a lorry with signal, and at the moment it
 * reconnects for one without. Nothing is lost while a phone is out of contact,
 * and a driver never has to be talked through a settings screen down a bad
 * mobile line.
 */
router.put(
  "/tracking",
  requirePermission("tracking.manage"),
  handler(async (req, res) => {
    const company = req.company;
    const tracking = company.tracking || {};
    const before = company.trackingConfig();

    if (req.body.intervalSeconds !== undefined) {
      /*
       * The floor is not arbitrary. Below about ten seconds the handset spends
       * more battery on GPS than it can replace from a cab charger, the phone
       * throttles the app in the background anyway, and a three-day trip starts
       * producing tens of thousands of stored points per lorry — which is paid
       * for in the driver's data plan and in query time on every report. An
       * owner who wants "as often as possible" gets the fastest interval that
       * actually survives a full working day.
       */
      tracking.intervalSeconds = parseInteger(req.body.intervalSeconds, "intervalSeconds", {
        min: MIN_INTERVAL_SECONDS,
        max: MAX_INTERVAL_SECONDS,
      });
    }

    if (req.body.idleIntervalSeconds !== undefined) {
      /* Null is meaningful: it means "same as the moving interval". */
      tracking.idleIntervalSeconds =
        req.body.idleIntervalSeconds === null
          ? null
          : parseInteger(req.body.idleIntervalSeconds, "idleIntervalSeconds", {
              min: MIN_INTERVAL_SECONDS,
              max: MAX_INTERVAL_SECONDS,
            });
      /* A parked lorry reporting MORE often than a moving one is always a
       * mistake, and it is the expensive direction to get wrong. */
      if (
        tracking.idleIntervalSeconds &&
        tracking.idleIntervalSeconds < (tracking.intervalSeconds || 900)
      ) {
        throw errors.validation(
          "The idle interval cannot be shorter than the moving interval.",
          { idleIntervalSeconds: "must be at least the moving interval" }
        );
      }
    }

    if (req.body.routeDeviationKm !== undefined) {
      tracking.routeDeviationKm = parseAmount(req.body.routeDeviationKm, "routeDeviationKm", {
        max: 100,
      });
      if (tracking.routeDeviationKm < 0.2) {
        throw errors.validation("The deviation threshold must be at least 0.2 km.", {
          routeDeviationKm: "must be at least 0.2",
        });
      }
    }
    if (req.body.maxAccuracyM !== undefined) {
      tracking.maxAccuracyM = parseInteger(req.body.maxAccuracyM, "maxAccuracyM", {
        min: 20,
        max: 5000,
      });
    }
    if (req.body.minStopMinutes !== undefined) {
      tracking.minStopMinutes = parseInteger(req.body.minStopMinutes, "minStopMinutes", {
        min: 2,
        max: 240,
      });
    }
    if (req.body.maxOfflineBacklogHours !== undefined) {
      tracking.maxOfflineBacklogHours = parseInteger(
        req.body.maxOfflineBacklogHours,
        "maxOfflineBacklogHours",
        { min: 1, max: 720 }
      );
    }
    if (req.body.offlineAfterMissedIntervals !== undefined) {
      tracking.offlineAfterMissedIntervals = parseInteger(
        req.body.offlineAfterMissedIntervals,
        "offlineAfterMissedIntervals",
        { min: 1, max: 20 }
      );
    }

    company.tracking = tracking;
    await company.save();

    audit.record(req, {
      action: "tracking.settings",
      entityType: "Company",
      entityId: company._id,
      entityLabel: company.name,
      changes: audit.diff(before, company.trackingConfig(), [
        "intervalSeconds",
        "idleIntervalSeconds",
        "routeDeviationKm",
        "maxAccuracyM",
      ]),
    });

    const config = company.trackingConfig();
    return res.json({
      tracking: config,
      /* Said in words, because the question the owner will ask next is "has it
       * changed on the lorries yet?" */
      message: `Vehicles will report every ${formatInterval(
        config.intervalSeconds
      )}. Phones pick this up on their next upload, or as soon as they are back online.`,
    });
  })
);

/* ================= PUT /api/v1/company/defaults =================
 * The standing rates the trip form and the estimate builder start from.
 */
router.put(
  "/defaults",
  requirePermission("settings.manage"),
  handler(async (req, res) => {
    const company = req.company;
    const d = company.defaults || {};

    const fields = [
      "gstPercent",
      "dieselRatePerLitre",
      "averageKmPerLitre",
      "driverFeePerTrip",
      "driverFeePerKm",
      "foodAllowancePerDay",
      "nightAllowancePerNight",
      "tollPerKm",
      "targetMarginPercent",
    ];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        d[field] = parseAmount(req.body[field], field, { max: 1e7 });
      }
    }
    if (d.gstPercent > 100) {
      throw errors.validation("GST cannot be more than 100%.", { gstPercent: "must be 0-100" });
    }

    company.defaults = d;
    await company.save();
    return res.json({ defaults: company.defaults });
  })
);

/* ================= PUT /api/v1/company/vehicles/:id/tracking =================
 * A per-vehicle override of the reporting interval.
 *
 * Kept here alongside the company setting rather than on the vehicle routes,
 * because it is the same decision at a different scale and an owner looking for
 * "how often does this lorry report" should find both in one place.
 */
router.put(
  "/vehicles/:id/tracking",
  requirePermission("tracking.manage"),
  handler(async (req, res) => {
    const vehicle = await Vehicle.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!vehicle) throw errors.vehicleNotFound();

    /* Null clears the override and returns the lorry to the fleet setting. */
    vehicle.trackingIntervalSeconds =
      req.body.intervalSeconds === null || req.body.intervalSeconds === undefined
        ? null
        : parseInteger(req.body.intervalSeconds, "intervalSeconds", {
            min: MIN_INTERVAL_SECONDS,
            max: MAX_INTERVAL_SECONDS,
          });

    await vehicle.save();

    const effective =
      vehicle.trackingIntervalSeconds || req.company.trackingConfig().intervalSeconds;
    return res.json({
      vehicleId: String(vehicle._id),
      registrationNumber: vehicle.registrationNumber,
      intervalSeconds: effective,
      source: vehicle.trackingIntervalSeconds ? "vehicle" : "company",
      message: `${vehicle.registrationNumber} will report every ${formatInterval(effective)}.`,
    });
  })
);

function formatInterval(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}

module.exports = router;
