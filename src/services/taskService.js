// ===============================
// Task engine and regulatory onboarding tasks (COMS Block 1, Part 2: E1-6, E1-7, E5).
//   - a countersigned agreement moves the agent to Onboarding and creates the PRISMS, ASQAnet, website
//     and induction tasks with owners and due dates (public holidays honoured)
//   - tasks are finished with evidence; PRISMS and induction feed the BR-01 / BR-02 hard stops
//   - overdue tasks are escalated to the manager after 2 working days; ASQAnet alerts at day 20, escalates at day 25 (BR-09)
// ===============================
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { ROLES, STAFF_ROLES, TASK_TYPES, TASK_MANAGERS } = require("../const");
const { parseUpload } = require("../utils/upload");
const { toCsv } = require("../utils/csv");
const repo = require("../repositories/taskRepo");
const ddRepo = require("../repositories/dueDiligenceRepo");
const agentRepo = require("../repositories/comsAgentRepo");
const audit = require("../repositories/auditRepo");
const calendar = require("./calendarService");
const storage = require("./fileStorage");
const email = require("./emailService");

const link = `${env.frontendUrl}/coms/tasks`;
const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });
const isManager = (actor) => TASK_MANAGERS.includes(actor.role);

// who may finish a task: its owner, the role the task type belongs to, or management
const canWork = (actor, t) =>
  t.owner_id === actor.id || isManager(actor) || actor.role === ROLES.COE_ADMIN && TASK_TYPES[t.type]?.ownerRole === ROLES.COE_ADMIN
  || actor.role === ROLES.MARKETING && TASK_TYPES[t.type]?.ownerRole === ROLES.MARKETING;

const withFlags = async (rows) => {
  const today = calendar.localDate();
  return rows.map((t) => ({
    ...t,
    type_label: TASK_TYPES[t.type]?.label || t.title,
    overdue: t.status === "open" && t.due_date < today,
    due_today: t.status === "open" && t.due_date === today,
  }));
};

// ---------- reading ----------
async function list(actor, q) {
  const today = calendar.localDate();
  const { rows, total } = await repo.list({ ...q, today }, actor, { limit: q.limit, offset: (q.page - 1) * q.limit });
  return { rows: await withFlags(rows), total, page: q.page, limit: q.limit };
}
const forAgent = async (agentId) => withFlags(await repo.forAgent(agentId));

async function meta() {
  return {
    types: Object.entries(TASK_TYPES).map(([key, t]) => ({ key, label: t.label, category: t.category })),
    staff: await agentRepo.staffUsers(),
  };
}

// ---------- creating ----------
async function create(actor, body, ctx) {
  if (!STAFF_ROLES.includes(actor.role)) throw new AppError(403, "You do not have permission to do that.");
  const def = TASK_TYPES[body.type];
  if (def.category === "regulatory" && !isManager(actor) && actor.role !== ROLES.COE_ADMIN) throw new AppError(403, "You do not have permission to do that.");
  if (body.agent_id && !(await agentRepo.findById(body.agent_id))) throw fieldError("agent_id", "Agent not found");
  const owner = body.owner_id ? await repo.userById(body.owner_id) : null;
  if (body.owner_id && (!owner || owner.status !== "active" || !STAFF_ROLES.includes(owner.role))) throw fieldError("owner_id", "Choose an active staff member");
  const ownerId = owner?.id || (await repo.ownerFor(def.ownerRole)) || actor.id;
  const today = calendar.localDate();
  if (body.due_date < today) throw fieldError("due_date", "The due date cannot be in the past");

  const id = await withTransaction(async (client) => {
    const taskId = await repo.insert(client, {
      category: def.category, type: body.type, title: body.title, description: body.description, agentId: body.agent_id,
      triggerEvent: "manual", triggerDate: today, dueDate: body.due_date, dueBasis: body.due_basis, ownerId, ownerRole: def.ownerRole, actorId: actor.id,
    });
    await audit.log({ actorId: actor.id, action: "task.created", entityType: "task", entityId: taskId, after: { title: body.title, type: body.type, due: body.due_date, agent: body.agent_id || null }, ...ctx }, client);
    return taskId;
  });
  if (ownerId !== actor.id) await notifyAssigned(ownerId, id);
  return (await withFlags([await repo.findById(id)]))[0];
}

