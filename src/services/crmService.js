// ===============================================================
// Agent CRM (Phase 4, client requirements document)
//   - communication log: every email, call and meeting with an agent is recorded (mandatory); inbound email is logged automatically
//   - leads: agents log the students they talk to (name, country, course, contact date, outcome)
//   - training records, the 6-monthly Agent Monitoring Form (and the recurring task that asks for it)
//   - corrective action notices: drafted from the monitoring notes, reviewed and sent by staff, then tracked to the end
//   - broadcasts: product, fee and policy updates; a person approves, the system sends to every active agent and records each delivery
//   - 7-year retention: nothing here can be deleted (database triggers)
// "Drafts" are fixed templates filled from what staff type (crmDrafts.js). Nothing leaves the system until a person approves it.
// ===============================================================
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction, query } = require("../config/db");
const { ROLES, CRM_PERMS, COMM_TYPES } = require("../const");
const repo = require("../repositories/crmRepo");
const oiRepo = require("../repositories/onlineInductionRepo");
const agentRepo = require("../repositories/comsAgentRepo");
const taskRepo = require("../repositories/taskRepo");
const audit = require("../repositories/auditRepo");
const email = require("./emailService");
const calendar = require("./calendarService");
const drafts = require("./crmDrafts");

const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });
const can = (actor, perm) => CRM_PERMS[perm].includes(actor.role);
const need = (actor, perm) => {
  if (!can(actor, perm)) throw new AppError(403, "You do not have permission to do that.");
};
const ELIGIBLE = ["approved", "onboarding", "active", "under_review"];

async function liveAgent(agentId) {
  const a = await agentRepo.findById(agentId);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  return a;
}
async function agentFor(user) {
  const found = await agentRepo.findByPortalUser(user.id);
  const a = found && (await agentRepo.findById(found.id));
  if (!a || a.deleted_at) throw new AppError(404, "We could not find your application.");
  return a;
}
const parseWhen = (value) => {
  if (!value) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw fieldError("occurred_at", "Enter a valid date and time");
  if (d.getTime() > Date.now() + 5 * 60 * 1000) throw fieldError("occurred_at", "A communication cannot be dated in the future");
  return d;
};
const commView = (c, actor) => ({
  ...c,
  type_label: COMM_TYPES[c.type] || c.type,
  can_edit: !!actor && c.source === "staff" && (can(actor, "editComms") || c.staff_id === actor.id),
});

// ===================== communications =====================
async function listComms(actor, agentId) {
  await liveAgent(agentId);
  return (await repo.comms(agentId)).map((c) => commView(c, actor));
}

async function logComm(actor, agentId, body, ctx) {
  need(actor, "logComms");
  await liveAgent(agentId);
  // the agent can read every entry in their own log (client requirement), including file notes
  const direction = body.type === "note" ? "internal" : body.direction === "inbound" ? "inbound" : "outbound";
  const id = await repo.insertComm(null, {
    agentId, type: body.type, direction, occurredAt: parseWhen(body.occurred_at), staffId: actor.id, subject: body.subject, summary: body.summary, source: "staff",
  });
  await audit.log({ actorId: actor.id, action: "agent.communication_logged", entityType: "agent", entityId: agentId, metadata: { type: body.type, direction, communication: id }, ...ctx });
  return commView(await repo.commById(id), actor);
}

async function editComm(actor, agentId, commId, body, ctx) {
  const c = await repo.commById(commId);
  if (!c || c.agent_id !== agentId) throw new AppError(404, "Communication not found.");
  if (c.source !== "staff") throw new AppError(409, "System entries and logged emails cannot be edited.");
  if (!(can(actor, "editComms") || c.staff_id === actor.id)) throw new AppError(403, "You do not have permission to do that.");
  const direction = body.type === "note" ? "internal" : body.direction === "inbound" ? "inbound" : "outbound";
  await repo.updateComm(null, commId, { type: body.type, direction, occurredAt: parseWhen(body.occurred_at || c.occurred_at), subject: body.subject, summary: body.summary }, actor.id);
  await audit.log({
    actorId: actor.id, action: "agent.communication_edited", entityType: "agent", entityId: agentId,
    before: { type: c.type, subject: c.subject, summary: c.summary }, after: { type: body.type, subject: body.subject || null, summary: body.summary }, metadata: { communication: commId }, ...ctx,
  });
  return commView(await repo.commById(commId), actor);
}

