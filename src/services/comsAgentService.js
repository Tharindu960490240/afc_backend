// ===============================
// COMS agent register (Block 1, Part 1).
// One record per agent organisation, with its people, status history and SLA clock.
// ===============================
const AppError = require("../utils/AppError");
const { withTransaction } = require("../config/db");
const {
  AGENT_PERMS, AGENT_TRANSITIONS, STAFF_ROLES, ROLES,
} = require("../const");
const { validAbnOrAcn } = require("../utils/abn");
const { changes } = require("../utils/diff");
const repo = require("../repositories/comsAgentRepo");
const userRepo = require("../repositories/userRepo");
const audit = require("../repositories/auditRepo");
const calendar = require("./calendarService");
const { prismsMissing } = require("./prisms");
const email = require("./emailService");

const ENTITY = "agent";
const DECIDED = ["approved", "onboarding", "active", "under_review", "suspended", "expired", "terminated", "rejected"];
const DETAIL_KEYS = [
  "legal_name", "trading_names", "abn_acn", "country", "is_body_corporate", "principal_address",
  "registered_office_address", "postal_address", "phone", "email", "website", "marn",
];
const PORTFOLIO_KEYS = ["account_manager_id", "tier", "risk_rating", "risk_override_reason", "contact_cadence_days"];

const allowed = (actor, perm) => AGENT_PERMS[perm].includes(actor.role);
const need = (actor, perm) => {
  if (!allowed(actor, perm)) throw new AppError(403, "You do not have permission to do that.");
};
const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });

// ---------- shaping ----------
function shape(a) {
  const { manager_first_name, manager_last_name, ...rest } = a;
  return {
    ...rest,
    account_manager_name: manager_first_name ? `${manager_first_name} ${manager_last_name}`.trim() : null,
    prisms_missing: prismsMissing(a, a.director_count),
  };
}

// SLA clock: acknowledge within 3 working days, decide within 10 (amber from day 7, red from day 10).
async function slaFor(a) {
  if (!a.application_received_at) return null;
  const today = calendar.localDate();
  const received = calendar.localDate(a.application_received_at);
  const elapsed = await calendar.businessDaysBetween(received, today);
  const decided = DECIDED.includes(a.status);
  const ackState = a.ack_sent_at ? "done" : a.ack_due_date && today > a.ack_due_date ? "overdue" : "due";
  let decisionState = "done";
  if (!decided) decisionState = elapsed >= 10 ? "red" : elapsed >= 7 ? "amber" : "ok";
  return {
    received_on: received,
    working_days_elapsed: elapsed,
    acknowledgement: { due: a.ack_due_date, sent_at: a.ack_sent_at, state: ackState },
    decision: {
      due: a.decision_due_date,
      state: decisionState,
      working_days_left: decided ? null : await calendar.businessDaysBetween(today, a.decision_due_date || today),
    },
  };
}

// ---------- reading ----------
async function list(actor, q) {
  need(actor, "read");
  if (q.deleted && !allowed(actor, "restore")) throw new AppError(403, "You do not have permission to do that.");
  const { rows, total } = await repo.list(
    { status: q.status, tier: q.tier, risk: q.risk, country: q.country, manager: q.manager, search: q.search, deleted: q.deleted },
    { limit: q.limit, offset: (q.page - 1) * q.limit, sort: q.sort, dir: q.dir },
  );
  // the register shows a timer next to every application that is still open
  const shaped = await Promise.all(rows.map(async (r) => {
    const row = shape(r);
    if (["applied", "due_diligence"].includes(r.status)) {
      const sla = await slaFor(r);
      row.decision_state = sla?.decision.state || null;
      row.working_days_left = sla?.decision.working_days_left ?? null;
    }
    return row;
  }));
  return { rows: shaped, total, page: q.page, limit: q.limit };
}

async function getDetail(actor, id, { includeDeleted = true } = {}) {
  need(actor, "read");
  const a = await repo.findById(id);
  if (!a || (a.deleted_at && (!includeDeleted || !allowed(actor, "restore")))) throw new AppError(404, "Agent not found.");
  const [persons, history, agreements, signed, activity] = await Promise.all([
    repo.persons(id),
    repo.history(id),
    repo.agreements(id),
    repo.hasSignedAgreement(id),
    audit.search({ entityType: ENTITY, entityId: id, limit: 30, offset: 0 }),
  ]);
  const base = shape(a);
  return {
    ...base,
    persons,
    history,
    agreements,
    has_signed_agreement: signed,
    sla: await slaFor(a),
    activity: activity.rows,
    permissions: Object.fromEntries(Object.keys(AGENT_PERMS).map((k) => [k, allowed(actor, k)])),
  };
}

