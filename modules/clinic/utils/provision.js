const { errors } = require("../../../utils/apiError");
const {
  parseSlug,
  parseText,
  parseOptionalText,
  parsePhone,
  parseBoolean,
  isNil,
} = require("../../../utils/validate");

/*
 * Turning a clinic's name into the identifiers it will live with.
 *
 * All three — code, slug and login ID — are GENERATED and never accepted from
 * the signup request. That is not tidiness. The code prefixes the login ID and
 * every numbered document the clinic issues, so letting a form choose it means
 * two businesses can pick the same one and start handing out the same invoice
 * numbers; and a chosen slug is a chosen public address, which is a way to
 * squat on a competitor's name.
 */

/*
 * "Sunshine Diagnostics" → "SUN". Three letters, because that is what fits on a
 * token slip and in front of an invoice number without anybody minding.
 *
 * Non-letters are stripped first: a clinic called "3D Imaging & Scan" would
 * otherwise produce a code with a digit in the middle, which reads as part of
 * the sequence rather than as the prefix.
 */
function baseCodeFrom(name) {
  const letters = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  if (letters.length >= 3) return letters.slice(0, 3);
  /* A very short name is padded rather than rejected — "Dr K" is a real clinic
   * name and should not fail a signup. */
  return (letters + "XXX").slice(0, 3);
}

/*
 * Find identifiers nothing else on the platform is using.
 *
 * The loop is bounded and the numbering is shared between the code and the slug
 * deliberately: SUN2 and sunshine-diagnostics-2 belong to the same clinic, and
 * letting them drift apart makes support conversations needlessly hard —
 * "clinic SUN4" and "the -7 one" being the same place.
 *
 * `exists` is injected rather than querying here so this stays a pure function
 * that can be reasoned about and tested without a database.
 */
async function allocateIdentifiers(name, exists) {
  const baseCode = baseCodeFrom(name);

  /*
   * The slug falls back to the code when a name produces nothing usable — a
   * clinic named entirely in Devanagari, or one called "&". parseSlug would
   * reject the empty result, and a signup that fails because the business has a
   * non-Latin name is not an acceptable outcome.
   */
  let baseSlug;
  try {
    baseSlug = parseSlug(name);
  } catch (err) {
    baseSlug = parseSlug(`clinic-${baseCode}`);
  }

  for (let n = 1; n <= 200; n += 1) {
    const suffix = n === 1 ? "" : String(n);
    const code = `${baseCode}${suffix}`;
    const slug = suffix ? `${baseSlug}-${suffix}` : baseSlug;

    /* Both have to be free. Taking a free code with a taken slug would leave
     * the pair inconsistent for ever. */
    if (!(await exists({ code, slug }))) return { code, slug };
  }

  /*
   * Two hundred clinics whose names begin with the same three letters. Vanishingly
   * unlikely, and answered with a real error rather than an unbounded loop or a
   * random string nobody can read aloud over a telephone.
   */
  throw new Error(`could not allocate a free code for "${name}"`);
}

/*
 * The clinic's first login: "SUN-01".
 *
 * Numbered from one even though signup only ever creates a single account,
 * because the shape has to survive a second: a clinic that later gets a login
 * for its laboratory desk wants SUN-02, not a differently-shaped identifier
 * that looks like it belongs to something else.
 */
function loginIdFor(code, sequence = 1) {
  return `${String(code).toUpperCase()}-${String(sequence).padStart(2, "0")}`;
}

/*
 * The clinics from the signup form.
 *
 * ================= why this takes objects, not names =================
 *
 * It used to return a list of strings, and `createClinicFor` filled every other
 * field in from the owner: their phone, their email, their city, their state.
 *
 * That is right for a practice with one clinic, where the owner's details ARE
 * the clinic's. It is wrong the moment there are two. A practice registering a
 * Bhubaneswar clinic and a Cuttack clinic got two rows both saying Bhubaneswar,
 * both carrying the same phone number — and until this change nothing in the
 * product could correct them, because there was no endpoint that edited a
 * clinic at all. The wrong city went on the public booking page and stayed
 * there.
 *
 * So each entry may now carry its own details, and the owner's are a FALLBACK
 * rather than the answer. A single-clinic signup behaves exactly as before
 * without sending anything new.
 *
 * A bare string is still accepted, and still means "this name, everything else
 * from the owner" — every client that predates this change keeps working, which
 * matters because the clinic desktop app updates when somebody remembers to let
 * it.
 */
function parseClinicInputs(raw, max = 10) {
  if (isNil(raw)) return [];
  if (!Array.isArray(raw)) {
    throw errors.validation("Clinics must be a list.", { clinics: "must be a list" });
  }

  const clinics = [];
  const seen = new Set();

  raw.forEach((entry, index) => {
    /* The two accepted shapes, normalised to one before anything is validated. */
    const source =
      entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { name: entry };

    const name = String(isNil(source.name) ? "" : source.name).trim();
    if (!name) return; /* a blank row in the form, not an error */

    /* Case-insensitively: "City Clinic" and "city clinic" are one branch typed
     * twice, and creating both gives the practice two identical rows with
     * different codes and two public pages. */
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    /*
     * `clinics[2].phone` rather than `phone`, so a form with four branches can
     * put the message under the field that is actually wrong. One `phone: "is
     * invalid"` against a page showing four phone boxes is a guessing game.
     */
    const at = (field) => `clinics[${index}].${field}`;

    /*
     * ================= absent is not the same as empty =================
     *
     * `undefined` means "not sent — inherit from the owner". `""` means "sent,
     * and deliberately blank", and must NOT inherit.
     *
     * Deliberately NOT `isNil`, which is the shared parser helper and treats a
     * blank string as missing — the right reading almost everywhere else in
     * this codebase, and precisely wrong here. Collapsing the two would send
     * `undefined` downstream, where `createClinicFor`'s careful `??` fallback
     * would then put the owner's details back into a field somebody had just
     * cleared on purpose.
     *
     * That is not hypothetical: it is what this endpoint did until it was
     * measured. A practice clearing a branch's phone number got the practice's
     * own number back, silently, on a public booking page.
     */
    const absent = (v) => v === undefined || v === null;

    clinics.push({
      name: parseText(name, at("name"), { max: 120, label: "Clinic name" }),
      phone: absent(source.phone) ? undefined : parsePhone(source.phone, at("phone")),
      email: absent(source.email) ? undefined : parseOptionalText(source.email, at("email"), 160),
      address: absent(source.address)
        ? undefined
        : parseOptionalText(source.address, at("address"), 300),
      city: absent(source.city) ? undefined : parseOptionalText(source.city, at("city"), 80),
      state: absent(source.state) ? undefined : parseOptionalText(source.state, at("state"), 80),
      timezone: absent(source.timezone)
        ? undefined
        : parseOptionalText(source.timezone, at("timezone"), 60),
      bookingEnabled: absent(source.bookingEnabled)
        ? undefined
        : parseBoolean(source.bookingEnabled, true),
    });
  });

  /*
   * Capped, and the excess is REFUSED rather than silently truncated. Somebody
   * pasting fifteen branches should be told that eleven were not created — not
   * discover it a week later when four clinics are missing.
   */
  if (clinics.length > max) {
    throw errors.validation(
      `You can add up to ${max} clinics at signup. Add the rest from the Clinics screen.`,
      { clinics: `at most ${max} at signup` }
    );
  }

  return clinics;
}

module.exports = { baseCodeFrom, allocateIdentifiers, loginIdFor, parseClinicInputs };
