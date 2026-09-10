const mongoose = require("mongoose");

/*
 * The practice — the top level of the clinic module's tenancy.
 *
 * ================= why there are two levels again =================
 *
 * v2 had one: an account was pinned to a clinic, and that was the whole
 * hierarchy. It was enough while the backend was a booking endpoint nobody
 * signed into.
 *
 * It stopped being enough the moment the console became a real application. A
 * person who runs three diagnostic centres wants one login, one staff list and
 * one consolidated view — and each centre wants its own diary and its own front
 * desk that cannot see the others.
 *
 * Modelling that as three separate accounts means three logins and no
 * consolidated view; modelling it as one flat tenant means a receptionist in
 * Kothrud reading Baner's appointments. So: an Owner is the practice, a Clinic
 * is a branch, and every clinic-module record carries both ids.
 *
 * ================= how little is stored here =================
 *
 * A name, a business name, and contact details. No patients, no billing, no
 * clinical anything — the v2 §1.2 rule still holds in full. What the practice
 * actually does happens in a workbook on its own machines.
 */

const ownerSchema = new mongoose.Schema(
  {
    /* The person who signed up. */
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /*
     * The practice, which is what appears above a clinic switcher and on
     * anything the group issues as a whole. Falls back to the person's name at
     * signup, because a single-clinic practice frequently has no other name and
     * forcing one produces "Dr Mehta Dr Mehta".
     */
    businessName: { type: String, required: true, trim: true, maxlength: 120 },

    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true, maxlength: 20 },

    address: { type: String, default: "", trim: true, maxlength: 300 },
    city: { type: String, default: "", trim: true, maxlength: 80 },
    state: { type: String, default: "", trim: true, maxlength: 80 },

    /*
     * How long finished appointments are kept before the daily retention job
     * removes them. Per practice rather than global, because a clinic that
     * wants a shorter window should be able to have one without a deployment.
     *
     * See modules/clinic/routes/cron.js for why the default is 400 days and not
     * thirty.
     */
    retentionDays: { type: Number, default: 400, min: 30, max: 3650 },

    /* Suspension by the platform, as opposed to anything the practice did.
     * Refuses every login rather than just new work. */
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Owner", ownerSchema);