// the other half of the log: email that arrives from, or is sent to, an agent is recorded without anyone typing it
async function logEmail(body) {
  const clean = (v) => String(v || "").trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1");
  const from = clean(body.from);
  const tos = (Array.isArray(body.to) ? body.to : String(body.to || "").split(",")).map(clean).filter(Boolean);
  let agent = await repo.agentByEmail(from);
  let direction = "inbound";
  let staff = null;
  if (!agent) {
    for (const t of tos) { agent = await repo.agentByEmail(t); if (agent) break; }
    if (agent) { direction = "outbound"; staff = await repo.staffByEmail(from); }
  }
  if (!agent) {
    await audit.log({ action: "email.unmatched", entityType: "email", entityId: body.message_id || null, metadata: { from, subject: body.subject || null } });
    return { matched: false };
  }
  const when = body.date && !Number.isNaN(new Date(body.date).getTime()) ? new Date(body.date) : new Date();
  const text = String(body.text || "").replace(/\s+\n/g, "\n").trim();
  const summary = (text.length > 4000 ? `${text.slice(0, 4000)}\n[shortened]` : text) || "(no text)";
  const id = await repo.insertComm(null, {
    agentId: agent.id, type: "email", direction, occurredAt: when, staffId: staff?.id || null, subject: (body.subject || "").slice(0, 200) || null, summary, source: "inbound_email", externalId: body.message_id || null,
  });
  if (id) await audit.log({ action: "agent.email_logged", entityType: "agent", entityId: agent.id, metadata: { direction, communication: id } });
  return { matched: true, logged: !!id };
}

// ===================== leads =====================
async function myLeads(user) {
  const a = await agentFor(user);
  return { eligible: ELIGIBLE.includes(a.status), leads: await repo.leads(a.id) };
}
function checkLeadDate(v) {
  if (v > calendar.localDate()) throw fieldError("contact_date", "The contact date cannot be in the future");
}
async function addLead(user, body, ctx) {
  const a = await agentFor(user);
  if (!ELIGIBLE.includes(a.status)) throw new AppError(409, "You can log leads once the college has approved your application.");
  checkLeadDate(body.contact_date);
  const id = await repo.insertLead(null, { ...body, agentId: a.id, actorId: user.id });
  await audit.log({ actorId: user.id, action: "lead.created", entityType: "agent_lead", entityId: id, metadata: { agent: a.id, outcome: body.outcome }, ...ctx });
  return repo.leadById(id);
}
async function updateLead(user, id, body, ctx) {
  const a = await agentFor(user);
  const before = await repo.leadById(id);
  if (!before || before.agent_id !== a.id) throw new AppError(404, "Lead not found."); // an agent only ever sees their own
  if (before.application_id) throw new AppError(409, "This lead has become an application and can no longer be changed here.");
  checkLeadDate(body.contact_date);
  await repo.updateLead(null, id, body, user.id);
  const fields = ["student_name", "country", "course_interest", "contact_date", "outcome", "notes"];
  await audit.log({
    actorId: user.id, action: "lead.updated", entityType: "agent_lead", entityId: id,
    before: Object.fromEntries(fields.map((f) => [f, before[f] ?? null])), after: Object.fromEntries(fields.map((f) => [f, body[f] ?? null])), metadata: { agent: a.id }, ...ctx,
  });
  return repo.leadById(id);
}
const staffLeads = async (actor, agentId) => { await liveAgent(agentId); return repo.leads(agentId); };

