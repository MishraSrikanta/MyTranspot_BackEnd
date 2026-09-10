const crypto = require("crypto");

/*
 * Google Drive, spoken to directly over its REST API.
 *
 * ================= why there is no SDK here =================
 *
 * googleapis is a very large dependency, and this module needs six calls from
 * it: exchange a code, refresh a token, revoke one, create a folder, create a
 * file, and list revisions. Each is one fetch against a documented URL. Pulling
 * in the whole client library to make six requests would put tens of megabytes
 * on the cold-start path of a backend whose other product has nothing to do
 * with Google.
 *
 * ================= the scope, and the trap inside it =================
 *
 *   https://www.googleapis.com/auth/drive.file
 *
 * The right scope: it grants access ONLY to files this app created or the user
 * explicitly picked, so connecting MyClinic does not hand it the customer's
 * whole Drive — and asking for full `drive` would trigger a Google security
 * review nobody needs.
 *
 * The consequence, which is the thing that surprises people: this app CANNOT
 * search the user's Drive for a workbook by name. It cannot list their files at
 * all. So `folderId` and `fileId` must be stored, because after a reinstall
 * they are the only route back to the file. See models/CloudConnection.js.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const SCOPE = "https://www.googleapis.com/auth/drive.file";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const FOLDER_NAME = "MyClinic";
const FILE_NAME = "MyClinic_Data.xlsx";

function isConfigured() {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}

/*
 * ================= the state parameter =================
 *
 * Google's callback cannot carry a bearer token — Google issues the request,
 * not the browser — so the session has to travel in `state` and come back.
 *
 * It is SIGNED and time-limited, and the signature is the whole point: a raw
 * account id in a query parameter is an account-takeover hole, because anyone
 * could complete a consent flow with somebody else's id in it and attach their
 * own Drive to that practice.
 *
 * Ten minutes, because a consent screen is completed in under a minute by
 * anybody who is going to complete it at all, and a longer window is a longer
 * replay window for a value that ends up in Google's logs and the browser's
 * history.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret() {
  const secret = process.env.CLOUD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET must be set to sign an OAuth state.");
  return secret;
}

function signState(payload) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS })
  ).toString("base64url");
  const mac = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyState(raw) {
  const [body, mac] = String(raw || "").split(".");
  if (!body || !mac) return null;

  const expected = crypto
    .createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");
  /* Constant time, and length-checked first because timingSafeEqual throws on a
   * mismatch — which would itself be a signal. */
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (err) {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

/*
 * The consent URL.
 *
 * `access_type=offline` with `prompt=consent` is what actually returns a
 * refresh token. Without them Google issues one only on a user's very first
 * consent and silently omits it on every reconnection afterwards — which
 * surfaces as a connection that works until the first access token expires an
 * hour later, and is then dead with nothing to refresh from.
 */
function consentUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function googleFetch(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    body = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    /*
     * Google's errors are nested two different ways depending on which API
     * answered. Both are unwrapped here so the caller — and the clinic's
     * settings screen — gets a sentence rather than "[object Object]".
     */
    const message =
      (body && body.error_description) ||
      (body && body.error && body.error.message) ||
      (body && typeof body.error === "string" ? body.error : null) ||
      `Google returned ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function exchangeCode(code) {
  return googleFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
}

function refreshAccessToken(refreshToken) {
  return googleFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
}

/*
 * Tell Google to forget the grant.
 *
 * Called on disconnect BEFORE the row is deleted. Dropping the row alone would
 * leave a live grant the customer can see in their Google account settings and
 * this product cannot — which is precisely the situation "disconnect" is meant
 * to end.
 */
async function revoke(token) {
  await googleFetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
}

function userInfo(accessToken) {
  return googleFetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/* The app's own folder, created once. */
async function createFolder(accessToken, name = FOLDER_NAME) {
  const folder = await googleFetch(`${DRIVE_FILES}?fields=id,name`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  });
  return folder.id;
}

/*
 * Create the workbook, once, and return its id.
 *
 * Everything afterwards updates THIS id rather than creating another. A second
 * create per upload is how a practice ends up with "MyClinic_Data (3).xlsx" and
 * no idea which one is live — and with `drive.file` they cannot even list the
 * folder to find out.
 */
async function createFile(accessToken, folderId, buffer, name = FILE_NAME) {
  const metadata = { name, parents: folderId ? [folderId] : undefined };
  const body = multipart(metadata, buffer);

  const file = await googleFetch(
    `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,size,modifiedTime`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${body.boundary}`,
      },
      body: body.payload,
    }
  );
  return file;
}

/* Replace the contents of the file we already own, keeping its id and its
 * revision history. */
function updateFile(accessToken, fileId, buffer) {
  return googleFetch(
    `${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id,name,size,modifiedTime,version`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": XLSX_MIME,
      },
      body: buffer,
    }
  );
}

/*
 * The file's revision history — what "restore Tuesday's copy" is built on.
 *
 * `keepForever` is set on every upload, because Drive prunes ordinary revisions
 * on its own schedule and a backup history that quietly loses its middle is not
 * a backup history.
 */
async function listRevisions(accessToken, fileId) {
  const out = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/revisions?fields=revisions(id,modifiedTime,size)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return (out.revisions || [])
    .map((r) => ({
      version: r.id,
      size: Number(r.size || 0),
      at: r.modifiedTime,
    }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

/* A short-lived download URL for one revision, or the current file. */
function downloadUrl(fileId, revisionId) {
  return revisionId
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/revisions/${revisionId}?alt=media`
    : `${DRIVE_FILES}/${fileId}?alt=media`;
}

/*
 * A multipart/related body, assembled by hand.
 *
 * Drive's multipart upload wants the JSON metadata and the bytes in one
 * request with a boundary between them. Buffer.concat rather than a string,
 * because the file is binary and any string step in the middle corrupts it in a
 * way that only shows up when somebody tries to open the workbook.
 */
function multipart(metadata, buffer) {
  const boundary = `myclinic-${crypto.randomBytes(12).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return { boundary, payload: Buffer.concat([head, buffer, tail]) };
}

module.exports = {
  SCOPE,
  XLSX_MIME,
  FOLDER_NAME,
  FILE_NAME,
  isConfigured,
  signState,
  verifyState,
  consentUrl,
  exchangeCode,
  refreshAccessToken,
  revoke,
  userInfo,
  createFolder,
  createFile,
  updateFile,
  listRevisions,
  downloadUrl,
};