async function meta(actor) {
  need(actor, "read");
  return {
    staff: await repo.staffUsers(),
    transitions: Object.fromEntries(
      Object.entries(AGENT_TRANSITIONS).map(([from, tos]) => [
        from,
        Object.entries(tos).filter(([, t]) => t.roles.includes(actor.role)).map(([to, t]) => ({ to, reason: !!t.reason })),
      ]),
    ),
    permissions: Object.fromEntries(Object.keys(AGENT_PERMS).map((k) => [k, allowed(actor, k)])),
  };
}

// ---------- creating ----------
async function createFromEoi(actor, body, ctx) {
  need(actor, "create");
  if (await userRepo.emailExists(body.email)) throw new AppError(409, "An account with this email already exists.", { errors: { email: "Already registered" } });
  if (await repo.findByEmail(body.email)) throw new AppError(409, "An agent with this email is already in the register.", { errors: { email: "Already in the register" } });

  const id = await withTransaction(async (client) => {
    const agentId = await repo.insert(client, {
      legal_name: body.legal_name, country: body.country, email: body.email, phone: body.phone,
      status: "prospect", source: body.source, actor: actor.id,
    });
    if (body.contact_name) {
      await repo.insertPerson(client, agentId, { name: body.contact_name, email: body.email, role: "staff", is_primary_contact: true }, actor.id);
    }
    await repo.addHistory(client, { agentId, to: "prospect", reason: "Expression of interest", actorId: actor.id });
    await audit.log({ actorId: actor.id, action: "agent.created", entityType: ENTITY, entityId: agentId, after: { legal_name: body.legal_name, email: body.email, country: body.country, source: body.source }, ...ctx }, client);
    return agentId;
  });

  let linkSent = false;
  if (body.send_link) {
    try {
      await sendApplicationLink(actor, id, ctx);
      linkSent = true;
    } catch (err) {
      if (!(err instanceof AppError)) throw err; // the record stays; staff can resend the link
    }
  }
  return { agent: await getDetail(actor, id), linkSent };
}

// AG-01: portal link to the online application
async function sendApplicationLink(actor, id, ctx) {
  need(actor, "create");
  const a = await repo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  if (!["prospect", "applied"].includes(a.status)) throw new AppError(409, "This agent has already passed the application stage.");
  const people = await repo.persons(id);
  if (people.some((p) => p.portal_user_id)) throw new AppError(409, "This agent already has a portal account.");
  const contact = people.find((p) => p.is_primary_contact) || people[0];
  const invitationService = require("./invitationService"); // loaded here: the two services reference each other
  await invitationService.issue(
    actor, { email: a.email, role: ROLES.AGENT, firstName: contact?.name?.split(" ")[0], agentId: id }, ctx, "agent.application_link_sent",
  );
}

// ---------- editing ----------
async function update(actor, id, body, ctx) {
  const keys = Object.keys(body);
  const touchesDetails = keys.some((k) => DETAIL_KEYS.includes(k));
  const touchesPortfolio = keys.some((k) => PORTFOLIO_KEYS.includes(k));
  if (touchesDetails) need(actor, "edit");
  if (touchesPortfolio) need(actor, "portfolio");

  const before = await repo.findById(id);
  if (!before || before.deleted_at) throw new AppError(404, "Agent not found.");

  const country = body.country ?? before.country;
  const abn = body.abn_acn !== undefined ? body.abn_acn : before.abn_acn;
  if (("abn_acn" in body || "country" in body) && abn && /^australia$/i.test(country) && !validAbnOrAcn(abn)) {
    throw fieldError("abn_acn", "This is not a valid ABN or ACN");
  }
  if ("risk_rating" in body && body.risk_rating && !String(body.risk_override_reason || "").trim()) {
    throw fieldError("risk_override_reason", "Please say why you are setting the risk rating");
  }
  if (body.account_manager_id) {
    const m = await userRepo.findById(body.account_manager_id);
    if (!m || m.status !== "active" || !STAFF_ROLES.includes(m.role)) throw fieldError("account_manager_id", "Choose an active staff member");
  }

  try {
    await withTransaction(async (client) => {
      await repo.update(client, id, body, actor.id);
      const after = await repo.findById(id, client);
      const diff = changes(before, after, keys);
      if (diff.changed) {
        await audit.log({ actorId: actor.id, action: "agent.updated", entityType: ENTITY, entityId: id, before: diff.before, after: diff.after, ...ctx }, client);
      }
    });
  } catch (err) {
    if (err.code === "23505") throw new AppError(409, "Another agent already uses this email.", { errors: { email: "Already in the register" } });
    throw err;
  }
  return getDetail(actor, id);
}