// ===================== training =====================
async function listTraining(actor, agentId) {
  await liveAgent(agentId);
  const manual = await repo.training(agentId);
  // the induction is training too: show it here without keeping a second copy
  const sessions = (await query(
    `SELECT to_char(held_on,'YYYY-MM-DD') AS held_on, mode, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS by
       FROM agent_inductions i LEFT JOIN users u ON u.id = i.conducted_by WHERE i.agent_id = $1 AND i.status = 'held' ORDER BY held_on DESC`, [agentId])).rows;
  const a = await agentRepo.findById(agentId);
  const system = sessions.map((s) => ({ id: null, title: "Agent induction session", kind: "induction", held_on: s.held_on, delivered_by: s.by || null, notes: s.mode ? `Held ${String(s.mode).replace("_", " ")}.` : null, source: "system" }));
  if (a.induction_recorded_at && !system.length) {
    system.push({ id: null, title: "Online induction (modules and policy acknowledgement)", kind: "induction", held_on: new Date(a.induction_recorded_at).toISOString().slice(0, 10), delivered_by: null, notes: "Confirmed by staff.", source: "system" });
  }
  return [...manual.map((m) => ({ ...m, source: "staff" })), ...system].sort((x, y) => String(y.held_on).localeCompare(String(x.held_on)));
}
async function addTraining(actor, agentId, body, ctx) {
  need(actor, "training");
  await liveAgent(agentId);
  if (body.held_on > calendar.localDate()) throw fieldError("held_on", "The date cannot be in the future");
  const id = await repo.insertTraining(null, { ...body, agentId, actorId: actor.id });
  await audit.log({ actorId: actor.id, action: "agent.training_recorded", entityType: "agent", entityId: agentId, metadata: { title: body.title, training: id }, ...ctx });
  return { id };
}
const myTraining = async (user) => listTraining(user, (await agentFor(user)).id);

// ===================== monitoring =====================
async function monitoring(actor, agentId) {
  await liveAgent(agentId);
  const [reviews, correctives, task, agreement] = await Promise.all([repo.reviews(agentId), repo.correctives(agentId), repo.openMonitoringTask(null, agentId), repo.currentAgreement(agentId)]);
  const last = reviews[0];
  const start = last ? await query(`SELECT to_char($1::date + 1,'YYYY-MM-DD') AS d`, [last.period_end]).then((r) => r.rows[0].d) : agreement?.effective_date || null;
  const end = task?.due_date || calendar.localDate();
  const counts = start ? await repo.leadCounts(agentId, start, end) : { total: 0, submitted: 0 };
  return {
    reviews, corrective_actions: correctives,
    prefill: { period_start: start, period_end: end, applications_submitted: counts.submitted, leads_logged: counts.total, task_id: task?.id || null },
    can_edit: can(actor, "monitoring"),
  };
}

async function createReview(actor, agentId, body, ctx) {
  need(actor, "monitoring");
  const agent = await liveAgent(agentId);
  if (body.period_end < body.period_start) throw fieldError("period_end", "The period cannot end before it starts");
  if (body.period_end > calendar.localDate()) throw fieldError("period_end", "The period cannot end in the future");
  if (body.incidents_found && !body.incidents_detail) throw fieldError("incidents_detail", "Describe the incident");
  if (body.unauthorised_advice_found && !body.unauthorised_advice_detail) throw fieldError("unauthorised_advice_detail", "Describe the advice that was identified");
  const outcome = body.incidents_found || body.unauthorised_advice_found ? "issues_found" : body.outcome || "satisfactory";
  const agreement = await repo.currentAgreement(agentId);
  let id;
  await withTransaction(async (client) => {
    const task = await repo.openMonitoringTask(client, agentId);
    id = await repo.insertReview(client, { ...body, outcome, agentId, agreementId: agreement?.id, taskId: task?.id, actorId: actor.id });
    if (task) await taskRepo.complete(client, task.id, { note: `Agent Monitoring Form completed (${outcome === "satisfactory" ? "satisfactory" : "issues found"}).` }, actor.id);
    await repo.insertComm(client, {
      agentId, type: "note", direction: "internal", occurredAt: new Date(), staffId: actor.id, source: "system",
      subject: "6-monthly monitoring review",
      summary: `Monitoring form completed for ${body.period_start} to ${body.period_end}. Outcome: ${outcome === "satisfactory" ? "satisfactory" : "issues found"}.`,
    });
    await audit.log({ actorId: actor.id, action: "agent.monitoring_review", entityType: "agent", entityId: agentId, metadata: { review: id, outcome, period_end: body.period_end, task: task?.id || null }, ...ctx }, client);
  });
  return { review: await repo.reviewById(id), agent: agent.legal_name };
}

