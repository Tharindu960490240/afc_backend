// ===============================
// COMS agent register (Block 1, Part 1).
// One record per agent organisation, with its people, status history and SLA clock.
// ===============================
const AppError = require("../utils/AppError");
const settings = require("./settingsService");
const { withTransaction } = require("../config/db");
const {
  AGENT_PERMS, AGENT_TRANSITIONS, STAFF_ROLES, ROLES,
} = require("../const");
const { validAbnOrAcn } = require("../utils/abn");
const { changes } = require("../utils/diff");
const repo = require("../repositories/comsAgentRepo");
const userRepo = require("../repositories/userRepo");
const audit = require("../repositories/auditRepo");
const env = require("../config/env");
const calendar = require("./calendarService");
const { prismsMissing, applicationMissing } = require("./prisms");
const { csvCell } = require("../utils/csv");
const email = require("./emailService");
const ddRepo = require("../repositories/dueDiligenceRepo");

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
  const t = settings.timers();
  if (!decided) decisionState = elapsed >= t.decision_days ? "red" : elapsed >= t.amber_after_days ? "amber" : "ok";
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
  const [persons, referees, history, agreements, signed, activity, tasks, docs] = await Promise.all([
    repo.persons(id),
    repo.referees(id),
    repo.history(id),
    repo.agreements(id),
    repo.hasSignedAgreement(id),
    audit.search({ entityType: ENTITY, entityId: id, limit: 30, offset: 0 }),
    require("./taskService").forAgent(id),
    require("./agentDocumentService").checklistState(id),
  ]);
  const base = shape(a);
  return {
    ...base,
    persons,
    referees,
    application_missing: applicationMissing(a, referees.length),
    history,
    agreements,
    has_signed_agreement: signed,
    tasks,
    documents: docs.docs,
    documents_required: docs.required,
    documents_complete: docs.complete,
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
      if ("account_manager_id" in diff.after) {
        // the audit viewer shows people by name, not by database number
        const nameOf = async (uid) => {
          if (!uid) return null;
          const u = await userRepo.findById(uid);
          return u ? `${u.first_name} ${u.last_name}`.trim() : `User ${uid}`;
        };
        diff.before.account_manager = await nameOf(diff.before.account_manager_id);
        diff.after.account_manager = await nameOf(diff.after.account_manager_id);
        delete diff.before.account_manager_id;
        delete diff.after.account_manager_id;
      }
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
        throw new AppError(409, "Approving or rejecting an agent is a recorded decision made after due diligence. Open the Due diligence tab and use Approve or Reject there.");
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
    if (to === "due_diligence") await ddRepo.open(client, id, actor.id); // starts the checklist; the officer is the preparer (BR-06)
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
      ackDue: await calendar.addBusinessDays(today, settings.timers().ack_days),
      decisionDue: await calendar.addBusinessDays(today, settings.timers().decision_days),
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
  need(actor, type === "prisms" ? "recordPrisms" : type === "sms_contact" ? "dueDiligence" : "recordInduction");
  const a = await repo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  if (type === "sms_contact") {
    // procedure step 2: the contact is created in the student management system as soon as the application is in
    if (a.status === "prospect") throw new AppError(409, "Record this once the application has been received.");
  } else if (!["approved", "onboarding", "active", "under_review"].includes(a.status)) {
    throw new AppError(409, "This can only be recorded for an approved agent.");
  }
  const when = date ? new Date(`${date}T12:00:00`) : new Date();
  await withTransaction(async (client) => {
    await repo.setMilestone(client, id, type, when, actor.id);
    // the matching task on the board is finished by the same entry
    if (type !== "sms_contact") await client.query(
      `UPDATE coms_tasks SET status = 'done', completed_at = now(), completed_by = $3, completion_note = 'Recorded on the agent record',
         updated_at = now() WHERE agent_id = $1 AND type = $2 AND status = 'open' AND deleted_at IS NULL`,
      [id, type === "prisms" ? "PRISMS_ADD" : "INDUCTION", actor.id],
    );
    await audit.log({ actorId: actor.id, action: `agent.${type}_recorded`, entityType: ENTITY, entityId: id, after: { date: calendar.localDate(when) }, ...ctx }, client);
  });
  if (type !== "sms_contact") await require("./taskService").maybeActivate(id, actor, ctx); // E1-7: Active once agreement, PRISMS and induction are recorded
  return getDetail(actor, id);
}

