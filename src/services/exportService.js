// ===============================
// CSV exports for the lists other than the agent register (NF-13).
// Each export is limited to the people who can see that list on screen, and each one is logged.
// ===============================
const audit = require("../repositories/auditRepo");
const userRepo = require("../repositories/userRepo");
const agreementRepo = require("../repositories/agreementRepo");
const holidayRepo = require("../repositories/holidayRepo");
const { toCsv } = require("../utils/csv");

const MAX_ROWS = 5000;
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "");
const stamp = (v) => (v ? new Date(v).toISOString() : "");

async function done(actor, ctx, entityType, rows, filters) {
  await audit.log({ actorId: actor.id, action: `${entityType}.exported`, entityType, metadata: { rows, filters }, ...ctx });
}

async function users(actor, q, ctx) {
  const { rows } = await userRepo.list({ role: q.role, status: q.status, search: q.search, limit: MAX_ROWS, offset: 0 });
  await done(actor, ctx, "user", rows.length, { role: q.role, status: q.status, search: q.search });
  return toCsv(
    ["First name", "Last name", "Email", "Phone", "Role", "Status", "Created"],
    rows.map((u) => [u.first_name, u.last_name, u.email, u.phone, u.role, u.status, stamp(u.created_at)]),
  );
}

async function agreements(actor, q, ctx) {
  const { rows } = await agreementRepo.list({ agentId: q.agent_id, status: q.status, limit: MAX_ROWS, offset: 0 });
  await done(actor, ctx, "agreement", rows.length, { status: q.status, agent_id: q.agent_id });
  return toCsv(
    ["Title", "Agency", "Agent", "Agent email", "Status", "Sent", "Agent signed", "Reviewed", "Effective", "Expires", "Days left", "Rejection reason"],
    rows.map((a) => [
      a.title, a.agency_name, `${a.agent_first_name} ${a.agent_last_name}`.trim(), a.agent_email, a.status,
      day(a.sent_at), day(a.agent_signed_at), day(a.reviewed_at), day(a.effective_date), day(a.expires_at), a.days_left, a.rejection_reason,
    ]),
  );
}

async function holidays(actor, ctx) {
  const rows = await holidayRepo.all();
  await done(actor, ctx, "holiday", rows.length, {});
  return toCsv(["Date", "Name", "Jurisdiction"], rows.map((h) => [h.holiday_date, h.name, h.jurisdiction]));
}

async function auditLog(actor, q, ctx) {
  const { rows } = await audit.search({
    entityType: q.entity_type, entityId: q.entity_id, actorId: q.actor_id, action: q.action, from: q.from, to: q.to,
    limit: MAX_ROWS, offset: 0,
  });
  await done(actor, ctx, "audit", rows.length, { ...q, page: undefined, limit: undefined });
  return toCsv(
    ["When", "Action", "Entity", "Entity ID", "By", "IP", "Before", "After", "Details"],
    rows.map((r) => [
      stamp(r.created_at), r.action, r.entity_type, r.entity_id, `${r.actor_first_name || ""} ${r.actor_last_name || ""}`.trim(),
      r.ip, r.before, r.after, r.metadata,
    ]),
  );
}

module.exports = { users, agreements, holidays, auditLog, MAX_ROWS };