// ---------- status ----------
async function changeStatus(actor, id, { status: to, reason }, ctx) {
  const result = await withTransaction(async (client) => {
    const a = await repo.findById(id, client, { lock: true });
    if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
    const from = a.status;
    if (from === to) throw new AppError(409, `The agent is already ${to.replace("_", " ")}.`);

    const t = AGENT_TRANSITIONS[from]?.[to];
    if (!t) {
      if (from === "due_diligence" && ["approved", "rejected"].includes(to)) {
        throw new AppError(409, "Approving or rejecting an agent is a decision made after due diligence. That step is not available yet.");
      }
      throw new AppError(409, `An agent cannot move from ${from.replace("_", " ")} to ${to.replace("_", " ")}.`);
    }
    if (!t.roles.includes(actor.role)) throw new AppError(403, "You do not have permission to do that.");
    if (t.reason && !String(reason || "").trim()) throw fieldError("reason", "Please give a reason");

    if (to === "active") {
      // BR-01 and BR-02: hard stops
      const blockers = [];
      if (!(await repo.hasSignedAgreement(id, client))) blockers.push("A fully signed agreement with start and end dates is needed (BR-01).");
      if (!a.prisms_recorded_at) blockers.push("PRISMS entry must be recorded (BR-02).");
      if (!a.induction_recorded_at) blockers.push("Induction must be recorded (BR-02).");
      if (blockers.length) throw new AppError(409, blockers.join(" "), { blockers });
    }

    await repo.setStatus(client, id, to, actor.id, { reason });
    await repo.addHistory(client, { agentId: id, from, to, reason, actorId: actor.id });
    await audit.log({ actorId: actor.id, action: "agent.status_changed", entityType: ENTITY, entityId: id, before: { status: from }, after: { status: to }, metadata: { reason: reason || null }, ...ctx }, client);
    return { from, to };
  });

  if (result.from === "prospect" && result.to === "applied") await startClock(id);
  return getDetail(actor, id);
}

// Starts the 3 / 10 working-day clock (AG-03, AG-05).
async function startClock(id, client) {
  const today = calendar.localDate();
  const run = async (c) => {
    await repo.setSla(c, id, {
      receivedAt: new Date(),
      ackDue: await calendar.addBusinessDays(today, 3),
      decisionDue: await calendar.addBusinessDays(today, 10),
    });
  };
  if (client) return run(client);
  return withTransaction(run);
}

// ---------- remove / restore ----------
async function remove(actor, id, reason, ctx) {
  need(actor, "remove");
  await withTransaction(async (client) => {
    const a = await repo.findById(id, client, { lock: true });
    if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
    await repo.softDelete(client, id, reason, actor.id);
    await audit.log({ actorId: actor.id, action: "agent.deleted", entityType: ENTITY, entityId: id, metadata: { reason }, before: { legal_name: a.legal_name, status: a.status }, ...ctx }, client);
  });
}

async function restore(actor, id, ctx) {
  need(actor, "restore");
  try {
    await withTransaction(async (client) => {
      const a = await repo.findById(id, client, { lock: true });
      if (!a || !a.deleted_at) throw new AppError(404, "Deleted agent not found.");
      await repo.restore(client, id, actor.id);
      await audit.log({ actorId: actor.id, action: "agent.restored", entityType: ENTITY, entityId: id, ...ctx }, client);
    });
  } catch (err) {
    if (err.code === "23505") throw new AppError(409, "Another agent now uses this email, so this record cannot be restored.");
    throw err;
  }
  return getDetail(actor, id);
}

// ---------- people ----------
async function addPerson(actor, id, body, ctx) {
  need(actor, "edit");
  const a = await repo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  const personId = await withTransaction(async (client) => {
    if (body.is_primary_contact) await repo.clearPrimary(client, id);
    const pid = await repo.insertPerson(client, id, body, actor.id);
    await audit.log({ actorId: actor.id, action: "agent.person_added", entityType: ENTITY, entityId: id, after: { name: body.name, role: body.role || "staff" }, ...ctx }, client);
    return pid;
  });
  return { id: personId, persons: await repo.persons(id) };
}

