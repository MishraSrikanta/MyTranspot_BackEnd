const express = require("express");

const Employee = require("../models/Employee");
const Driver = require("../models/Driver");
const Vehicle = require("../models/Vehicle");
const { errors, handler } = require("../../../utils/apiError");
const {
  parseText,
  parseOptionalText,
  parseAmount,
  parseEnum,
  parseDate,
  parseBoolean,
  parsePhone,
  isNil,
} = require("../../../utils/validate");
const { requireAuth, requirePermission } = require("../../../middleware/auth");
const { standingCostFor } = require("../utils/standingCost");
const { round } = require("../utils/geo");
const audit = require("../../../utils/audit");

const { EMPLOYEE_ROLES } = Employee;

/*
 * ================= employee management =================
 *
 * The people the business pays, and what each of them costs.
 *
 * ================= why a driver and a helper are one screen =================
 *
 * They are two collections (see models/Employee.js — a driver holds a licence,
 * is assigned to a lorry and may have a phone login; a helper is none of that)
 * and they are one QUESTION: what does my workforce cost me a month? An owner
 * asking it does not care which table the answer comes out of, so this router
 * reads both and presents one payroll.
 *
 * Writing is different. A driver's own record is edited on the driver screens,
 * because changing a driver touches trip assignment and the app login; what can
 * be edited from here is their PAY, which is the part this module is about.
 */

const router = express.Router();
router.use(requireAuth);

/* Drivers and staff are managed by the same permission: they are one payroll. */
const canView = requirePermission("drivers.view");
const canManage = requirePermission("drivers.manage");

function serialise(employee, vehicles = new Map()) {
  const pay = employee.pay || {};
  return {
    _id: String(employee._id),
    kind: "STAFF",
    name: employee.name,
    role: employee.role,
    phone: employee.phone || "",
    address: employee.address || "",
    idNumber: employee.idNumber || "",
    pay: {
      monthlySalary: pay.monthlySalary || 0,
      foodPerDay: pay.foodPerDay || 0,
      otherPerDay: pay.otherPerDay || 0,
      dailyWage: pay.dailyWage || 0,
      perTripBonus: pay.perTripBonus || 0,
      paidToDate: pay.paidToDate || 0,
    },
    assignedVehicleId: employee.assignedVehicleId ? String(employee.assignedVehicleId) : null,
    assignedVehicle: employee.assignedVehicleId
      ? vehicles.get(String(employee.assignedVehicleId)) || ""
      : "",
    joinedOn: employee.joinedOn,
    leftOn: employee.leftOn,
    notes: employee.notes || "",
    isActive: employee.isActive !== false,
    /* What this person costs in a month with no time on the road — the salary
     * alone. Days on the road are trip costs and are counted there. */
    monthlyCost: employee.monthlyCost(0),
    costPerDayOnTrip: employee.costPerDayOnTrip(),
  };
}

/* ================= GET /api/v1/employees =================
 * The whole payroll: drivers and staff, with what each costs.
 */
router.get(
  "/",
  canView,
  handler(async (req, res) => {
    const query = { companyId: req.companyId };
    if (req.query.role) query.role = parseEnum(req.query.role, "role", EMPLOYEE_ROLES);
    if (req.query.active !== undefined) query.isActive = parseBoolean(req.query.active, true);
    else query.isActive = true;

    const [employees, drivers, vehicleList] = await Promise.all([
      Employee.find(query).sort({ role: 1, name: 1 }),
      /* Drivers are read whatever the role filter says only when no role was
       * asked for: "show me the mechanics" should not return the drivers. */
      req.query.role ? [] : Driver.find({ companyId: req.companyId, isActive: query.isActive }),
      Vehicle.find({ companyId: req.companyId }).select("registrationNumber"),
    ]);

    const vehicles = new Map(
      vehicleList.map((vehicle) => [String(vehicle._id), vehicle.registrationNumber])
    );

    const staff = employees.map((employee) => serialise(employee, vehicles));

    const driverRows = drivers.map((driver) => {
      const pay = driver.pay || {};
      return {
        _id: String(driver._id),
        kind: "DRIVER",
        name: driver.name,
        role: "DRIVER",
        phone: driver.phone || "",
        address: driver.address || "",
        idNumber: driver.licenceNumber || "",
        pay: {
          monthlySalary: pay.monthlySalary || 0,
          foodPerDay: pay.foodPerDay || 0,
          otherPerDay: pay.otherPerDay || 0,
          dailyWage: pay.dailyWage || 0,
          perTripBonus: pay.perTripBonus || 0,
          paidToDate: pay.paidToDate || 0,
        },
        assignedVehicleId: driver.assignedVehicleId ? String(driver.assignedVehicleId) : null,
        assignedVehicle: driver.assignedVehicleId
          ? vehicles.get(String(driver.assignedVehicleId)) || ""
          : "",
        joinedOn: driver.joinedOn,
        leftOn: null,
        notes: "",
        isActive: driver.isActive !== false,
        monthlyCost: round(pay.monthlySalary || 0),
        costPerDayOnTrip: round((pay.foodPerDay || 0) + (pay.otherPerDay || 0)),
        /* The trip-fee arrangement, which only a driver has. Shown so the payroll
         * screen can say "salaried" or "paid per trip" rather than implying that
         * a driver on ₹2/km with no salary costs nothing. */
        defaultTripFee: driver.defaultTripFee || 0,
        defaultFeePerKm: driver.defaultFeePerKm || 0,
      };
    });

    const people = [...driverRows, ...staff];

    return res.json({
      people,
      summary: {
        headcount: people.length,
        drivers: driverRows.length,
        staff: staff.length,
        /* The monthly wage bill: the number an owner needs before they can
         * decide whether the fleet is the right size. */
        monthlySalaryTotal: round(
          people.reduce((sum, person) => sum + (person.pay.monthlySalary || 0), 0)
        ),
        /* What a day on the road costs in food and incidentals for everyone —
         * per person per day, so a three-day trip with a helper is obvious. */
        onRoadPerDayTotal: round(
          people.reduce((sum, person) => sum + person.costPerDayOnTrip, 0)
        ),
        unsalaried: people.filter((person) => (person.pay.monthlySalary || 0) === 0).length,
      },
      roles: EMPLOYEE_ROLES,
    });
  })
);

