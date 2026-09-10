const express = require("express");

const CloudConnection = require("../models/CloudConnection");
const audit = require("../../../utils/audit");
const { errors, handler } = require("../../../utils/apiError");
const { parseOptionalText } = require("../../../utils/validate");
const { requireAuth, requireModule } = require("../../../middleware/auth");
const { requireClinicPermission } = require("../../../middleware/clinicScope");
const drive = require("../utils/googleDrive");
const { iso } = require("../utils/serialise");

const router = express.Router();

/*
 * Google Drive — connecting it, and putting the workbook in it.
 *
 * ================= the customer pastes nothing =================
 *
 * No link, no folder id, no file id. They press Connect, approve a Google
 * consent screen, and this backend creates the folder and the file on the first
 * upload and remembers both. Anything else means a support conversation about
 * where a link came from every time somebody sets up a new machine.
 *
 * ================= the callback carries no bearer =================
 *
 * Google calls it, not the browser, so there is no session on that request. The
 * account travels in the OAuth `state` parameter — SIGNED and expiring in ten
 * minutes. An unsigned id there would be an account-takeover hole: anybody
 * could finish a consent flow with somebody else's id in it and attach their
 * own Drive to that practice.
 */

/*
 * A refused connection is not an error the clinic can act on unless it says
 * what is missing. This deployment has Drive switched off, and that is a
 * deployment fact rather than a user mistake.
 */
function assertConfigured() {
  if (!drive.isConfigured()) {
    throw errors.forbidden("Google Drive is not configured on this deployment.");
  }
}

/* ================= GET /api/v1/cloud/google/connect =================
 * Bearer → 302 to Google.
 */
router.get(
  "/google/connect",
  requireAuth,
  requireModule("clinic"),
  requireClinicPermission("settings.manage"),
  handler(async (req, res) => {
    assertConfigured();

    const state = drive.signState({
      accountId: String(req.account._id),
      ownerId: String(req.account.ownerId),
    });

    /*
     * A redirect rather than a URL in a JSON body, so the browser can simply
     * follow it. The frontend opens this in a popup or navigates to it; either
     * works, and neither needs to know Google's URL shape.
     */
    return res.redirect(drive.consentUrl(state));
  })
);

/* ================= GET /api/v1/cloud/google/callback =================
 * Google → 302 back to the app. No bearer; see the header note.
 */