async function updatePerson(actor, id, personId, body, ctx) {
  need(actor, "edit");
  const before = await repo.findPerson(id, personId);
  if (!before) throw new AppError(404, "Person not found.");
  await withTransaction(async (client) => {
    if (body.is_primary_contact) await repo.clearPrimary(client, id);
    await repo.updatePerson(client, personId, body, actor.id);
    const after = await repo.findPerson(id, personId, client);
    const diff = changes(before, after, Object.keys(body));
    if (diff.changed) {
      await audit.log({ actorId: actor.id, action: "agent.person_updated", entityType: ENTITY, entityId: id, before: { person: before.name, ...diff.before }, after: diff.after, ...ctx }, client);
    }
  });
  return repo.persons(id);
}

async function removePerson(actor, id, personId, reason, ctx) {
  need(actor, "edit");
  const p = await repo.findPerson(id, personId);
  if (!p) throw new AppError(404, "Person not found.");
  if (p.portal_user_id) throw new AppError(409, "This person has a portal account. Suspend the account first.");
  await withTransaction(async (client) => {
    await repo.softDeletePerson(client, personId, reason, actor.id);
    await audit.log({ actorId: actor.id, action: "agent.person_removed", entityType: ENTITY, entityId: id, before: { name: p.name, role: p.role }, metadata: { reason }, ...ctx }, client);
  });
  return repo.persons(id);
}

// ---------- onboarding evidence (BR-02) ----------
async function recordMilestone(actor, id, { type, date }, ctx) {
  need(actor, type === "prisms" ? "recordPrisms" : "recordInduction");
  const a = await repo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  if (!["approved", "onboarding", "active", "under_review"].includes(a.status)) {
    throw new AppError(409, "This can only be recorded for an approved agent.");
  }
  const when = date ? new Date(`${date}T12:00:00`) : new Date();
  await withTransaction(async (client) => {
    await repo.setMilestone(client, id, type, when, actor.id);
    await audit.log({ actorId: actor.id, action: `agent.${type}_recorded`, entityType: ENTITY, entityId: id, after: { date: calendar.localDate(when) }, ...ctx }, client);
  });
  return getDetail(actor, id);
}

// ---------- the existing sign-up flows feed the register ----------
// Called inside the transaction that creates the portal login.
async function linkNewPortalUser(client, { user, agencyName, businessNumber, country, via }, agentId) {
  let target = null;
  if (agentId) target = await repo.findById(agentId, client, { lock: true });
  if (!target) {
    const same = await repo.findByEmail(user.email, client);
    if (same) target = await repo.findById(same.id, client, { lock: true });
  }

  const fullName = `${user.first_name} ${user.last_name}`.trim();
  if (!target) {
    const id = await repo.insert(client, {
      legal_name: agencyName, country, email: user.email, phone: user.phone, abn_acn: businessNumber || null,
      status: via === "website" ? "prospect" : "applied", source: via, actor: user.id,
    });
    await repo.insertPerson(client, id, { name: fullName, email: user.email, role: "staff", is_primary_contact: true, portal_user_id: user.id }, user.id);
    await repo.addHistory(client, { agentId: id, to: via === "website" ? "prospect" : "applied", reason: via === "website" ? "Registered on the website" : "Accepted an invitation", actorId: user.id });
    if (via !== "website") await startClock(id, client);
    return { agentId: id, applied: via !== "website" };
  }

  // an expression of interest already exists: attach the login to it
  const people = await repo.persons(target.id, client);
  const match = people.find((p) => p.email.toLowerCase() === user.email.toLowerCase());
  if (match) await repo.linkPortalUser(client, match.id, user.id);
  else await repo.insertPerson(client, target.id, { name: fullName, email: user.email, role: "staff", is_primary_contact: !people.some((p) => p.is_primary_contact), portal_user_id: user.id }, user.id);

  const fill = {};
  if (!target.abn_acn && businessNumber) fill.abn_acn = businessNumber;
  if (!target.phone && user.phone) fill.phone = user.phone;
  if (Object.keys(fill).length) await repo.update(client, target.id, fill, user.id);

  let applied = false;
  if (target.status === "prospect" && via !== "website") {
    await repo.setStatus(client, target.id, "applied", user.id);
    await repo.addHistory(client, { agentId: target.id, from: "prospect", to: "applied", reason: "Accepted the application link", actorId: user.id });
    await startClock(target.id, client);
    applied = true;
  }
  return { agentId: target.id, applied };
}

