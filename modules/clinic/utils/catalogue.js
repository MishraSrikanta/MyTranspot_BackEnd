/*
 * The starter catalogue a new clinic gets at signup.
 *
 * ================= why a new clinic is not created empty =================
 *
 * A clinic that signs up on a Tuesday evening and finds an empty service list
 * cannot put anything on its public page until somebody sits down and types
 * forty rows. In practice that means the page goes live with nothing on it, or
 * does not go live at all — and the signup that was supposed to take two
 * minutes becomes an afternoon.
 *
 * So the standard list is inserted at typical Indian prices, as ORDINARY
 * EDITABLE RECORDS. Nothing here is a template or a special row: the clinic's
 * next `PUT /sync/profile` replaces the lot with whatever the workbook says.
 * These exist to make the first hour useful, not to be authoritative.
 *
 * ================= a scope note worth reading =================
 *
 * Only SERVICES are seeded here, because services are the only part of the
 * catalogue this server holds — they appear on the public booking page.
 *
 * The spec also asks for a seeded TEST list. Tests never reach this server:
 * they belong to billing and reporting, which are entirely inside the workbook
 * (§1.1 — no entity is owned by both sides). Seeding them here would create a
 * second copy on a server that has no business holding one, and the clinic app
 * would immediately disagree with it. The test catalogue has to be seeded by
 * the app when it creates the workbook, and that is the right place for it.
 *
 * Prices are indicative mid-range figures for a small Indian city, in rupees.
 * Every clinic will change them; the point is that none of them is zero, so a
 * booking page and a first invoice both work before anybody has edited
 * anything.
 */

const STARTER_SERVICES = [
  /* The one every clinic has, and the one most bookings are for. */
  { name: "General Consultation", category: "Consultation", price: 300, durationMinutes: 15,
    description: "Consultation with a general physician." },
  { name: "Follow-up Consultation", category: "Consultation", price: 150, durationMinutes: 10,
    description: "Review visit following an earlier consultation." },
  { name: "Specialist Consultation", category: "Consultation", price: 600, durationMinutes: 20,
    description: "Consultation with a specialist doctor." },

  { name: "Digital X-Ray", category: "Radiology", price: 500, durationMinutes: 15,
    description: "Digital radiography, single view." },
  { name: "Ultrasound (Abdomen)", category: "Radiology", price: 1200, durationMinutes: 30,
    description: "Ultrasound scan of the abdomen and pelvis." },
  { name: "ECG", category: "Cardiology", price: 300, durationMinutes: 15,
    description: "Twelve-lead electrocardiogram." },

  { name: "Health Check-up (Basic)", category: "Packages", price: 1500, durationMinutes: 45,
    description: "Routine screening package including basic blood work." },
  { name: "Health Check-up (Comprehensive)", category: "Packages", price: 3500, durationMinutes: 90,
    description: "Extended screening package with consultation." },

  { name: "Vaccination", category: "Procedures", price: 500, durationMinutes: 10,
    description: "Administration of a vaccine. Price varies by vaccine." },
  { name: "Dressing / Minor Procedure", category: "Procedures", price: 250, durationMinutes: 15,
    description: "Wound dressing and minor outpatient procedures." },
];

/*
 * Build the seeded rows.
 *
 * The `clientId` is prefixed "seed-" and is a real, stable id rather than a
 * placeholder: the clinic app matches published rows on it, so a seeded service
 * the clinic keeps goes on being the same row across every republish instead of
 * being deleted and recreated with a new identity.
 */
function starterServices() {
  return STARTER_SERVICES.map((service, index) => ({
    clientId: `seed-svc-${String(index + 1).padStart(2, "0")}`,
    name: service.name,
    category: service.category,
    description: service.description,
    price: service.price,
    durationMinutes: service.durationMinutes,
    /*
     * Visible on the public page from the first minute. A clinic that does not
     * want a service advertised switches it off in Settings — which is a
     * decision they can make, whereas an invisible-by-default catalogue is a
     * blank page they have to debug.
     */
    isPubliclyVisible: true,
  }));
}

module.exports = { starterServices, STARTER_SERVICES };
