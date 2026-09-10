const { iso } = require("../../../utils/auth");

/*
 * The transport tenant as the client sees it.
 *
 * This used to live in the shared utils/auth.js, next to serialiseAccount. It
 * moved here when the backend started serving a second product: a Company is
 * MyTransport's word for a tenant and nothing in the clinic module has one, so
 * a shared file that knew about trip prefixes and tracking intervals was a
 * shared file that only half the codebase could use.
 */
function serialiseCompany(company) {
  return {
    id: String(company._id),
    name: company.name,
    legalName: company.legalName || "",
    gstin: company.gstin || "",
    phone: company.phone || "",
    email: company.email || "",
    address: company.address || "",
    city: company.city || "",
    state: company.state || "",
    timezone: company.timezone,
    tripPrefix: company.tripPrefix,
    estimatePrefix: company.estimatePrefix,
    tracking: company.trackingConfig(),
    defaults: company.defaults || {},
    subscription: {
      plan: company.subscription?.plan || "trial",
      startedAt: iso(company.subscription?.startedAt),
      expiresAt: iso(company.subscription?.expiresAt),
      isActive: company.subscriptionIsActive(),
      limits: company.limits(),
    },
    createdAt: iso(company.createdAt),
  };
}

module.exports = { serialiseCompany, iso };