// the recurring task: every six months from the day the agreement started, marketing completes the monitoring form
async function createMonitoringTasks() {
  const rows = (await query(
    `SELECT ag.id AS agreement_id, a.id AS agent_id, a.legal_name, a.account_manager_id, g.n,
            to_char((ag.effective_date + make_interval(months => 6 * g.n))::date, 'YYYY-MM-DD') AS due
       FROM agreements ag
       JOIN agent_persons p ON p.portal_user_id = ag.agent_id AND p.deleted_at IS NULL
       JOIN agents a ON a.id = p.agent_id AND a.deleted_at IS NULL AND a.status IN ('active', 'under_review')
       CROSS JOIN generate_series(1, 2) AS g(n)
      WHERE ag.status = 'active' AND ag.effective_date IS NOT NULL
        AND CURRENT_DATE >= (ag.effective_date + make_interval(months => 6 * g.n))::date - 14
        AND CURRENT_DATE <= (ag.effective_date + make_interval(months => 6 * g.n))::date + 90
        AND NOT EXISTS (SELECT 1 FROM coms_tasks t WHERE t.agreement_id = ag.id AND t.type = 'MONITORING' AND t.trigger_event = 'monitoring_period_' || g.n AND t.deleted_at IS NULL)
      GROUP BY ag.id, a.id, g.n`)).rows;
  const role = ROLES.MARKETING;
  const today = calendar.localDate();
  let n = 0;
  for (const r of rows) {
    const ownerId = await taskRepo.ownerFor(role, r.account_manager_id);
    const id = await taskRepo.insert(require("../config/db"), {
      category: "general", type: "MONITORING", title: `Complete the 6-monthly monitoring form for ${r.legal_name}`, agentId: r.agent_id, agreementId: r.agreement_id,
      triggerEvent: `monitoring_period_${r.n}`, triggerDate: today, dueDate: r.due, dueBasis: "calendar", ownerId, ownerRole: role, actorId: null,
      description: "Open the agent record, go to the Monitoring tab and complete the Agent Monitoring Form. Saving the form closes this task.",
    });
    if (id) n++;
  }
  return n;
}