router.get(
  "/google/callback",
  handler(async (req, res) => {
    const appBase = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    /* Where the user lands afterwards, with a result they can see. The app
     * reads these and shows a banner rather than leaving them on a blank page
     * wondering whether it worked. */
    const back = (status, detail) =>
      res.redirect(
        `${appBase}/settings/cloud?google=${status}${detail ? `&detail=${encodeURIComponent(detail)}` : ""}`
      );

    /*
     * The user pressed Cancel on Google's screen. Not an error — a decision —
     * so it goes back quietly rather than as a failure.
     */
    if (req.query.error) return back("cancelled", String(req.query.error));

    const state = drive.verifyState(req.query.state);
    if (!state) {
      /* Expired, tampered with, or replayed. All three get the same answer, and
       * none of them says which. */
      return back("failed", "That sign-in link has expired. Please try again.");
    }
    if (!req.query.code) return back("failed", "Google did not return a code.");

    try {
      const tokens = await drive.exchangeCode(String(req.query.code));

      /*
       * No refresh token means a re-consent Google decided was unnecessary, and
       * it leaves the connection dead in an hour with nothing to renew from.
       * Caught here, because the alternative is a connection that appears to
       * work today and has silently stopped by tomorrow.
       */
      if (!tokens.refresh_token) {
        return back(
          "failed",
          "Google did not return a refresh token. Remove MyClinic from your Google account permissions and connect again."
        );
      }

      let email = "";
      try {
        const info = await drive.userInfo(tokens.access_token);
        email = info.email || "";
      } catch (err) {
        /* Cosmetic. The connection works without knowing which address approved
         * it; the settings screen just cannot name it. */
      }

      await CloudConnection.findOneAndUpdate(
        { ownerId: state.ownerId, clinicId: null },
        {
          $set: {
            provider: "google-drive",
            googleEmail: email,
            refreshTokenEnc: CloudConnection.encryptSecret(tokens.refresh_token),
            accessToken: tokens.access_token,
            expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
            lastError: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      return back("connected");
    } catch (err) {
      return back("failed", err.message);
    }
  })
);

/* ================= GET /api/v1/cloud/google/status ================= */
router.get(
  "/google/status",
  requireAuth,
  requireModule("clinic"),
  handler(async (req, res) => {
    const connection = await CloudConnection.findOne({
      ownerId: req.account.ownerId,
      clinicId: null,
    });

    /*
     * No token, encrypted or otherwise, appears in this response. It is the
     * screen a clinic opens to check on the connection, and the answer to
     * "is it working?" needs an email address and a timestamp — never a
     * credential.
     */
    return res.json({
      configured: drive.isConfigured(),
      connected: !!connection,
      email: connection ? connection.googleEmail : null,
      folderId: connection ? connection.folderId : null,
      fileId: connection ? connection.fileId : null,
      lastSyncAt: connection ? iso(connection.lastSyncAt) : null,
      lastError: connection ? connection.lastError : null,
    });
  })
);

/* ================= DELETE /api/v1/cloud/google/disconnect ================= */
router.delete(
  "/google/disconnect",
  requireAuth,
  requireModule("clinic"),
  requireClinicPermission("settings.manage"),
  handler(async (req, res) => {
    const connection = await CloudConnection.findOne({
      ownerId: req.account.ownerId,
      clinicId: null,
    }).select("+refreshTokenEnc");

    if (!connection) return res.json({ disconnected: true });

    /*
     * Revoked at Google FIRST, then forgotten here.
     *
     * Deleting the row alone would leave a live grant the customer can see in
     * their own Google account and this product cannot — which is exactly the
     * situation Disconnect exists to end. A revocation failure does not stop the
     * row going: a stale grant is bad, but a row we cannot delete is worse,
     * because it makes reconnecting impossible.
     */
    try {
      const refreshToken = CloudConnection.decryptSecret(connection.refreshTokenEnc);
      if (refreshToken) await drive.revoke(refreshToken);
    } catch (err) {
      console.error("[cloud] revoke failed", err.message);
    }

    await CloudConnection.deleteOne({ _id: connection._id });

    audit.record(req, {
      action: "cloud.disconnect",
      entityType: "cloud",
      entityLabel: connection.googleEmail || "google-drive",
    });

    return res.json({ disconnected: true });
  })
);

/* ================= POST /api/v1/cloud/file/upload =================
 * The workbook itself.
 */
router.post(
  "/file/upload",
  requireAuth,
  requireModule("clinic"),
  requireClinicPermission("settings.manage"),
  /*
   * Raw bytes rather than multipart form data.
   *
   * The client has one file and no fields to go with it, so a multipart parser
   * would be a dependency and a temporary file for no gain. The limit is well
   * above a large practice's workbook — twenty thousand appointments is around
   * 6 MB — and below anything that would put a serverless invocation at risk.
   */
  express.raw({ type: "*/*", limit: "25mb" }),
  handler(async (req, res) => {
    assertConfigured();

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw errors.validation("No file was uploaded.", { file: "is required" });
    }

    const { connection, accessToken } = await authorise(req);

    try {
      let file;
      if (connection.fileId) {
        /* Update the file we already own. Never create a second one — see
         * utils/googleDrive.js. */
        file = await drive.updateFile(accessToken, connection.fileId, buffer);
      } else {
        const folderId =
          connection.folderId || (await drive.createFolder(accessToken));
        file = await drive.createFile(accessToken, folderId, buffer);
        connection.folderId = folderId;
        connection.fileId = file.id;
      }

      connection.lastSyncAt = new Date();
      connection.lastError = null;
      await connection.save();

      return res.json({
        fileId: connection.fileId,
        version: file.version || null,
        size: Number(file.size || buffer.length),
        uploadedAt: connection.lastSyncAt.toISOString(),
      });
    } catch (err) {
      /* Recorded on the connection so the settings screen can say why the last
       * backup did not happen, rather than showing a stale "connected". */
      connection.lastError = String(err.message).slice(0, 300);
      await connection.save().catch(() => {});
      throw err;
    }
  })
);

/* ================= GET /api/v1/cloud/file/versions ================= */
router.get(
  "/file/versions",
  requireAuth,
  requireModule("clinic"),
  handler(async (req, res) => {
    if (!drive.isConfigured()) return res.json({ versions: [], configured: false });

    const connection = await CloudConnection.findOne({
      ownerId: req.account.ownerId,
      clinicId: null,
    }).select("+refreshTokenEnc");

    /* Not connected, or connected but nothing uploaded yet. An empty list
     * rather than an error: this is what a settings screen calls on load to
     * decide whether to show the panel at all. */
    if (!connection || !connection.fileId) {
      return res.json({ versions: [], configured: true, connected: !!connection });
    }

    const accessToken = await accessTokenFor(connection);
    const versions = await drive.listRevisions(accessToken, connection.fileId);

    return res.json({ versions, configured: true, connected: true });
  })
);

/* ================= GET /api/v1/cloud/file/download =================
 * 302 to a short-lived Google URL.
 */
router.get(
  "/file/download",
  requireAuth,
  requireModule("clinic"),
  handler(async (req, res) => {
    assertConfigured();

    const { connection, accessToken } = await authorise(req);
    if (!connection.fileId) {
      throw errors.notFound("No backup has been uploaded yet.");
    }

    /*
     * A generation id is Google's own, and it is validated rather than passed
     * through — an unchecked value here would be appended to a URL this server
     * is about to authorise with its own token.
     */
    const version = parseOptionalText(req.query.version, "version", 80);
    if (version && !/^[A-Za-z0-9_-]{1,80}$/.test(version)) {
      throw errors.validation("That backup version is not valid.", {
        version: "must be a version id from the versions list",
      });
    }

    /*
     * The bytes come from Google to the browser, not through this server. The
     * access token is short-lived and goes in the redirect's query string
     * because Drive's `alt=media` accepts it there — which is also why it must
     * be an ACCESS token and never the refresh token.
     */
    const url = drive.downloadUrl(connection.fileId, version || null);
    return res.redirect(`${url}&access_token=${encodeURIComponent(accessToken)}`);
  })
);

/* ================= helpers ================= */

async function authorise(req) {
  const connection = await CloudConnection.findOne({
    ownerId: req.account.ownerId,
    clinicId: null,
  }).select("+refreshTokenEnc +accessToken");

  if (!connection) {
    throw errors.forbidden("Connect Google Drive before backing up.");
  }
  return { connection, accessToken: await accessTokenFor(connection) };
}

/*
 * A live access token, refreshed when the cached one is stale.
 *
 * Refreshed a minute EARLY rather than on expiry: a token that is valid for
 * another two seconds when the check runs is expired by the time a 6 MB upload
 * finishes, and the upload fails on the last byte.
 */
async function accessTokenFor(connection) {
  const stillValid =
    connection.accessToken &&
    connection.expiresAt &&
    new Date(connection.expiresAt).getTime() - 60_000 > Date.now();
  if (stillValid) return connection.accessToken;

  const refreshToken = CloudConnection.decryptSecret(connection.refreshTokenEnc);
  if (!refreshToken) {
    throw errors.forbidden("This Google connection needs to be set up again.");
  }

  const tokens = await drive.refreshAccessToken(refreshToken);
  connection.accessToken = tokens.access_token;
  connection.expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
  await connection.save();

  return connection.accessToken;
}

module.exports = router;