async function notifyAssigned(ownerId, taskId) {
  const [u, t] = await Promise.all([repo.userById(ownerId), repo.findById(taskId)]);
  if (u?.status === "active" && t) email.sendTaskAssigned({ to: u.email, firstName: u.first_name, title: t.title, agentName: t.agent_name, dueDate: t.due_date, link });
}

// E1-6: tasks created when the agreement is countersigned. Safe to run twice (unique index per agreement and type).
async function createOnboardingTasks(client, { agent, agreement, actorId }) {
  const start = agreement.effective_date;                         // agreement start (YYYY-MM-DD)
  const today = calendar.localDate();
  const prisms = await calendar.addBusinessDays(today, 5);        // PRISMS: 5 working days
  const web = await calendar.addBusinessDays(today, 5);           // website: 5 days (working days)
  // Processing Agent Application, step 6: website, ASQAnet and PRISMS within 5 days of signing
  const asqa = await calendar.addBusinessDays(today, 5);
  const asqaLegal = calendar.addDays(start, 30);                  // ESOS reporting backstop (BR-09): alert at day 20, escalate at day 25
  const commission = await calendar.addBusinessDays(today, 5);    // report commission and bonus to Accounts
  const induction = calendar.addDays(today, 30);                  // induction: 30 days after approval (proposed)
  const manager = agent.account_manager_id;
  const spec = [
    ["PRISMS_ADD", `Add ${agent.legal_name} to PRISMS`, prisms, "business", null, ROLES.COE_ADMIN, null],
    ["ASQANET_START", `Report ${agent.legal_name} to ASQAnet`, asqa, "business", asqaLegal, ROLES.COE_ADMIN, null],
    ["WEBSITE_ADD", `List ${agent.legal_name} on the AFC website`, web, "business", null, ROLES.ADMIN, null],
    ["COMMISSION_REPORT", `Record commission and bonus for ${agent.legal_name} and report to Accounts`, commission, "business", null, ROLES.MARKETING, null],
    ["INDUCTION", `Induct ${agent.legal_name} and record staff training`, induction, "calendar", null, ROLES.MARKETING, manager],
  ];
  const created = [];
  for (const [type, title, due, basis, legal, role, prefer] of spec) {
    const ownerId = await repo.ownerFor(role, prefer);
    const id = await repo.insert(client, {
      category: TASK_TYPES[type].category, type, title, agentId: agent.id, agreementId: agreement.id, triggerEvent: "agreement_countersigned",
      triggerDate: today, dueDate: due, dueBasis: basis, legalDeadline: legal, ownerId, ownerRole: role, actorId,
    });
    if (id) created.push({ id, ownerId, role });
  }
  return created;
}

// Called after an agreement is countersigned (outside its transaction: a failure here never undoes the signature).
async function onAgreementCountersigned(agreementId, actor, ctx) {
  const ag = (await require("../config/db").query(
    `SELECT id, agent_id AS user_id, to_char(effective_date,'YYYY-MM-DD') AS effective_date FROM agreements WHERE id = $1 AND status = 'active'`, [agreementId])).rows[0];
  if (!ag) return null;
  const found = await agentRepo.findByPortalUser(ag.user_id);
  if (!found) return null;
  const created = await withTransaction(async (client) => {
    const agent = await agentRepo.findById(found.id, client, { lock: true });
    if (!agent || agent.status !== "approved") return []; // renewals and already-onboarding agents are handled elsewhere
    await agentRepo.setStatus(client, agent.id, "onboarding", actor.id);
    await agentRepo.addHistory(client, { agentId: agent.id, from: "approved", to: "onboarding", reason: "Agreement countersigned", actorId: actor.id });
    const tasks = await createOnboardingTasks(client, { agent, agreement: ag, actorId: actor.id });
    await audit.log({
      actorId: actor.id, action: "agent.onboarding_started", entityType: "agent", entityId: agent.id,
      before: { status: "approved" }, after: { status: "onboarding" }, metadata: { agreementId, tasks: tasks.length }, ...ctx,
    }, client);
    return tasks;
  });
  // step 6: everyone in the responsible team hears about it (for example the CoE administrators), not only the first owner
  for (const t of created) {
    const team = (await repo.usersWithRoles([t.role])).map((u) => u.id);
    for (const uid of new Set([...(t.ownerId ? [t.ownerId] : []), ...team])) if (uid !== actor.id) await notifyAssigned(uid, t.id);
  }
  return created;
}