/* ================= GET /api/v1/employees/payroll =================
 * The wage bill and the fleet's standing cost for a period, together.
 */
router.get(
  "/payroll",
  canView,
  handler(async (req, res) => {
    const from = parseDate(req.query.from, "from");
    const to = parseDate(req.query.to, "to");
    const standing = await standingCostFor(req.companyId, { from, to });
    return res.json({ period: { from, to }, standing });
  })
);

/* ================= POST /api/v1/employees ================= */
router.post(
  "/",
  canManage,
  handler(async (req, res) => {
    const employee = await Employee.create({
      companyId: req.companyId,
      ...parseBody(req.body, { partial: false }),
    });

    audit.record(req, {
      action: "employee.created",
      entityType: "Employee",
      entityId: employee._id,
      entityLabel: `${employee.name} (${employee.role})`,
    });

    return res.status(201).json({ employee: serialise(employee) });
  })
);

/* ================= PUT /api/v1/employees/:id ================= */
router.put(
  "/:id",
  canManage,
  handler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!employee) throw errors.notFound("That person is not on the payroll.");

    Object.assign(employee, parseBody(req.body, { partial: true }));
    await employee.save();

    audit.record(req, {
      action: "employee.updated",
      entityType: "Employee",
      entityId: employee._id,
      entityLabel: employee.name,
    });

    return res.json({ employee: serialise(employee) });
  })
);

/* ================= DELETE /api/v1/employees/:id =================
 * Archived, never deleted: they appear in months that are already closed, and a
 * wage bill that changes retrospectively is not a wage bill.
 */
router.delete(
  "/:id",
  canManage,
  handler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!employee) throw errors.notFound("That person is not on the payroll.");

    employee.isActive = false;
    employee.leftOn = employee.leftOn || new Date();
    await employee.save();

    audit.record(req, {
      action: "employee.archived",
      entityType: "Employee",
      entityId: employee._id,
      entityLabel: employee.name,
    });

    return res.json({ employee: serialise(employee), message: `${employee.name} archived.` });
  })
);

function parseBody(body, { partial }) {
  const out = {};

  if (!partial || body.name !== undefined) {
    out.name = parseText(body.name, "name", { max: 80, label: "Name" });
  }
  if (!partial || body.role !== undefined) {
    out.role = parseEnum(body.role, "role", EMPLOYEE_ROLES, { fallback: "HELPER", label: "role" });
  }
  if (body.phone !== undefined) out.phone = parsePhone(body.phone, "phone");
  if (body.address !== undefined) out.address = parseOptionalText(body.address, "address", 400);
  if (body.idNumber !== undefined) out.idNumber = parseOptionalText(body.idNumber, "idNumber", 60);
  if (body.notes !== undefined) out.notes = parseOptionalText(body.notes, "notes", 2000);
  if (body.joinedOn !== undefined) out.joinedOn = parseDate(body.joinedOn, "joinedOn");
  if (body.leftOn !== undefined) out.leftOn = parseDate(body.leftOn, "leftOn");
  if (body.isActive !== undefined) out.isActive = parseBoolean(body.isActive, true);
  if (body.assignedVehicleId !== undefined) {
    out.assignedVehicleId = isNil(body.assignedVehicleId) ? null : body.assignedVehicleId;
  }

  if (body.pay !== undefined && body.pay !== null) {
    const pay = {};
    for (const field of [
      "monthlySalary",
      "foodPerDay",
      "otherPerDay",
      "dailyWage",
      "perTripBonus",
      "paidToDate",
    ]) {
      if (body.pay[field] !== undefined) {
        pay[field] = parseAmount(body.pay[field], `pay.${field}`, { max: 1e7 });
      }
    }
    out.pay = pay;
  }

  return out;
}

module.exports = router;