// ===================== corrective actions =====================
const caView = (c) => ({ ...c });
async function createCorrective(actor, agentId, body, ctx) {
  need(actor, "monitoring");
  const agent = await liveAgent(agentId);
  if (body.due_date < calendar.localDate()) throw fieldError("due_date", "Choose a date that is not in the past");
  let periodEnd = null;
  if (body.review_id) {
    const r = await repo.reviewById(body.review_id);
    if (!r || r.agent_id !== agentId) throw fieldError("review_id", "Review not found");
    periodEnd = r.period_end;
  }
  const d = drafts.draftCorrectiveNotice({ agentName: agent.legal_name, issues: body.issues, requiredActions: body.required_actions, dueDate: body.due_date, periodEnd });
  const id = await repo.insertCorrective(null, {
    agentId, reviewId: body.review_id, issues: body.issues, required_actions: body.required_actions, due_date: body.due_date,
    subject: body.notice_subject || d.subject, body: body.notice_body || d.body, actorId: actor.id,
  });
  await audit.log({ actorId: actor.id, action: "corrective_action.drafted", entityType: "agent", entityId: agentId, metadata: { corrective_action: id }, ...ctx });
  return caView(await repo.correctiveById(id));
}
async function loadCorrective(agentId, actionId, statuses) {
  const c = await repo.correctiveById(actionId);
  if (!c || c.agent_id !== agentId) throw new AppError(404, "Notice not found.");
  if (statuses && !statuses.includes(c.status)) throw new AppError(409, `This notice is already ${c.status.replace("_", " ")}.`);
  return c;
}
async function updateCorrective(actor, agentId, actionId, body, ctx) {
  need(actor, "monitoring");
  const c = await loadCorrective(agentId, actionId, ["draft"]);
  if (body.due_date < calendar.localDate()) throw fieldError("due_date", "Choose a date that is not in the past");
  await repo.updateCorrectiveDraft(null, actionId, {
    issues: body.issues, required_actions: body.required_actions, due_date: body.due_date, subject: body.notice_subject || c.notice_subject, body: body.notice_body || c.notice_body,
  });
  await audit.log({ actorId: actor.id, action: "corrective_action.edited", entityType: "agent", entityId: agentId, metadata: { corrective_action: actionId }, ...ctx });
  return caView(await repo.correctiveById(actionId));
}
// regenerate the wording from the issues (after staff change them)
async function redraftCorrective(actor, agentId, actionId) {
  need(actor, "monitoring");
  const c = await loadCorrective(agentId, actionId, ["draft"]);
  const a = await liveAgent(agentId);
  const d = drafts.draftCorrectiveNotice({ agentName: a.legal_name, issues: c.issues, requiredActions: c.required_actions, dueDate: c.due_date });
  return d;
}
async function sendCorrective(actor, agentId, actionId, ctx) {
  need(actor, "monitoring");
  const c = await loadCorrective(agentId, actionId, ["draft"]);
  const to = await repo.agentPrimary(agentId);
  if (!to?.email) throw new AppError(409, "This agent has no email address on record.");
  await withTransaction(async (client) => {
    await repo.markCorrectiveSent(client, actionId, actor.id, to.email);
    await repo.insertComm(client, { agentId, type: "corrective_action", direction: "outbound", occurredAt: new Date(), staffId: actor.id, subject: c.notice_subject, summary: c.notice_body, source: "system" });
    await audit.log({ actorId: actor.id, action: "corrective_action.sent", entityType: "agent", entityId: agentId, metadata: { corrective_action: actionId, to: to.email, due_date: c.due_date }, ...ctx }, client);
  });
  email.sendCorrectiveAction({ to: to.email, firstName: to.first_name, subject: c.notice_subject, body: c.notice_body, link: `${env.frontendUrl}/agent/communications` });
  return caView(await repo.correctiveById(actionId));
}
async function resolveCorrective(actor, agentId, actionId, outcome, note, ctx) {
  need(actor, "monitoring");
  await loadCorrective(agentId, actionId, ["sent"]);
  const agent = await liveAgent(agentId);
  await repo.resolveCorrective(null, actionId, outcome, actor.id, note);
  await audit.log({ actorId: actor.id, action: `corrective_action.${outcome}`, entityType: "agent", entityId: agentId, metadata: { corrective_action: actionId, note }, ...ctx });
  if (outcome === "not_implemented") {
    const people = await taskRepo.usersWithRoles([ROLES.DIRECTOR, ROLES.CEO]);
    for (const u of people) email.sendCorrectiveStaffAlert({ to: u.email, firstName: u.first_name, agentName: agent.legal_name, level: "not_implemented", dueDate: null, link: `${env.frontendUrl}/coms/agents/${agentId}` });
  }
  return caView(await repo.correctiveById(actionId));
}
async function cancelCorrective(actor, agentId, actionId, reason, ctx) {
  need(actor, "monitoring");
  await loadCorrective(agentId, actionId, ["draft"]);
  await repo.resolveCorrective(null, actionId, "cancelled", actor.id, reason);
  await audit.log({ actorId: actor.id, action: "corrective_action.cancelled", entityType: "agent", entityId: agentId, metadata: { corrective_action: actionId, reason }, ...ctx });
  return caView(await repo.correctiveById(actionId));
}
// daily: a sent notice whose date has passed without being closed is a possible termination ground: tell the managers once
async function runCorrectiveAlerts() {
  const people = await taskRepo.usersWithRoles([ROLES.DIRECTOR, ROLES.CEO]);
  let n = 0;
  for (const c of await repo.overdueCorrectives()) {
    const owner = c.account_manager_id ? await taskRepo.userById(c.account_manager_id) : null;
    const to = owner?.status === "active" ? [...people, owner] : people;
    for (const u of to) email.sendCorrectiveStaffAlert({ to: u.email, firstName: u.first_name, agentName: c.legal_name, level: "overdue", dueDate: c.due_date, link: `${env.frontendUrl}/coms/agents/${c.agent_id}` });
    await repo.markCorrectiveAlerted(c.id);
    await audit.log({ action: "corrective_action.overdue", entityType: "agent", entityId: c.agent_id, metadata: { corrective_action: c.id, due_date: c.due_date } });
    n++;
  }
  return n;
}

