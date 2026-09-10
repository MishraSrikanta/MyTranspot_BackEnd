/*
 * Every shape this module returns.
 *
 * ================= the rule for the public serialisers =================
 *
 * They are built FIELD BY FIELD. Not spread, not "everything except a
 * blocklist", not a stored document with a couple of keys deleted.
 *
 * The clinic publishes doctor records that carry a personal mobile number and a
 * medical council registration number. A serialiser written as
 * `{ ...doctor, phone: undefined }` publishes both of those the day somebody
 * adds a field to the model — and a public page is indexed by Google within
 * hours. An allowlist cannot fail that way: a field that is not written here
 * does not leave the building, whatever the model grows later.
 *
 * The same rule applies to slots. `capacity` and `booked` are the clinic's
 * commercial information — how full their day is — and the patient needs
 * exactly one number from them: whether there is room.
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);

/* ================= public ================= */

function publicDoctor(doctor) {
  return {
    id: doctor.clientId,
    name: doctor.name,
    specialization: doctor.specialization || "",
    qualification: doctor.qualification || "",
    photoUrl: doctor.photoUrl || null,
    consultationFee: doctor.consultationFee || 0,
  };
}

/*
 * A doctor as a SLOT recorded them.
 *
 * Same shape as `publicDoctor` so the booking page cannot tell which source it
 * got, but read from a slot's snapshot rather than a clinic's embedded record.
 * `photoUrl` is always null: a slot does not carry one, and inventing a field
 * the snapshot has no room for would be worse than its absence.
 */
function publicDoctorFromSlot(snapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    specialization: snapshot.specialization || "",
    qualification: snapshot.qualification || "",
    photoUrl: null,
    consultationFee: snapshot.consultationFee || 0,
  };
}

function publicService(service) {
  return {
    id: service.clientId,
    name: service.name,
    category: service.category || "",
    description: service.description || "",
    price: service.price || 0,
    durationMinutes: service.durationMinutes || 0,
  };
}

/*
 * The clinic's public page.
 *
 * Note what is absent: the API key prefix, the sync timestamps, the internal
 * id, and every doctor and service the clinic marked invisible. The invisible
 * ones are stored — the slots reference them — and filtered here, which is what
 * lets a clinic hide a doctor offline and have it take effect on the next
 * publish without breaking the slots that already point at them.
 */
/*
 * ================= where the doctors come from =================
 *
 * `clinic.doctors` is the embedded list, and in this product it is USUALLY
 * EMPTY. Doctors are records in the practice's own Excel workbook — the server
 * has never seen them and never will — so nothing populates that array.
 *
 * That is why this takes `doctors` as an option. The caller derives them from
 * the denormalised snapshots on the clinic's own future slots, which is the one
 * place a doctor's name provably exists server-side. It is also the more honest
 * list: a doctor with no slots cannot be booked, so a booking portal has no
 * business advertising them.
 *
 * The embedded array is still read when it has anything in it, so a clinic
 * managed from the admin console keeps working.
 */
function publicClinic(clinic, options = {}) {
  const derived = Array.isArray(options.doctors) ? options.doctors : null;
  return {
    name: clinic.name,
    slug: clinic.slug,
    address: clinic.address || "",
    city: clinic.city || "",
    state: clinic.state || "",
    pincode: clinic.pincode || "",
    phone: clinic.phone || "",
    email: clinic.email || "",
    logoUrl: clinic.logoUrl || null,
    openTime: clinic.openTime,
    closeTime: clinic.closeTime,
    workingDays: [...(clinic.workingDays || [])],
    bookingEnabled: clinic.bookingEnabled !== false,
    doctors: (clinic.doctors || []).length
      ? (clinic.doctors || []).filter((d) => d.isPubliclyVisible !== false).map(publicDoctor)
      : derived || [],
    services: (clinic.services || [])
      .filter((s) => s.isPubliclyVisible !== false)
      .map(publicService),
  };
}

/*
 * A bookable time.
 *
 * `available` is a count rather than a boolean because a clinic that books four
 * patients to a fifteen-minute window is ordinary, and "2 left" is worth
 * showing. `capacity` and `booked` are deliberately not here — see the note at
 * the top of this file.
 */
