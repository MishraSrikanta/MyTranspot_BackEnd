const express = require("express");

const { errors, handler } = require("../../../utils/apiError");
const { requireClinicKey } = require("../../../middleware/clinicKey");
const { syncRateLimit } = require("../../../middleware/rateLimit");
const gcs = require("../utils/gcs");

const router = express.Router();

/*
 * Cloud backup of the clinic's workbook.
 *
 * The clinic's entire database is one .xlsx on one machine at their front desk.
 * That is fast, private and free, and it is also one spilt coffee from total
 * loss. These three endpoints are the answer: a versioned copy in Cloud
 * Storage the clinic can push up, list, and pull back down.
 *
 * Authenticated with the same X-Clinic-Key as /sync, and rate-limited on the
 * same bucket — it is the same installation doing the same kind of work.
 */
router.use(requireClinicKey, syncRateLimit);

/*
 * A deployment without a bucket configured refuses clearly rather than throwing
 * from inside the SDK. "Cloud backup is not set up" is something a clinic can
 * act on; a 500 from a credentials parser is not.
 */
function assertConfigured() {
  if (!gcs.isConfigured()) {
    throw errors.forbidden("Cloud backup is not configured on this deployment.");
  }
}

/* ================= POST /api/v1/backup/upload-url =================
 * Sign a PUT URL. The bytes go browser → Google, never through here.
 *
 * ================= upload and update are the same endpoint =================
 *
 * There is deliberately no separate "update" route. GCS object versioning means
 * a PUT to an existing path creates a new version rather than destroying the
 * old one, so updating IS uploading again. Two endpoints doing one thing is how
 * one of them ends up not versioning — and the one that does not is always the
 * one in use on the day somebody needs a restore.
 */
router.post(
  "/upload-url",
  handler(async (req, res) => {
    assertConfigured();
    const signed = await gcs.signUpload(String(req.clinic._id));
    return res.json(signed);
  })
);

/* ================= GET /api/v1/backup/versions ================= */
router.get(
  "/versions",
  handler(async (req, res) => {
    /*
     * An empty list rather than an error when backup is not configured. This is
     * the endpoint a settings screen calls on load to decide whether to show
     * the panel at all, and answering 403 there would put a red banner in front
     * of a clinic for a feature they have not asked for.
     */
    if (!gcs.isConfigured()) return res.json({ versions: [], configured: false });

    const versions = await gcs.listVersions(String(req.clinic._id));
    /* Fifty is well past the lifecycle rule's thirty, so the cap never hides a
     * version that still exists. */
    return res.json({ versions: versions.slice(0, 50), configured: true });
  })
);

/* ================= POST /api/v1/backup/download-url =================
 * A signed GET for one version.
 *
 * POST rather than GET, and that is not a REST slip. The signed URL in the
 * RESPONSE is a bearer credential for the clinic's complete patient history,
 * and a GET request's URL — with the version in the query string — lands in
 * browser history, proxy logs and any analytics the page happens to carry. A
 * POST body does not.
 */
router.post(
  "/download-url",
  handler(async (req, res) => {
    assertConfigured();

    /*
     * A generation is a numeric id Google assigns. Validated as digits rather
     * than passed through, so a caller cannot inject arbitrary query
     * parameters into the signed URL this server is about to sign for them.
     */
    const raw = req.body?.version;
    let generation = null;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      generation = String(raw).trim();
      if (!/^\d{1,32}$/.test(generation)) {
        throw errors.validation("That backup version is not valid.", {
          version: "must be a version id from the versions list",
        });
      }
    }

    const signed = await gcs.signDownload(String(req.clinic._id), generation);
    return res.json(signed);
  })
);

module.exports = router;
