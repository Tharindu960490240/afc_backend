// PRISMS agent fields (ESOS Regulations s11), checked before an agent can be approved (E1-2).
// Body corporates also need a registered office and at least one director.
function prismsMissing(agent, directorCount) {
  const missing = [];
  const need = (ok, key, label) => { if (!ok) missing.push({ key, label }); };
  const has = (v) => typeof v === "string" && v.trim() !== "";

  need(has(agent.legal_name), "legal_name", "Legal name");
  need(has(agent.country), "country", "Country");
  need(has(agent.abn_acn), "abn_acn", "ABN / ACN (or business registration number)");
  need(has(agent.principal_address), "principal_address", "Principal place of business address");
  need(has(agent.phone), "phone", "Phone");
  need(has(agent.email), "email", "Email");
  if (agent.is_body_corporate) {
    need(has(agent.registered_office_address), "registered_office_address", "Registered office address");
    need(directorCount > 0, "directors", "At least one director");
  }
  return missing;
}
module.exports = { prismsMissing };