// ===================== broadcasts =====================
async function listBroadcasts(actor) {
  need(actor, "draftBroadcast");
  return (await repo.broadcasts()).map((b) => ({ ...b, can_approve: can(actor, "approveBroadcast") }));
}
async function getBroadcast(actor, id) {
  need(actor, "draftBroadcast");
  const b = await repo.broadcastById(id);
  if (!b) throw new AppError(404, "Update not found.");
  return { ...b, can_approve: can(actor, "approveBroadcast"), deliveries: await repo.broadcastDeliveries(id) };
}
async function createBroadcast(actor, body, ctx) {
  need(actor, "draftBroadcast");
  const d = drafts.draftBroadcast({ kind: body.kind, whatChanged: body.what_changed, effectiveDate: body.effective_date });
  const subject = body.subject || d.subject;
  const text = body.body || d.body;
  const id = await repo.insertBroadcast(null, { kind: body.kind, subject, body: text, actorId: actor.id });
  await audit.log({ actorId: actor.id, action: "broadcast.drafted", entityType: "marketing_broadcast", entityId: id, metadata: { subject }, ...ctx });
  return getBroadcast(actor, id);
}
async function updateBroadcast(actor, id, body, ctx) {
  need(actor, "draftBroadcast");
  const b = await repo.broadcastById(id);
  if (!b) throw new AppError(404, "Update not found.");
  if (b.status !== "draft") throw new AppError(409, "Only a draft can be changed.");
  await repo.updateBroadcast(null, id, { kind: body.kind, subject: body.subject || b.subject, body: body.body || b.body });
  await audit.log({ actorId: actor.id, action: "broadcast.edited", entityType: "marketing_broadcast", entityId: id, before: { subject: b.subject, body: b.body }, after: { subject: body.subject || b.subject, body: body.body || b.body }, ...ctx });
  return getBroadcast(actor, id);
}
async function cancelBroadcast(actor, id, ctx) {
  need(actor, "draftBroadcast");
  const b = await repo.broadcastById(id);
  if (!b) throw new AppError(404, "Update not found.");
  if (b.status !== "draft") throw new AppError(409, "Only a draft can be cancelled.");
  await repo.setBroadcastStatus(null, id, "cancelled", actor.id);
  await audit.log({ actorId: actor.id, action: "broadcast.cancelled", entityType: "marketing_broadcast", entityId: id, ...ctx });
  return getBroadcast(actor, id);
}
// send to every active agent not yet reached; each delivery is recorded with its time and shows in the agent's communication history
async function distribute(b, actorId) {
  const already = await repo.deliveredAgents(b.id);
  let sent = 0;
  for (const r of await oiRepo.noticeRecipients()) {
    if (!r.email || already.has(r.id)) continue;
    email.sendBroadcast({ to: r.email, firstName: r.first_name, subject: b.subject, body: b.body, link: `${env.frontendUrl}/agent/communications` });
    await repo.insertBroadcastDelivery(b.id, r.id, r.email);
    await repo.insertComm(null, { agentId: r.id, type: "broadcast", direction: "outbound", occurredAt: new Date(), staffId: actorId || null, subject: b.subject, summary: b.body, source: "system" });
    sent++;
  }
  const total = (await repo.broadcastDeliveries(b.id)).length;
  await repo.markBroadcastSent(b.id, total);
  return { sent, total };
}
async function approveBroadcast(actor, id, ctx) {
  need(actor, "approveBroadcast");
  const b = await repo.broadcastById(id);
  if (!b) throw new AppError(404, "Update not found.");
  if (b.status !== "draft") throw new AppError(409, `This update is already ${b.status}.`);
  await withTransaction(async (client) => {
    await repo.setBroadcastStatus(client, id, "approved", actor.id);
    await audit.log({ actorId: actor.id, action: "broadcast.approved", entityType: "marketing_broadcast", entityId: id, metadata: { subject: b.subject }, ...ctx }, client);
  });
  const r = await distribute(b, actor.id);
  await audit.log({ actorId: actor.id, action: "broadcast.sent", entityType: "marketing_broadcast", entityId: id, metadata: { agents: r.total }, ...ctx });
  return getBroadcast(actor, id);
}
// daily safety net for the 24-hour duty: an approved update that did not finish sending is finished now
async function runBroadcastRetries() {
  let sent = 0;
  for (const b of await repo.stuckBroadcasts()) {
    const r = await distribute(b, b.approved_by);
    sent += r.sent;
    if (Date.now() - new Date(b.approved_at).getTime() > 24 * 3600 * 1000) {
      await audit.log({ action: "broadcast.notice_late", entityType: "marketing_broadcast", entityId: b.id, metadata: { note: "Agents were told more than 24 hours after approval (finished by the daily job)." } });
    }
  }
  return sent;
}