// E1-7: Active once the agreement, PRISMS and induction are all recorded (BR-01, BR-02)
async function maybeActivate(agentId, actor, ctx) {
  const activated = await withTransaction(async (client) => {
    const a = await agentRepo.findById(agentId, client, { lock: true });
    if (!a || a.status !== "onboarding" || !a.prisms_recorded_at || !a.induction_recorded_at) return false;
    if (!(await agentRepo.hasSignedAgreement(agentId, client))) return false;
    await agentRepo.setStatus(client, agentId, "active", actor.id);
    await agentRepo.addHistory(client, { agentId, from: "onboarding", to: "active", reason: "Agreement, PRISMS and induction are recorded", actorId: actor.id });
    await audit.log({ actorId: actor.id, action: "agent.activated", entityType: "agent", entityId: agentId, before: { status: "onboarding" }, after: { status: "active" }, ...ctx }, client);
    return true;
  });
  // the certificate of appointment goes to the agent once onboarding is finished
  if (activated) await require("./certificateService").onActivated(agentId, actor, ctx);
  return activated;
}

// ---------- finishing ----------
async function complete(actor, id, { note, file }, ctx) {
  const t0 = await repo.findById(id);
  if (!t0) throw new AppError(404, "Task not found.");
  if (!canWork(actor, t0)) throw new AppError(403, "You do not have permission to do that.");
  if (t0.status !== "open") throw new AppError(409, "This task is already closed.");
  if (t0.category === "regulatory" && !file && !String(note || "").trim()) {
    throw fieldError("note", "Add evidence (a file) or a note saying what was done");
  }
  let key = null;
  try {
    await withTransaction(async (client) => {
      const t = await repo.findById(id, client, { lock: true });
      if (!t || t.status !== "open") throw new AppError(409, "This task is already closed.");
      let fileId = null;
      if (file) {
        const up = parseUpload(file);
        const saved = await storage.save(up.buffer, up.ext, "coms");
        key = saved.key;
        fileId = await ddRepo.insertFile(client, { kind: "task_evidence", name: up.name, ...saved, mime: up.mime, actorId: actor.id });
      }
      if (t.type === "COMMISSION_REPORT") {
        const ag = await agentRepo.findById(t.agent_id, client);
        if (!ag || !ag.commission_terms) throw fieldError("note", "Record the commission and bonus on the agent record first. That also sends them to Accounts.");
      }
      await repo.complete(client, id, { note, fileId }, actor.id);
      if (t.agent_id && t.type === "PRISMS_ADD") await agentRepo.setMilestone(client, t.agent_id, "prisms", new Date(), actor.id);
      if (t.agent_id && t.type === "INDUCTION") await agentRepo.setMilestone(client, t.agent_id, "induction", new Date(), actor.id);
      await audit.log({
        actorId: actor.id, action: "task.completed", entityType: "task", entityId: id,
        before: { status: "open" }, after: { status: "done" },
        metadata: { type: t.type, agent: t.agent_id, evidence: file ? file.name : null, note: note || null, late: t.due_date < calendar.localDate() }, ...ctx,
      }, client);
    });
  } catch (err) {
    if (key) await storage.remove(key);
    throw err;
  }
  if (t0.agent_id) await maybeActivate(t0.agent_id, actor, ctx);
  return (await withFlags([await repo.findById(id)]))[0];
}

async function assign(actor, id, ownerId, ctx) {
  if (!isManager(actor)) throw new AppError(403, "You do not have permission to do that.");
  const t = await repo.findById(id);
  if (!t) throw new AppError(404, "Task not found.");
  if (t.status !== "open") throw new AppError(409, "This task is already closed.");
  const u = await repo.userById(ownerId);
  if (!u || u.status !== "active" || !STAFF_ROLES.includes(u.role)) throw fieldError("owner_id", "Choose an active staff member");
  await withTransaction(async (client) => {
    await repo.assign(client, id, ownerId, actor.id);
    await audit.log({ actorId: actor.id, action: "task.assigned", entityType: "task", entityId: id, before: { owner: t.owner_name }, after: { owner: `${u.first_name} ${u.last_name}`.trim() }, ...ctx }, client);
  });
  if (ownerId !== actor.id) await notifyAssigned(ownerId, id);
  return (await withFlags([await repo.findById(id)]))[0];
}