function publicSlot(slot) {
  return {
    id: String(slot._id),
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    available: Math.max(0, (slot.capacity || 0) - (slot.booked || 0)),
  };
}

/*
 * The patient's own booking, as they see it at their publicRef link.
 *
 * Their own details are echoed back — they typed them, and a confirmation page
 * that cannot show the number it will ring is not much of a confirmation — but
 * nothing about the clinic's operations goes with it.
 */
/*
 * v2 spoke of "cancelled_by_patient" as a status of its own, and both the
 * patient's page and the sync feed still do — installations in the field parse
 * that exact string.
 *
 * Internally there is one "cancelled" state plus a `cancelledBy` field (see the
 * Appointment model), because a cancellation behaves identically whoever ended
 * it. The two are reconciled here, at the edge, rather than by storing a second
 * status that half the queries would eventually forget to include.
 */
function wireStatus(row) {
  if (row.status === "cancelled" && row.cancelledBy === "patient") {
    return "cancelled_by_patient";
  }
  return row.status;
}

function publicBooking(booking, clinic, names = {}) {
  return {
    bookingRef: booking.appointmentId,
    publicRef: booking.publicRef,
    date: booking.date,
    time: booking.time,
    status: wireStatus(booking),
    doctorName: names.doctorName || null,
    serviceName: names.serviceName || null,
    clinicName: clinic ? clinic.name : null,
    clinicAddress: clinic ? clinic.address || "" : null,
    clinicPhone: clinic ? clinic.phone || "" : null,
    patient: {
      name: booking.patientName,
      mobile: booking.patientPhone,
      whatsapp: booking.patientWhatsapp || "",
      email: booking.patientEmail || "",
    },
    notes: booking.notes || "",
    createdAt: iso(booking.createdAt),
  };
}

/* ================= slots and their bookings ================= */

/*
 * A booking as reception sees it.
 *
 * `publicRef` is NOT here. It is the patient's own credential for cancelling,
 * and a console list carrying it would put every patient's cancellation link
 * into the browser of anybody who can open the diary. It is returned exactly
 * once, to the person who made the booking, by the booking endpoints.
 */
function booking(row) {
  return {
    ref: row.ref,
    patientName: row.patientName,
    patientMobile: row.patientMobile,
    patientId: row.patientId || null,
    serviceName: row.serviceName || "",
    notes: row.notes || "",
    source: row.source,
    status: row.status,
    tokenNumber: row.tokenNumber || null,
    tokenState: row.tokenState || null,
    bookedAt: iso(row.bookedAt),
    checkedInAt: iso(row.checkedInAt),
    calledAt: iso(row.calledAt),
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    cancelledBy: row.cancelledBy || null,
    cancelReason: row.cancelReason || "",
  };
}

/*
 * A slot, for a signed-in clinic user.
 *
 * `bookings` is included only when the caller may read patient names — a
 * doctor with slots.view but not appointments.view gets the grid and the
 * counts, which is what they asked for.
 */