// ===================== the agent's own history (read-only) =====================
async function myCommunications(user) {
  const a = await agentFor(user);
  const comms = (await repo.comms(a.id, { forAgent: true })).map((c) => ({
    id: c.id, type: c.type, type_label: COMM_TYPES[c.type] || c.type, direction: c.direction, occurred_at: c.occurred_at, subject: c.subject, summary: c.summary, staff_name: c.staff_name || null,
  }));
  const correctives = (await repo.correctives(a.id)).filter((c) => c.status !== "draft" && c.status !== "cancelled").map((c) => ({ id: c.id, subject: c.notice_subject, due_date: c.due_date, status: c.status, sent_at: c.sent_at, overdue: c.overdue }));
  return { communications: comms, training: await listTraining(user, a.id), corrective_actions: correctives };
}

const summary = (agentId) => repo.summary(agentId);

module.exports = {
  listComms, logComm, editComm, logEmail,
  myLeads, addLead, updateLead, staffLeads,
  listTraining, addTraining, myTraining,
  monitoring, createReview, createMonitoringTasks,
  createCorrective, updateCorrective, redraftCorrective, sendCorrective, resolveCorrective, cancelCorrective, runCorrectiveAlerts,
  listBroadcasts, getBroadcast, createBroadcast, updateBroadcast, cancelBroadcast, approveBroadcast, runBroadcastRetries,
  myCommunications, summary,
};
