require("dotenv").config();

const mongoose = require("mongoose");

const Company = require("../models/Company");
const Account = require("../../../models/Account");
const { hashPassword } = require("../../../utils/auth");

/*
 * Create a company and its owner from the command line, or reset an owner's
 * password.
 *
 * The public signup route does the same thing, so this exists for the two cases
 * it cannot cover: standing up a customer before they have a browser in front
 * of them, and getting an owner back into their own account when they have
 * forgotten the password and there is no mail delivery configured to reset it.
 *
 *   node scripts/ensure-owner.js "ABC Transport" owner@abc.test "Srikanta" secret123
 *
 * Deliberately not an HTTP endpoint. An internet-reachable route that mints
 * owners would be the largest hole in the product; requiring shell access to
 * the server is the point.
 */

async function main() {
  const [companyName, email, name, password] = process.argv.slice(2);

  if (!companyName || !email || !name || !password) {
    console.error(
      'usage: node scripts/ensure-owner.js "<company>" <email> "<name>" <password>'
    );
    process.exit(1);
  }
  if (String(password).length < 3) {
    console.error("The password must be at least 3 characters.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const normalisedEmail = String(email).trim().toLowerCase();
  const existing = await Account.findOne({ email: normalisedEmail });

  if (existing) {
    /*
     * The account already exists, so this is a password reset rather than a
     * creation. It does NOT change the role: promoting an existing sub-account
     * to owner from a script is exactly the mistake that hands a company to
     * whoever last ran a command, and the two companies would then have two
     * owners with no record of why.
     */
    existing.password = await hashPassword(password);
    existing.isActive = true;
    await existing.save();
    console.log(
      `Password reset for ${existing.email} (role: ${existing.role}). No other change made.`
    );
    await mongoose.disconnect();
    return;
  }

  let company = await Company.findOne({ name: companyName });
  if (!company) {
    company = await Company.create({ name: companyName });
    console.log(`Created company "${company.name}" (${company._id}).`);
  } else {
    console.log(`Using existing company "${company.name}" (${company._id}).`);
    const owners = await Account.countDocuments({ companyId: company._id, role: "owner" });
    if (owners > 0) {
      /* A second owner is allowed by the schema but is almost always a mistake
       * — usually a typo in the company name matching an existing tenant. It is
       * announced rather than blocked, because a genuine partnership is a real
       * case and the operator running this can see what they are doing. */
      console.warn(
        `WARNING: "${company.name}" already has ${owners} owner(s). Adding another.`
      );
    }
  }

  const account = await Account.create({
    module: "transport",
    companyId: company._id,
    name,
    email: normalisedEmail,
    role: "owner",
    password: await hashPassword(password),
  });

  console.log(`Created owner ${account.email} for "${company.name}".`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
