const { round } = require("./geo");

/*
 * Turning a distance into a price.
 *
 * This is what an owner uses to answer a customer who has just asked "what will
 * it cost me to send twenty tonnes to Delhi?" — normally on the phone, normally
 * while the customer waits. So the whole calculation is driven from one number
 * the owner already knows (the distance) plus the company's standing rates,
 * and every intermediate figure is returned rather than hidden, because the
 * next thing the customer says is "why is it that much?"
 *
 * The rates come from the company defaults and can be overridden per quote.
 * Nothing here is compulsory: a rate left at zero simply contributes nothing,
 * so an owner who only tracks diesel and driver fee gets a usable quote without
 * filling in a form of fifteen boxes.
 */

/*
 * Work out what the trip will cost the transporter.
 *
 * The round-trip flag matters more than it looks. A lorry sent to Delhi has to
 * come back, and if there is no return load it burns the same diesel doing it.
 * Quoting a one-way cost on a lane with no back-load is the single most common
 * way a transport business loses money on work it thought was profitable.
 */
function buildCost(basis = {}) {
  const distanceKm = num(basis.distanceKm);
  const isRoundTrip = !!basis.isRoundTrip;
  /* The distance that actually burns fuel and pays a driver. */
  const chargeableKm = round(isRoundTrip ? distanceKm * 2 : distanceKm);

  const kmPerLitre = num(basis.kmPerLitre);
  const dieselRatePerLitre = num(basis.dieselRatePerLitre);
  const litresRequired = kmPerLitre > 0 ? round(chargeableKm / kmPerLitre, 2) : 0;
  const fuel = round(litresRequired * dieselRatePerLitre);

  const toll = round(chargeableKm * num(basis.tollPerKm));

  /*
   * A driver is paid per kilometre, per trip, or both — all three arrangements
   * are common, so both are added rather than one being chosen. An owner who
   * uses only one leaves the other at zero.
   */
  const driver = round(
    chargeableKm * num(basis.driverFeePerKm) + num(basis.driverFeePerTrip)
  );

  const tripDays = num(basis.tripDays) || 1;
  const nights = num(basis.nights);
  const food = round(tripDays * num(basis.foodPerDay));
  const allowance = round(nights * num(basis.nightAllowance));

  /*
   * ================= what a kilometre costs besides diesel =================
   *
   * Tyres, servicing, brake shoes, greasing. It is charged per kilometre
   * because that is how it is actually incurred — a lorry does not need new
   * tyres because a month passed, it needs them because it did 40,000 km — and
   * because that makes it comparable between a lane of 200 km and one of 1,600.
   *
   * This was the single biggest hole in the old quote. A run that covered its
   * diesel, its tolls and its driver looked profitable and was not, because the
   * ₹4 a kilometre of wear it caused was invoiced to nobody. Over 1,500 km that
   * is ₹6,000 a trip, which is most of the margin on the work.
   *
   * `runningCostPerKm` comes from the vehicle (see Vehicle.wearPerKm) so a
   * trailer and an LCV quote differently, and `maintenance` stays as a flat
   * per-trip figure for a known one-off — a service due at the far end.
   */
  const runningCostPerKm = num(basis.runningCostPerKm);
  const running = round(chargeableKm * runningCostPerKm);

  /*
   * ================= the people on board =================
   *
   * A helper rides with the lorry on most loads that need hand-loading, and
   * costs a daily wage plus food for every day of the trip. A quote that leaves
   * them out is short by a few thousand rupees before it has left the yard.
   *
   * `driverDayCost` is the driver's own food and incidentals per day. It is
   * separate from the per-km and per-trip FEE above because the two are settled
   * differently: the fee is what they earn for the job, this is what the owner
   * hands them for the road.
   *
   * Neither includes a salary. A salaried driver's wage is owed whether this
   * trip runs or not, so charging it here would count it again on the next trip
   * that month — it belongs in the profit-and-loss report, which apportions it
   * once across the period. See utils/standingCost.js.
   */
  const helperCount = Math.max(0, Math.round(num(basis.helperCount)));
  const helperCostPerDay = num(basis.helperCostPerDay);
  const helper = round(helperCount * helperCostPerDay * tripDays);

  const driverDayCost = num(basis.driverDayCost);
  const driverDays = round(driverDayCost * tripDays);

  const maintenance = num(basis.maintenance);
  const other = num(basis.other);

  const total = round(
    fuel + toll + driver + driverDays + food + allowance + running + helper + maintenance + other
  );

  return {
    cost: {
      fuel,
      toll,
      driver: round(driver + driverDays),
      food,
      allowance,
      running,
      helper,
      maintenance,
      other,
      total,
    },
    basis: {
      distanceKm,
      isRoundTrip,
      chargeableKm,
      tripDays,
      nights,
      kmPerLitre,
      dieselRatePerLitre,
      litresRequired,
      tollPerKm: num(basis.tollPerKm),
      runningCostPerKm,
      driverFeePerKm: num(basis.driverFeePerKm),
      driverFeePerTrip: num(basis.driverFeePerTrip),
      driverDayCost,
      foodPerDay: num(basis.foodPerDay),
      nightAllowance: num(basis.nightAllowance),
      helperCount,
      helperCostPerDay,
    },
  };
}

