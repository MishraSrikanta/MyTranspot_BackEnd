const mongoose = require("mongoose");
const crypto = require("crypto");

/*
 * A practice's link to its Google Drive.
 *
 * ================= the refresh token is the whole risk =================
 *
 * A Google refresh token does not expire. It is a standing key to the Drive
 * folder holding the clinic's entire patient history, and it sits in this
 * collection until somebody disconnects. A database dump that contains it in
 * plain text is a breach of every connected practice's records — not of this
 * server's data, which is only appointment times, but of theirs.
 *
 * So it is encrypted at rest with AES-256-GCM under a key this application
 * holds and the database does not, and it is NEVER returned by any endpoint.
 * The status endpoint answers "connected, as clinic@gmail.com" and nothing more.
 */

const connectionSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Owner",
      required: true,
      index: true,
    },
    /* Null means the whole practice shares one Drive, which is the common case.
     * A group that wants a separate Drive per branch gets a row each. */
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Clinic",
      default: null,
    },

    provider: { type: String, default: "google-drive" },

    /* Shown in the UI so the clinic can see WHICH Google account is connected —
     * the commonest support question, and answerable without any token. */
    googleEmail: { type: String, default: "", lowercase: true, trim: true },

    /* Ciphertext. See encryptSecret below; never the raw value. */
    refreshTokenEnc: { type: String, default: null, select: false },
    /* Short-lived, so it is cached rather than protected — it is useless within
     * the hour and re-minted from the refresh token on demand. */
    accessToken: { type: String, default: null, select: false },
    expiresAt: { type: Date, default: null },

    /*
     * ================= why these two ids must be stored =================
     *
     * The `drive.file` scope grants access ONLY to files this app created or
     * the user explicitly picked. It cannot list or search the user's Drive.
     *
     * That is the right scope — asking for full `drive` triggers a Google
     * security review nobody needs — but it means there is no way to find the
     * workbook again by name after a reinstall. These ids are the only route
     * back to the file, so losing them loses the connection.
     */
    folderId: { type: String, default: null },
    fileId: { type: String, default: null },

    lastSyncAt: { type: Date, default: null },
    /* The last failure, in plain language, so a clinic whose sync stopped can
     * be told why rather than seeing a stale "connected". */
    lastError: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: true }
);

/* One connection per practice, or per clinic when a group splits them. */
connectionSchema.index({ ownerId: 1, clinicId: 1 }, { unique: true });

/*
 * AES-256-GCM, keyed from CLOUD_ENCRYPTION_KEY.
 *
 * GCM rather than CBC because it authenticates: a ciphertext somebody has
 * tampered with fails to decrypt rather than producing plausible rubbish that
 * gets sent to Google as a token.
 *
 * The key is derived with sha256 so any length of configured secret works —
 * AES needs exactly 32 bytes, and a deployment whose secret happens to be 31
 * characters should not fail at runtime with a buffer-length error.
 */
function encryptionKey() {
  const secret = process.env.CLOUD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "CLOUD_ENCRYPTION_KEY (or JWT_SECRET) must be set before a Drive token can be stored."
    );
  }
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  /* iv:tag:ciphertext, all base64 — self-describing, so rotating to a longer
   * iv later does not need a migration to tell the formats apart. */
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

function decryptSecret(packed) {
  if (!packed) return null;
  const [iv, tag, data] = String(packed).split(":");
  if (!iv || !tag || !data) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = mongoose.model("CloudConnection", connectionSchema);
module.exports.encryptSecret = encryptSecret;
module.exports.decryptSecret = decryptSecret;