// Procedure step 6: record the commission and bonus in the agent list and report them to AFC Accounts
async function recordTerms(actor, id, body, ctx) {
  need(actor, "sendAgreement");
  const a = await repo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  if (!["approved", "onboarding", "active"].includes(a.status)) throw new AppError(409, "Commission and bonus are recorded once the agent is approved.");
  const first = !a.terms_recorded_at;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agents SET commission_terms = $2, bonus_terms = $3, terms_recorded_at = now(), terms_recorded_by = $4, updated_at = now(), updated_by = $4 WHERE id = $1`,
      [id, body.commission_terms, body.bonus_terms || null, actor.id]);
    await client.query(
      `UPDATE coms_tasks SET status = 'done', completed_at = now(), completed_by = $2, completion_note = 'Commission and bonus recorded and sent to Accounts',
         updated_at = now() WHERE agent_id = $1 AND type = 'COMMISSION_REPORT' AND status = 'open' AND deleted_at IS NULL`, [id, actor.id]);
    await audit.log({
      actorId: actor.id, action: "agent.terms_recorded", entityType: ENTITY, entityId: id,
      before: { commission_terms: a.commission_terms || null, bonus_terms: a.bonus_terms || null },
      after: { commission_terms: body.commission_terms, bonus_terms: body.bonus_terms || null }, ...ctx,
    }, client);
  });
  const accounts = await require("../repositories/taskRepo").usersWithRoles([ROLES.ACCOUNTS]);
  accounts.forEach((u) => email.sendTermsReport({
    to: u.email, firstName: u.first_name, agencyName: a.legal_name, country: a.country,
    commission: body.commission_terms, bonus: body.bonus_terms, by: `${actor.first_name || ""} ${actor.last_name || ""}`.trim() || "A staff member",
    link: `${env.frontendUrl}/coms/agents/${id}`,
  }));
  return { ...(await getDetail(actor, id)), accounts_notified: accounts.length, first };
}

// E1-5: the officer sends the agreement from the agent record
async function sendAgreement(actor, id, body, ctx) {
  need(actor, "sendAgreement");
  const a = await repo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  if (a.status !== "approved") throw new AppError(409, "An agreement can be sent once the agent is approved and before onboarding starts.");
  const people = await repo.persons(id);
  const login = people.filter((p) => p.portal_user_id).sort((x, y) => Number(y.is_primary_contact) - Number(x.is_primary_contact))[0];
  if (!login) throw new AppError(409, "This agent has no portal login yet, so the agreement cannot be sent. Send the application link first.");
  await require("./agreementService").send(actor, { agent_id: login.portal_user_id, ...body }, ctx);
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
  const referees = await repo.referees(agentId);
  const docState = await require("./agentDocumentService").checklistState(agentId);
  const missingDocs = docState.required.filter((r) => r.status === "missing").map((r) => `${r.label} (please reply with a copy)`);
  const missing = [...prismsMissing(a, a.director_count), ...applicationMissing(a, referees.length)].map((m) => m.label).concat(missingDocs);
  await email.sendApplicationReceived({ to: to.email, firstName: to.name.split(" ")[0], legalName: a.legal_name, missing });
  await repo.markAcknowledged(agentId);
}

// ---------- the application form ----------
// Saves everything the applicant entered. Runs inside the transaction of the caller.
// website registration: called right after the login is created; portal: called by the signed-in agent.
async function saveApplication(client, agentId, user, app) {
  const current = await repo.findById(agentId, client, { lock: true });
  await repo.update(client, agentId, {
    legal_name: app.legal_name,
    trading_names: app.trading_names,
    abn_acn: app.abn_acn,
    country: app.country,
    is_body_corporate: app.is_body_corporate,
    principal_address: app.principal_address,
    registered_office_address: app.registered_office_address || null,
    postal_address: app.postal_address || null,
    website: app.website || null,
    marn: app.marn || null,
    phone: app.business_phone || current.phone || user.phone || null,
  }, user.id);

  // keep the older agent profile (used by the agreements screens) in step
  await client.query(
    `UPDATE agent_profiles SET agency_name = $2, business_number = $3, country = $4 WHERE user_id = $1`,
    [user.id, app.legal_name, app.abn_acn, app.country],
  );

  const people = await repo.persons(agentId, client);
  const me = people.find((p) => p.portal_user_id === user.id);
  const mine = { role: app.applicant_role, marn: app.applicant_marn || null, involved_in_enrolments: app.applicant_in_enrolments };
  if (me) await repo.updatePerson(client, me.id, mine, user.id);
  else {
    await repo.insertPerson(client, agentId, {
      name: `${user.first_name} ${user.last_name}`.trim(), email: user.email, ...mine,
      is_primary_contact: !people.some((p) => p.is_primary_contact), portal_user_id: user.id,
    }, user.id);
  }
  const known = new Set(people.map((p) => p.email.toLowerCase()).concat(user.email.toLowerCase()));
  for (const p of app.people) {
    if (known.has(p.email)) continue; // already on the record (for example from the expression of interest)
    known.add(p.email);
    await repo.insertPerson(client, agentId, { ...p, marn: p.marn || null, location: p.location || null }, user.id);
  }

  await repo.replaceReferees(client, agentId, app.referees, user.id);
  await repo.setApplication(client, agentId, {
    coi_declared: app.coi_declared, coi_details: app.coi_details,
    gst_registered: app.gst_registered, owner_name: app.owner_name, staff_count: app.staff_count, years_in_business: app.years_in_business,
    extra: app.extra, declaration_name: app.declaration_name,
  }, user.id);
  await audit.log({
    actorId: user.id, action: "agent.application_submitted", entityType: ENTITY, entityId: agentId,
    after: {
      legal_name: app.legal_name, country: app.country, is_body_corporate: app.is_body_corporate,
      people: app.people.length + 1, referees: app.referees.length, conflict_of_interest: app.coi_declared,
    },
  }, client);
}

const OPEN_FOR_APPLICATION = ["prospect", "applied"];

// What the signed-in agent sees when they open "My application".
async function myApplication(user) {
  const found = await repo.findByPortalUser(user.id);
  if (!found) throw new AppError(404, "We could not find your application.");
  const a = await repo.findById(found.id);
  const [people, referees] = await Promise.all([repo.persons(a.id), repo.referees(a.id)]);
  const me = people.find((p) => p.portal_user_id === user.id);
  return {
    status: a.status,
    submitted: !!a.application_submitted_at,
    submitted_at: a.application_submitted_at,
    editable: OPEN_FOR_APPLICATION.includes(a.status) && !a.application_submitted_at,
    agent: {
      legal_name: a.legal_name, trading_names: a.trading_names, country: a.country, abn_acn: a.abn_acn || "",
      is_body_corporate: a.is_body_corporate, principal_address: a.principal_address || "",
      registered_office_address: a.registered_office_address || "", postal_address: a.postal_address || "",
      business_phone: a.phone || "", website: a.website || "", marn: a.marn || "",
      gst_registered: a.gst_registered, owner_name: a.owner_name || "", staff_count: a.staff_count, years_in_business: a.years_in_business,
    },
    extra: a.application_extra || {},
    declaration_name: a.declaration_name || "",
    applicant: me ? { role: me.role === "director" ? "director" : "staff", marn: me.marn || "", involved_in_enrolments: me.involved_in_enrolments } : null,
    people: people.filter((p) => p.portal_user_id !== user.id).map((p) => ({
      name: p.name, email: p.email, role: p.role, marn: p.marn || "", involved_in_enrolments: p.involved_in_enrolments, location: p.location || "",
    })),
    referees: referees.map((r) => ({ name: r.name, position: r.position || "", organisation: r.organisation, email: r.email, phone: r.phone || "" })),
    missing: [...prismsMissing(a, a.director_count), ...applicationMissing(a, referees.length)],
  };
}

// An agent invited by the college completes the application after signing in.
async function submitApplication(user, body, ctx) {
  const found = await repo.findByPortalUser(user.id);
  if (!found) throw new AppError(404, "We could not find your application.");
  await withTransaction(async (client) => {
    const a = await repo.findById(found.id, client, { lock: true });
    if (a.application_submitted_at) throw new AppError(409, "Your application has already been submitted. Please contact the college to change it.");
    if (!OPEN_FOR_APPLICATION.includes(a.status)) throw new AppError(409, "Your application is no longer open for changes.");
    await saveApplication(client, a.id, user, body);
  });
  return myApplication(user);
}

// BR-02 / E1-2: an agent cannot be approved while a required PRISMS field, a declaration or a referee is missing.
async function approvalMissing(client, userId) {
  const found = await repo.findByPortalUser(userId, client);
  if (!found) return [];
  const a = await repo.findById(found.id, client);
  const referees = await repo.referees(a.id, client);
  return [...prismsMissing(a, a.director_count), ...applicationMissing(a, referees.length)].map((m) => m.label);
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
  recordTerms,
  list, getDetail, meta, createFromEoi, sendApplicationLink, update, changeStatus, remove, restore,
  addPerson, updatePerson, removePerson, recordMilestone, sendAgreement,
  linkNewPortalUser, saveApplication, myApplication, submitApplication, markApplicationReceived, acknowledge, syncDecision, approvalMissing, syncUserStatus, exportCsv, slaFor,
};