async function cancel(actor, id, reason, ctx) {
  if (!isManager(actor)) throw new AppError(403, "You do not have permission to do that.");
  if (!String(reason || "").trim()) throw fieldError("reason", "Please give a reason");
  const t = await repo.findById(id);
  if (!t) throw new AppError(404, "Task not found.");
  if (t.status !== "open") throw new AppError(409, "This task is already closed.");
  await withTransaction(async (client) => {
    await repo.cancel(client, id, reason, actor.id);
    await audit.log({ actorId: actor.id, action: "task.cancelled", entityType: "task", entityId: id, before: { status: "open" }, after: { status: "cancelled" }, metadata: { reason }, ...ctx }, client);
  });
  return (await withFlags([await repo.findById(id)]))[0];
}

async function openEvidence(actor, taskId, ctx) {
  const t = await repo.findById(taskId);
  if (!t?.evidence_file_id) throw new AppError(404, "File not found.");
  return require("./dueDiligenceService").openFile(actor, t.evidence_file_id, ctx);
}

// ---------- export (NF-13) ----------
async function exportCsv(actor, q, ctx) {
  const rows = await withFlags(await repo.listAll({ ...q, today: calendar.localDate() }, actor, 5000));
  const csv = toCsv(
    ["Task", "Type", "Category", "Agent", "Owner", "Due", "Due basis", "Legal deadline", "Status", "Overdue", "Escalated", "Completed", "Completed by", "Note"],
    rows.map((t) => [
      t.title, t.type_label, t.category, t.agent_name, t.owner_name, t.due_date, t.due_basis, t.legal_deadline, t.status,
      t.overdue ? "Yes" : "No", t.escalated_at ? "Yes" : "No", t.completed_at && calendar.localDate(t.completed_at), t.completed_by_name, t.completion_note,
    ]),
  );
  await audit.log({ actorId: actor.id, action: "task.exported", entityType: "task", metadata: { rows: rows.length, filters: { ...q, page: undefined, today: undefined } }, ...ctx });
  return csv;
}

// ---------- reminders and escalation (daily job) ----------
async function runAlerts() {
  const today = calendar.localDate();
  const counts = { warned: 0, escalated: 0 };
  const managers = await repo.usersWithRoles([ROLES.DIRECTOR]);
  const ceo = await repo.usersWithRoles([ROLES.CEO]);
  const compliance = await repo.usersWithRoles([ROLES.COMPLIANCE]);
  const tell = (users, t, level) => users.forEach((u) => email.sendTaskAlert({ to: u.email, firstName: u.first_name, title: t.title, agentName: t.agent_name, dueDate: t.due_date, level, link }));

  for (const t of await repo.openRegulatory()) {
    const owner = t.owner_id ? await repo.userById(t.owner_id) : null;
    const ownerList = owner?.status === "active" ? [owner] : [];
    if (t.type === "ASQANET_START" || t.type === "ASQANET_END") {
      // BR-09: alert at day 20, escalate at day 25 (calendar days from the trigger)
      const day = Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${t.trigger_day}T00:00:00Z`)) / 86400000);
      if (day >= 25 && !t.escalated_at) { tell([...managers, ...ceo, ...compliance], t, "escalated"); await repo.markEscalated(t.id); counts.escalated++; }
      else if (day >= 20 && !t.warned_at) { tell(ownerList.length ? ownerList : compliance, t, "overdue"); await repo.markWarned(t.id); counts.warned++; }
      continue;
    }
    if (t.due_date >= today) continue;
    if (!t.warned_at) { tell(ownerList, t, "overdue"); await repo.markWarned(t.id); counts.warned++; }
    // escalation to the manager 2 working days after the due date
    if (!t.escalated_at && (await calendar.businessDaysBetween(t.due_date, today)) >= 2) {
      tell(managers.length ? managers : ceo, t, "escalated");
      await repo.markEscalated(t.id);
      counts.escalated++;
    }
  }
  return counts;
}

module.exports = {
  list, forAgent, meta, create, createOnboardingTasks, onAgreementCountersigned, maybeActivate, complete, assign, cancel,
  openEvidence, exportCsv, runAlerts, canWork,
};