// A website registration whose email has just been confirmed becomes an application.
async function markApplicationReceived(client, userId) {
  const found = await repo.findByPortalUser(userId, client, { lock: true });
  if (!found) return null;
  const a = await repo.findById(found.id, client);
  if (a.status === "prospect") {
    await repo.setStatus(client, a.id, "applied", userId);
    await repo.addHistory(client, { agentId: a.id, from: "prospect", to: "applied", reason: "Confirmed their email", actorId: userId });
    await startClock(a.id, client);
  }
  return a.id;
}

// AG-03: acknowledge the application and list what is still missing. Safe to call twice.
async function acknowledge(agentId) {
  const a = await repo.findById(agentId);
  if (!a || a.ack_sent_at) return;
  const people = await repo.persons(agentId);
  const to = people.find((p) => p.portal_user_id) || people[0];
  if (!to) return;
  const missing = prismsMissing(a, a.director_count).map((m) => m.label);
  await email.sendApplicationReceived({ to: to.email, firstName: to.name.split(" ")[0], legalName: a.legal_name, missing });
  await repo.markAcknowledged(agentId);
}

// The college decided on a website registration (existing Registrations screen).
async function syncDecision(client, userId, approve, actorId, reason) {
  const found = await repo.findByPortalUser(userId, client, { lock: true });
  if (!found) return;
  const a = await repo.findById(found.id, client);
  const to = approve ? "approved" : "rejected";
  if (a.status === to) return;
  await repo.setStatus(client, a.id, to, actorId, { reason });
  await repo.addHistory(client, { agentId: a.id, from: a.status, to, reason: reason || null, actorId });
}

// A user account was suspended or re-activated from the Users screen.
async function syncUserStatus(userId, userStatus, actorId) {
  await withTransaction(async (client) => {
    const found = await repo.findByPortalUser(userId, client, { lock: true });
    if (!found) return;
    const a = await repo.findById(found.id, client);
    if (userStatus === "suspended" && !["suspended", "terminated", "rejected", "expired"].includes(a.status)) {
      await repo.setStatus(client, a.id, "suspended", actorId);
      await repo.addHistory(client, { agentId: a.id, from: a.status, to: "suspended", reason: "Portal account suspended", actorId });
    } else if (userStatus === "active" && a.status === "suspended") {
      const last = (await repo.history(a.id)).find((h) => h.to_status === "suspended" && h.from_status);
      const back = last?.from_status || "approved";
      await repo.setStatus(client, a.id, back, actorId);
      await repo.addHistory(client, { agentId: a.id, from: "suspended", to: back, reason: "Portal account re-activated", actorId });
    }
  });
}

// ---------- export (NF-13) ----------
const csvCell = (v) => {
  let s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stops spreadsheet formulas from running
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exportCsv(actor, q, ctx) {
  need(actor, "read");
  const rows = await repo.listAll({ status: q.status, tier: q.tier, risk: q.risk, country: q.country, manager: q.manager, search: q.search, deleted: false }, 5000);
  const header = [
    "Legal name", "Trading names", "ABN/ACN", "Country", "Body corporate", "Principal address", "Registered office",
    "Postal address", "Phone", "Email", "Website", "MARN", "Status", "Tier", "Risk", "Account manager",
    "Agreement end", "PRISMS recorded", "Induction recorded", "Missing PRISMS fields",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows.map(shape)) {
    lines.push([
      r.legal_name, r.trading_names, r.abn_acn, r.country, r.is_body_corporate ? "Yes" : "No", r.principal_address,
      r.registered_office_address, r.postal_address, r.phone, r.email, r.website, r.marn, r.status, r.tier, r.risk_rating,
      r.account_manager_name, r.agreement_end, r.prisms_recorded_at && calendar.localDate(r.prisms_recorded_at),
      r.induction_recorded_at && calendar.localDate(r.induction_recorded_at), r.prisms_missing.map((m) => m.label),
    ].map(csvCell).join(","));
  }
  await audit.log({ actorId: actor.id, action: "agent.exported", entityType: ENTITY, metadata: { rows: rows.length, filters: { ...q, page: undefined } }, ...ctx });
  return lines.join("\r\n");
}

module.exports = {
  list, getDetail, meta, createFromEoi, sendApplicationLink, update, changeStatus, remove, restore,
  addPerson, updatePerson, removePerson, recordMilestone,
  linkNewPortalUser, markApplicationReceived, acknowledge, syncDecision, syncUserStatus, exportCsv, slaFor,
};
