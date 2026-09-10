/*
 * Google Cloud Storage — the clinic's workbook backup.
 *
 * ================= the file never passes through this server =================
 *
 * These functions sign URLs. A few hundred bytes leave here; Google carries the
 * megabytes, straight from the browser.
 *
 * That is not a micro-optimisation. A clinic with twenty thousand appointments
 * has a workbook around 6 MB, and proxying it through the API would hit
 * Vercel's 4.5 MB request body limit outright — and everywhere else it would
 * bill the ingress AND the egress to your function for a file you do not want
 * to look at anyway. Signed URLs mean the storage is billed to the bucket and
 * the API stays a control plane.
 *
 * ================= the client is cached ================= *
 * Same reasoning as db.js: on a serverless platform the module may be evaluated
 * again on a cold start and several invocations share a container. Building a
 * Storage client per request re-parses the service-account key and
 * re-negotiates auth on every call.
 */

const cache = globalThis.__myclinicGcs || {};
globalThis.__myclinicGcs = cache;

/*
 * The SDK is required lazily, inside the function that needs it.
 *
 * @google-cloud/storage is a large dependency that most deployments of this
 * backend will never touch — the transport module has no use for it, and a
 * clinic that has not configured a bucket never reaches this code. Requiring it
 * at the top would put it on the cold-start path of every request in both
 * products, and would turn "backup is not configured" into a crash at boot on
 * any deployment that has not installed it.
 */
function storage() {
  if (cache.client) return cache.client;

  // eslint-disable-next-line global-require
  const { Storage } = require("@google-cloud/storage");

  cache.client = new Storage({
    projectId: process.env.GCP_PROJECT_ID,
    credentials: {
      client_email: process.env.GCP_CLIENT_EMAIL,
      /*
       * The private key arrives from the environment with literal backslash-n
       * rather than newlines — every hosting dashboard does this, because their
       * config UI stores a single-line string. Without the replace, signing
       * fails with "error:0909006C:PEM routines:get_name:no start line", which
       * names nothing about the actual problem and has cost people afternoons.
       */
      private_key: String(process.env.GCP_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
  });
  return cache.client;
}

function bucket() {
  return storage().bucket(process.env.GCS_BUCKET);
}

/* Whether this deployment can do backups at all. Checked by the routes so a
 * missing bucket is a clear refusal rather than an exception from the SDK. */
function isConfigured() {
  return !!(
    process.env.GCS_BUCKET &&
    process.env.GCP_PROJECT_ID &&
    process.env.GCP_CLIENT_EMAIL &&
    process.env.GCP_PRIVATE_KEY
  );
}

/*
 * One object per clinic, at a STABLE path with no timestamp in it.
 *
 * The history lives in GCS object versioning, not in the file name. A new name
 * per upload would defeat versioning entirely: every upload would be a distinct
 * object, the lifecycle rules below would never fire, and pruning old backups
 * would become a job somebody has to write and remember to run.
 */
function objectPath(clinicId) {
  return `clinics/${clinicId}/MyClinic.xlsx`;
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* Fifteen minutes: long enough for a slow clinic connection to push 6 MB, short
 * enough that a URL captured from a log is not a standing write credential. */
const URL_TTL_MS = 15 * 60 * 1000;
const URL_TTL_SECONDS = URL_TTL_MS / 1000;

/*
 * A signed URL the browser can PUT the workbook to.
 *
 * `contentType` is part of the SIGNATURE, which is the detail that catches
 * people: the browser must send exactly this Content-Type header or Google
 * rejects the upload with a 403 whose body is XML that a fetch caller never
 * looks at. It is returned alongside the URL so the client has no reason to
 * guess.
 */
async function signUpload(clinicId) {
  const file = bucket().file(objectPath(clinicId));
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + URL_TTL_MS,
    contentType: XLSX_MIME,
  });
  return {
    uploadUrl: url,
    objectPath: objectPath(clinicId),
    contentType: XLSX_MIME,
    expiresIn: URL_TTL_SECONDS,
  };
}

/*
 * A signed URL for reading one version back.
 *
 * Pinning the generation is what makes "restore Tuesday's copy" work at all.
 * Omitted, Google serves whatever is current — which is the version the clinic
 * is trying to recover FROM.
 */
async function signDownload(clinicId, generation) {
  const file = bucket().file(objectPath(clinicId));
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + URL_TTL_MS,
    ...(generation ? { queryParams: { generation: String(generation) } } : {}),
  });
  return { downloadUrl: url, expiresIn: URL_TTL_SECONDS };
}

/*
 * Every stored version, newest first.
 *
 * `versions: true` is the whole point of this call. Without it the API returns
 * one row — the current object — and the version list is silently always length
 * one, which looks like working code right up until somebody needs to restore.
 */
async function listVersions(clinicId) {
  const [files] = await bucket().getFiles({
    prefix: objectPath(clinicId),
    versions: true,
  });

  return files
    .map((f) => ({
      version: String(f.metadata.generation),
      size: Number(f.metadata.size || 0),
      uploadedAt: f.metadata.timeCreated,
      /* A version with a deletion time is a superseded one; the live object is
       * the one without. */
      isCurrent: !f.metadata.timeDeleted,
    }))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

module.exports = {
  isConfigured,
  signUpload,
  signDownload,
  listVersions,
  objectPath,
  XLSX_MIME,
};
