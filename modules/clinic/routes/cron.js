const express = require("express");

const Slot = require("../models/Slot");
const { handler } = require("../../../utils/apiError");
const { requireCronSecret } = require("../../../middleware/clinicKey");

const router = express.Router();

/*
 * Clearing away the days that have passed.
 *
 * ================= one job now, where there used to be two =================
 *
 * v2 and v3 had an hourly sweep that TRANSITIONED statuses — open slots to
 * expired, live appointments to expired — and a separate job that deleted.
 *
 * Neither is needed any more. A v4 slot has no lifecycle status to advance: it
 * is bookable while `available > 0` and its date is ahead of the clinic's
 * clock, and after that it is simply over. Marking it "expired" would be
 * recording a fact already implied by the date, in a field every query would
 * then have to remember to check.
 *
 * ================= and the deletion happens on its own =================
 *
 * `expiresAt` holds the end of the slot's day in the clinic's timezone plus the
 * practice's retention window, and a TTL index on that field removes the
 * document — taking every booking inside it. No cron to miss, no job to fail
 * quietly.
 *
 * So what is left for this endpoint to do? Two things the TTL cannot.
 *
 * 1. IT COUNTS. Mongo's TTL monitor deletes silently: nothing logged, nothing
 *    emitted. A mechanism that removes patients' names and telephone numbers
 *    without leaving a number behind is indistinguishable from a bug, and the
 *    first anybody would hear of either is a clinic saying their week is
 *    missing.
 *
 * 2. IT IS PROMPT. The TTL monitor runs about once a minute and is explicitly
 *    not a guarantee under load. Sweeping here as well keeps the window in
 *    which an expired slot still exists short and known.
 *
 * Neither is what keeps the API CORRECT. That is the read-time date filter on
 * every public query — see routes/public.js. This keeps the collection tidy and
 * the behaviour observable.
 */
const retention = handler(async (req, res) => {
  const now = new Date();

  /*
   * Counted BEFORE deleting, and grouped by clinic, so the log can say whose
   * data went. "Deleted 412 slots" is a number; "this clinic, 412 slots, 38
   * bookings" is something somebody can answer a question about three months
   * later.
   */
  const due = await Slot.aggregate([
    { $match: { expiresAt: { $lte: now } } },
    {
      $group: {
        _id: "$clinicId",
        slots: { $sum: 1 },
        bookings: { $sum: { $size: { $ifNull: ["$bookings", []] } } },
      },
    },
  ]);

  const result = await Slot.deleteMany({ expiresAt: { $lte: now } });

  const report = due.map((row) => ({
    clinicId: String(row._id),
    slots: row.slots,
    bookings: row.bookings,
  }));
  const bookingsRemoved = report.reduce((n, r) => n + r.bookings, 0);

  /*
   * Logged as well as returned. The response goes to whatever invoked the cron
   * and is then gone; the log is the record that this happened at all.
   */
  console.log(
    `[retention] removed ${result.deletedCount || 0} expired slot(s) carrying ` +
      `${bookingsRemoved} booking(s) across ${report.length} clinic(s)`
  );

  return res.json({
    deleted: result.deletedCount || 0,
    bookingsRemoved,
    clinics: report.length,
    report,
    ranAt: now.toISOString(),
  });
});

router.post("/retention", requireCronSecret, retention);
/*
 * The same job on GET.
 *
 * Vercel's scheduler issues a GET, and most external cron services default to
 * one. Both verbs run behind requireCronSecret, so this is a convenience rather
 * than a second door — a public cron URL would be a public "delete everything
 * expired" button, which is exactly what the secret exists to prevent.
 */
router.get("/retention", requireCronSecret, retention);

module.exports = router;