/*
 * Put a price on it.
 *
 * The margin is applied to the transporter's cost to reach the freight figure.
 * Loading and unloading are added on top rather than marked up, because they
 * are normally billed at what they cost — a customer who is quoted a marked-up
 * ₹5,000 for loading they know costs ₹5,000 stops trusting the rest of the
 * quote.
 *
 * `marginPercent` is a markup on cost, not a margin on revenue, and the
 * difference is worth being precise about: 25% here means a ₹32,000 trip is
 * quoted at ₹40,000, which is a 20% margin on the revenue. Both numbers are
 * returned so nobody has to guess which one they are reading.
 */
function buildQuote(cost, options = {}) {
  const marginPercent = num(options.marginPercent);
  const loadingCharges = num(options.loadingCharges);
  const unloadingCharges = num(options.unloadingCharges);
  const otherCharges = num(options.otherCharges);

  /* An explicitly quoted freight figure wins over the computed one: an owner
   * rounding ₹40,412 down to ₹40,000 to win the job must not have it silently
   * recalculated back up. */
  const computedFreight = round(num(cost.total) * (1 + marginPercent / 100));
  const freightCharges =
    options.freightCharges === undefined || options.freightCharges === null
      ? computedFreight
      : num(options.freightCharges);

  const subTotal = round(
    freightCharges + loadingCharges + unloadingCharges + otherCharges
  );
  const gstPercent = num(options.gstPercent);
  const gstAmount = round((subTotal * gstPercent) / 100);
  const total = round(subTotal + gstAmount);

  /* Measured against the pre-GST subtotal, for the reason set out at the top of
   * utils/tripFinance.js: the tax was never the transporter's money. */
  const expectedProfit = round(subTotal - num(cost.total));

  return {
    quote: {
      freightCharges,
      loadingCharges,
      unloadingCharges,
      otherCharges,
      gstPercent,
      gstAmount,
      subTotal,
      total,
    },
    expectedProfit,
    marginPercent,
    /* The margin as the owner's accountant means it: profit over revenue. */
    marginOnRevenuePercent: subTotal > 0 ? round((expectedProfit / subTotal) * 100, 2) : 0,
    suggestedFreight: computedFreight,
    /* What the load earns per kilometre — the number transporters actually
     * compare lanes with. */
    ratePerKm:
      num(cost.total) > 0 && num(options.distanceKm) > 0
        ? round(subTotal / num(options.distanceKm), 2)
        : 0,
  };
}

/*
 * The defaults a new quote starts from: the company's standing rates, with the
 * chosen lorry's own fuel economy taking precedence over the fleet average.
 * A twelve-year-old tipper and a new trailer do not do the same kilometres to
 * the litre, and on a 1,500 km run that difference is thousands of rupees.
 */
function defaultsFor(company, vehicle = null) {
  const d = company.defaults || {};
  return {
    kmPerLitre: num(vehicle?.averageKmPerLitre) || num(d.averageKmPerLitre),
    dieselRatePerLitre: num(d.dieselRatePerLitre),
    tollPerKm: num(d.tollPerKm),
    driverFeePerKm: num(d.driverFeePerKm),
    driverFeePerTrip: num(d.driverFeePerTrip),
    foodPerDay: num(d.foodAllowancePerDay),
    nightAllowance: num(d.nightAllowancePerNight),
    gstPercent: num(d.gstPercent),
    marginPercent: num(d.targetMarginPercent),
  };
}

/*
 * A quote turns into a trip's budget one-for-one. The categories were chosen to
 * match for exactly this reason — the estimate the owner gave the customer
 * becomes the estimate the trip is measured against, so the planned-versus-
 * actual report is comparing the quote to reality rather than to a second set
 * of numbers somebody typed in again.
 */
function costToTripEstimate(cost) {
  return {
    fuel: num(cost.fuel),
    toll: num(cost.toll),
    driver: num(cost.driver),
    food: num(cost.food),
    allowance: num(cost.allowance),
    maintenance: num(cost.maintenance),
    other: num(cost.other),
    total: num(cost.total),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

module.exports = { buildCost, buildQuote, defaultsFor, costToTripEstimate };