function slot(row, { bookings: withBookings = false } = {}) {
  const out = {
    id: String(row._id),
    clinicId: String(row.clinicId),
    clinic: {
      name: row.clinic.name,
      code: row.clinic.code || "",
      phone: row.clinic.phone || "",
      address: row.clinic.address || "",
      city: row.clinic.city || "",
      slug: row.clinic.slug || "",
    },
    doctor: {
      id: row.doctor.id,
      name: row.doctor.name,
      specialization: row.doctor.specialization || "",
      qualification: row.doctor.qualification || "",
      consultationFee: row.doctor.consultationFee || 0,
    },
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    capacity: row.capacity,
    booked: row.booked,
    available: row.available,
    isBlocked: !!row.isBlocked,
    blockReason: row.blockReason || "",
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
  if (withBookings) out.bookings = (row.bookings || []).map(booking);
  return out;
}

/*
 * A slot on the patient's booking page.
 *
 * No bookings, no capacity, no internal counts — the patient needs one number,
 * whether there is room. `capacity` and `booked` are the clinic's commercial
 * information: how full their day is.
 */
function publicSlotV4(row) {
  return {
    id: String(row._id),
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    available: row.available,
    doctor: {
      id: row.doctor.id,
      name: row.doctor.name,
      specialization: row.doctor.specialization || "",
      qualification: row.doctor.qualification || "",
      consultationFee: row.doctor.consultationFee || 0,
    },
  };
}

/*
 * The confirmation a patient is handed.
 *
 * Carries `publicRef` — the one moment it is ever returned — because it is the
 * link they cancel with. Everything else is what a person needs in order to
 * turn up: when, who, where, and a number to ring.
 */
function bookingConfirmation(row, slotRow) {
  return {
    ref: row.ref,
    publicRef: row.publicRef,
    date: slotRow.date,
    time: slotRow.startTime,
    endTime: slotRow.endTime,
    clinic: {
      name: slotRow.clinic.name,
      phone: slotRow.clinic.phone || "",
      address: slotRow.clinic.address || "",
      city: slotRow.clinic.city || "",
    },
    doctor: {
      name: slotRow.doctor.name,
      specialization: slotRow.doctor.specialization || "",
    },
    patientName: row.patientName,
    patientMobile: row.patientMobile,
    status: row.status,
    bookedAt: iso(row.bookedAt),
  };
}

/* ================= the console session ================= */

/*
 * A clinic in the switcher. Five fields, because that is what a switcher and a
 * staff-grant tick box need — the rest of a clinic (hours, GSTIN, prefixes)
 * lives in the workbook and this server neither holds nor should return it.
 */
function clinicSummary(clinic) {
  return {
    id: String(clinic._id),
    name: clinic.name,
    code: clinic.code,
    slug: clinic.slug,
    city: clinic.city || "",
    isActive: clinic.isActive !== false,
  };
}

function owner(row) {
  return {
    id: String(row._id),
    name: row.name,
    businessName: row.businessName,
    email: row.email || "",
    phone: row.phone || "",
    retentionDays: row.retentionDays,
    createdAt: iso(row.createdAt),
  };
}

/*
 * What /auth/login, /auth/register and /auth/me all return.
 *
 * One builder rather than three, because the frontend reads the same three keys
 * from all of them — a session that arrives with a nameless owner and an empty
 * clinic switcher is as far as the app gets, and the commonest way to produce
 * one is three endpoints assembling the shape slightly differently.
 */
function session(serialisedAccount, ownerRow, clinics) {
  return {
    module: "clinic",
    account: serialisedAccount,
    owner: ownerRow ? owner(ownerRow) : null,
    /*
     * Every clinic this account may open — the owner's whole practice, or the
     * branches a staff member was granted. It is what populates the clinic
     * switcher, and it comes back WITH the session so the switcher is right
     * before the first screen renders rather than one request later.
     */
    clinics: (clinics || []).map(clinicSummary),
  };
}

/*
 * A staff account as the owner's Users screen sees it.
 *
 * `permissions` is the RESOLVED list, per the standing contract: an empty
 * stored array means "use the role's preset", and returning it raw would show
 * the owner a person with no permissions who in fact has a receptionist's.
 */
function staffAccount(account, resolvedPermissions) {
  return {
    id: String(account._id),
    ownerId: account.ownerId ? String(account.ownerId) : null,
    name: account.name,
    email: account.email,
    loginId: account.loginId || null,
    phone: account.phone || "",
    role: account.role,
    clinicId: account.clinicId ? String(account.clinicId) : null,
    clinicIds: (account.clinicIds || []).map(String),
    permissions: resolvedPermissions,
    isActive: account.isActive !== false,
    lastLoginAt: iso(account.lastLoginAt),
    createdAt: iso(account.createdAt),
  };
}

/* ================= appointments ================= */

/*
 * The diary row.
 *
 * `patientId` is echoed exactly as it was given — an opaque id from the
 * clinic's own workbook — or null for an online booking that nobody has linked
 * yet. The server never invents one; see the model.
 *
 * `publicRef` is deliberately absent. It is the patient's credential for their
 * own booking, and a console list that carried it would put every patient's
 * cancellation link into the browser of anybody who can open the diary.
 */
function appointment(row) {
  return {
    id: String(row._id),
    appointmentId: row.appointmentId,
    clinicId: String(row.clinicId),
    patientId: row.patientId || null,
    patientName: row.patientName,
    patientPhone: row.patientPhone,
    doctorId: row.doctorId || null,
    doctorName: row.doctorName || null,
    serviceId: row.serviceId || null,
    serviceName: row.serviceName || null,
    date: row.date,
    time: row.time,
    slotId: row.slotId || null,
    type: row.type || "consultation",
    status: row.status,
    tokenNumber: row.tokenNumber || null,
    tokenState: row.tokenState || null,
    source: row.source,
    notes: row.notes || "",
    cancelReason: row.cancelReason || "",
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/* ================= sync ================= */

/*
 * A booking as the workbook wants it.
 *
 * Everything is keyed by the CLIENT's ids — the slot, doctor and service ids
 * from the workbook itself — because the app has never seen a server id and
 * should not have to store one. `id` is the exception: it is the handle the
 * acknowledgement is sent back with, and it is opaque to the app.
 */
function syncBooking(row) {
  return {
    id: String(row._id),
    /* v2 called this bookingRef and installations in the field parse that key,
     * so the wire name is kept even though the field is now appointmentId. */
    bookingRef: row.appointmentId,
    slotClientId: row.slotId || "",
    doctorClientId: row.doctorId || "",
    serviceClientId: row.serviceId || "",
    date: row.date,
    time: row.time,
    patient: {
      name: row.patientName,
      mobile: row.patientPhone,
      whatsapp: row.patientWhatsapp || "",
      email: row.patientEmail || "",
    },
    notes: row.notes || "",
    status: wireStatus(row),
    source: row.source || "public",
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/* ================= admin ================= */

/*
 * A clinic for the administration list.
 *
 * `apiKeyPrefix` and never the key: enough to tell which key is installed at a
 * site, useless for signing a request. There is no endpoint anywhere on this
 * API that returns a whole key after the moment it was minted — a key list an
 * administrator can read is a key list an attacker can read.
 */
function adminClinic(clinic) {
  return {
    id: String(clinic._id),
    ownerId: clinic.ownerId ? String(clinic.ownerId) : null,
    name: clinic.name,
    /* The code prefixes the login IDs and every numbered document the clinic
     * issues, so it is what somebody quotes on a support call — more useful in
     * this list than the slug. */
    code: clinic.code,
    slug: clinic.slug,
    /*
     * The clinic's own contact details, all of them.
     *
     * Only `city` used to be here, which was survivable while a clinic's details
     * were simply the practice's copied across at signup and nothing could edit
     * them. Now that both are false, an edit form has to be able to READ what it
     * is about to write: a form that cannot prefill `address` either shows it
     * blank — and blanks it on the next save — or has to guess. Both are worse
     * than sending five more strings.
     */
    phone: clinic.phone || "",
    email: clinic.email || "",
    address: clinic.address || "",
    city: clinic.city || "",
    state: clinic.state || "",
    pincode: clinic.pincode || "",
    timezone: clinic.timezone,
    bookingEnabled: clinic.bookingEnabled !== false,
    isActive: clinic.isActive !== false,
    apiKey: {
      /* Never null-checked into a lie: a clinic with no key yet says so. */
      issued: !!clinic.apiKeyHash,
      prefix: clinic.apiKeyPrefix || "",
      rotatedAt: iso(clinic.apiKeyRotatedAt),
    },
    counts: {
      doctors: (clinic.doctors || []).length,
      services: (clinic.services || []).length,
    },
    lastPublishAt: iso(clinic.lastPublishAt),
    lastSlotPublishAt: iso(clinic.lastSlotPublishAt),
    lastPullAt: iso(clinic.lastPullAt),
    createdAt: iso(clinic.createdAt),
  };
}

module.exports = {
  iso,
  slot,
  booking,
  publicSlotV4,
  bookingConfirmation,
  wireStatus,
  clinicSummary,
  owner,
  session,
  staffAccount,
  appointment,
  publicClinic,
  publicDoctor,
  publicDoctorFromSlot,
  publicService,
  publicSlot,
  publicBooking,
  syncBooking,
  adminClinic,
};
