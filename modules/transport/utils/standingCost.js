const Vehicle = require("../models/Vehicle");
const Driver = require("../models/Driver");
const Employee = require("../models/Employee");
const { round } = require("./geo");

/*
 * The money that goes out whether a lorry moves or not.
 *
 * ================= why this file exists =================
 *
 * Every profit figure in this product up to now has been a TRIP profit: what a
 * load earned, minus what was booked against it. That number is genuinely
 * useful and it is not the answer to the question an owner actually loses sleep
 * over, which is "am I making money?"
 *
 * The gap between the two is this file. A fleet of six lorries each turning
 * ₹8,000 a run can still be losing money every month, because none of the
 * following appears in any trip's ledger:
 *
 *   the EMI on each vehicle              ₹45,000 × 6
 *   insurance, permits, fitness, parking
 *   the drivers' monthly salaries
 *   the helpers, the mechanic, the office
 *
 * Those are STANDING costs. They are owed on a month when nothing ran, they
 * cannot be attributed to one load without arbitrary arithmetic, and they are
 * the difference between a business that looks profitable and one that is.
 *
 * ================= how a period is charged =================
 *
 * A monthly figure is pro-rated across the days actually being asked about:
 *
 *   share = monthly × days ÷ 30.44        (30.44 = 365.25 ÷ 12)
 *
 * An average month rather than the length of the specific one, on purpose: it
 * makes a February and a March comparable, which is the whole reason somebody
 * runs the report two months in a row. It is stated on the screen so nobody has
 * to reverse-engineer it out of the total.
 *
 * ================= what is deliberately NOT here =================
 *
 * Food, road allowances and daily wages for time on the road. Those are
 * incurred by a trip, belong to that trip, and are already booked as expenses
 * against it — counting them here as well would charge the owner twice for the
 * same meal.
 */

/* 365.25 ÷ 12 — the average month, so periods of different lengths compare. */
const DAYS_PER_MONTH = 30.4375;

/*
 * How many calendar days a period covers, counting both ends.
 *
 * Both bounds are normalised to the whole local day before measuring, because
 * the two callers disagree about what they pass: the report route hands over an
 * end already pushed to 23:59:59, the payroll route hands over raw midnight.
 * Adding an inclusive +1 to elapsed milliseconds — which is what this used to
 * do — then counted the last day twice for one caller and not at all for the
 * other, and the two screens showing the same month disagreed by a day's worth
 * of EMI. Which is exactly how a report loses an owner's trust.
 */
function daysBetween(from, to) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
}

/*
 * What the fleet and the payroll cost over a period.
 *
 * Returns the whole breakdown rather than a total, because the total on its own
 * invites the question "which of these is it?" and an owner looking at a loss
 * needs to see whether it is the EMIs or the wage bill before they can act.
 */
async function standingCostFor(companyId, { from, to, on = new Date() } = {}) {
  const days = from && to ? daysBetween(from, to) : Math.round(DAYS_PER_MONTH);
  const share = days / DAYS_PER_MONTH;

  const [vehicles, drivers, employees] = await Promise.all([
    Vehicle.find({ companyId, isActive: true }),
    Driver.find({ companyId, isActive: true }).select("name pay"),
    Employee.find({ companyId, isActive: true }).select("name role pay assignedVehicleId"),
  ]);

  const vehicleRows = vehicles
    .map((vehicle) => {
      const monthly = vehicle.fixedMonthlyCost(on);
      const r = vehicle.runningCost || {};
      return {
        vehicleId: String(vehicle._id),
        registrationNumber: vehicle.registrationNumber,
        type: vehicle.type,
        monthly,
        /* Broken out so the report can say WHICH standing cost is the problem.
         * "Your overhead is ₹3.2 lakh" is not actionable; "₹2.7 lakh of it is
         * EMI" is. */
        emi: r.emiPerMonth || 0,
        insurance: r.insurancePerMonth || 0,
        permit: r.permitPerMonth || 0,
        parking: r.parkingPerMonth || 0,
        other: r.otherPerMonth || 0,
        wearPerKm: vehicle.wearPerKm(),
        periodCost: round(monthly * share),
      };
    })
    .filter((row) => row.monthly > 0);

  /*
   * Drivers and other staff, in one list.
   *
   * A driver's monthly salary is a standing cost in exactly the same way a
   * helper's is; the only reason they live in two collections is that one of
   * them drives (see models/Employee.js). The report has no business exposing
   * that split, so it does not.
   */
  const payrollRows = [
    ...drivers.map((driver) => ({
      id: String(driver._id),
      kind: "DRIVER",
      name: driver.name,
      role: "DRIVER",
      monthlySalary: driver.pay?.monthlySalary || 0,
      assignedVehicleId: null,
    })),
    ...employees.map((employee) => ({
      id: String(employee._id),
      kind: "STAFF",
      name: employee.name,
      role: employee.role,
      monthlySalary: employee.pay?.monthlySalary || 0,
      /* A helper who never leaves one lorry is part of what that lorry costs;
       * one attached to nothing is a company overhead. */
      assignedVehicleId: employee.assignedVehicleId ? String(employee.assignedVehicleId) : null,
    })),
  ]
    .filter((row) => row.monthlySalary > 0)
    .map((row) => ({ ...row, periodCost: round(row.monthlySalary * share) }));

  const vehicleFixed = round(vehicleRows.reduce((sum, row) => sum + row.periodCost, 0));
  const payroll = round(payrollRows.reduce((sum, row) => sum + row.periodCost, 0));

  return {
    days,
    /* The multiplier applied to every monthly figure, published so the total is
     * checkable by hand. */
    monthShare: round(share, 3),
    daysPerMonth: DAYS_PER_MONTH,
    vehicles: vehicleRows,
    payrollPeople: payrollRows,
    vehicleFixed,
    payroll,
    total: round(vehicleFixed + payroll),
    /* Per vehicle, including any staff attached to it — what the per-vehicle
     * profit column has to subtract. */
    byVehicle: attributeByVehicle(vehicleRows, payrollRows),
    /* Salaries belonging to nobody's lorry: the office, the mechanic, the
     * floating labour. Spread across the fleet by the caller if it wants to, or
     * shown as overhead. */
    unattributedPayroll: round(
      payrollRows
        .filter((row) => !row.assignedVehicleId)
        .reduce((sum, row) => sum + row.periodCost, 0)
    ),
  };
}

function attributeByVehicle(vehicleRows, payrollRows) {
  const map = new Map();
  for (const row of vehicleRows) {
    map.set(row.vehicleId, {
      vehicleId: row.vehicleId,
      registrationNumber: row.registrationNumber,
      fixed: row.periodCost,
      attributedPayroll: 0,
      total: row.periodCost,
    });
  }
  for (const person of payrollRows) {
    if (!person.assignedVehicleId) continue;
    const entry = map.get(person.assignedVehicleId);
    if (!entry) continue;
    entry.attributedPayroll = round(entry.attributedPayroll + person.periodCost);
    entry.total = round(entry.fixed + entry.attributedPayroll);
  }
  return [...map.values()];
}

/*
 * The per-kilometre and per-day rates a quote should start from for one vehicle
 * and one driver.
 *
 * Assembled here rather than in the estimate route because the same answer is
 * wanted in three places — the quote builder, the trip form and the vehicle
 * screen — and the rules about what falls back to what are the fiddly part:
 * the vehicle's own rate beats the company default, and a zero means "not
 * known" rather than "free".
 */
function ratesFor({ company, vehicle, driver, helpers = [] }) {
  const defaults = company?.defaults || {};

  const kmPerLitre = vehicle?.averageKmPerLitre || defaults.averageKmPerLitre || 0;
  const tollPerKm = vehicle?.runningCost?.tollPerKm || defaults.tollPerKm || 0;
  const runningCostPerKm = vehicle ? vehicle.wearPerKm() : 0;

  const driverPay = driver?.pay || {};
  const driverDayCost = round((driverPay.foodPerDay || 0) + (driverPay.otherPerDay || 0));

  const helperCostPerDay = helpers.length
    ? round(
        helpers.reduce((sum, helper) => sum + helper.costPerDayOnTrip(), 0) / helpers.length
      )
    : 0;

  return {
    kmPerLitre,
    dieselRatePerLitre: defaults.dieselRatePerLitre || 0,
    tollPerKm,
    runningCostPerKm,
    driverFeePerKm: driver?.defaultFeePerKm || defaults.driverFeePerKm || 0,
    driverFeePerTrip: driver?.defaultTripFee || defaults.driverFeePerTrip || 0,
    driverDayCost: driverDayCost || defaults.foodAllowancePerDay || 0,
    foodPerDay: 0,
    nightAllowance: defaults.nightAllowancePerNight || 0,
    helperCount: helpers.length,
    helperCostPerDay,
    targetMarginPercent: defaults.targetMarginPercent ?? 25,
    /*
     * What one kilometre of this lorry costs before anybody is paid: diesel plus
     * wear plus toll. The single most useful number on the vehicle screen, and
     * the one an owner quotes from over the phone.
     */
    costPerKm: round(
      (kmPerLitre > 0 ? (defaults.dieselRatePerLitre || 0) / kmPerLitre : 0) +
        runningCostPerKm +
        tollPerKm,
      2
    ),
  };
}

module.exports = { standingCostFor, ratesFor, DAYS_PER_MONTH };
