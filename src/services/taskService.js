// ===============================
// Task engine and regulatory onboarding tasks (COMS Block 1, Part 2: E1-6, E1-7, E5).
//   - a countersigned agreement moves the agent to Onboarding and creates the PRISMS, ASQAnet, website
//     and induction tasks with owners and due dates (public holidays honoured)
//   - tasks are finished with evidence; PRISMS and induction feed the BR-01 / BR-02 hard stops
//   - registration tasks have 5 working days; an open one is escalated to a manager on working day 4,
//     and once the deadline has passed only a manager can close it
// ===============================
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { ROLES, STAFF_ROLES, TASK_TYPES, TASK_MANAGERS } = require("../const");
const settings = require("./settingsService");

// used only until the Settings tables exist
const DEFAULT_ONBOARDING = [
  { type: "PRISMS_ADD", title: "Add {agent} to PRISMS", owner_role: ROLES.COMPLIANCE, due_days: 5, due_basis: "business" },
  { type: "ASQANET_START", title: "Report {agent} to ASQAnet", owner_role: ROLES.CEO, due_days: 5, due_basis: "business" },
  { type: "WEBSITE_ADD", title: "List {agent} on the AFC website", owner_role: ROLES.ADMIN, due_days: 5, due_basis: "business" },
  { type: "COMMISSION_REPORT", title: "Record commission and bonus for {agent} and report to Accounts", owner_role: ROLES.MARKETING, due_days: 5, due_basis: "business" },
  { type: "INDUCTION", title: "Induct {agent} and record staff training", owner_role: ROLES.MARKETING, due_days: 30, due_basis: "calendar", prefer_account_manager: true },
];
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
const roleFor = (type) => settings.taskTemplates().find((x) => x.type === type)?.owner_role || TASK_TYPES[type]?.ownerRole;
const canWork = (actor, t) =>
  t.owner_id === actor.id || isManager(actor) || actor.role === (t.owner_role || roleFor(t.type));

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
  if (def.category === "regulatory" && !isManager(actor) && actor.role !== ROLES.COMPLIANCE) throw new AppError(403, "You do not have permission to do that.");
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
  const manager = agent.account_manager_id;
  // what to create comes from Settings (Onboarding tasks), falling back to the built-in list
  const templates = settings.taskTemplates().filter((t) => t.enabled);
  const spec = [];
  for (const t of templates.length ? templates : DEFAULT_ONBOARDING) {
    const due = t.due_basis === "calendar" ? calendar.addDays(today, t.due_days) : await calendar.addBusinessDays(today, t.due_days);
    spec.push([t.type, String(t.title).replace(/\{agent\}/g, agent.legal_name), due, t.due_basis, null, t.owner_role, t.prefer_account_manager ? manager : null]);
  }
  const created = [];
  const people = await agentRepo.persons(agent.id, client);
  const rep = people.find((p) => p.is_primary_contact) || people[0];
  const listing = [
    `Agency: ${agent.legal_name}`,
    ...(agent.trading_names?.length ? [`Trading name: ${agent.trading_names.join(", ")}`] : []),
    `Country: ${agent.country || "-"}`,
    `Address: ${agent.principal_address || agent.registered_office_address || "-"}`,
    `Representative: ${rep?.name || "-"}`,
    `Email: ${rep?.email || agent.email || "-"}`,
    `Phone: ${agent.phone || "-"}`,
  ].join("\n");
  for (const [type, title, due, basis, legal, role, prefer] of spec) {
    const ownerId = await repo.ownerFor(role, prefer);
    const id = await repo.insert(client, {
      category: TASK_TYPES[type].category, type, title, agentId: agent.id, agreementId: agreement.id, triggerEvent: "agreement_countersigned",
      triggerDate: today, dueDate: due, dueBasis: basis, legalDeadline: legal, ownerId, ownerRole: role, actorId,
      description: type === "WEBSITE_ADD" ? `Listing details for the website:\n${listing}` : null,
    });
    if (id) created.push({ id, ownerId, role });
  }
  return created;
}

// Termination: remove the agent from PRISMS and the website, and tell ASQAnet the agreement has ended (same 5 working days)
async function createTerminationTasks(client, agent, actorId, reason) {
  const today = calendar.localDate();
  const due = await calendar.addBusinessDays(today, 5);
  const note = reason ? `Reason for termination: ${reason}` : null;
  const made = [];
  for (const [type, title] of [
    ["PRISMS_REMOVE", `Remove ${agent.legal_name} from PRISMS`],
    ["ASQANET_END", `Report the end of the agreement with ${agent.legal_name} to ASQAnet`],
    ["WEBSITE_REMOVE", `Remove ${agent.legal_name} from the AFC website`],
  ]) {
    const role = roleFor(type) || TASK_TYPES[type].ownerRole;
    const ownerId = await repo.ownerFor(role);
    const id = await repo.insert(client, {
      category: TASK_TYPES[type].category, type, title, description: note, agentId: agent.id, triggerEvent: "agent_terminated",
      triggerDate: today, dueDate: due, dueBasis: "business", ownerId, ownerRole: role, actorId,
    });
    if (id) made.push({ id, ownerId, role });
  }
  await audit.log({ actorId, action: "agent.termination_tasks_created", entityType: "agent", entityId: agent.id, metadata: { tasks: made.length }, }, client);
  return made;
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
  // Phase 3: the welcome email goes out when the agreement is executed, with the way into the online induction
  if (created.length) {
    const u = await repo.userById(ag.user_id);
    const ag2 = await agentRepo.findById(found.id);
    if (u?.email) email.sendAgentWelcome({ to: u.email, firstName: u.first_name, agencyName: ag2?.legal_name || "your agency", link: `${env.frontendUrl}/agent/induction` });
  }
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
  return activated;
}

// ---------- finishing ----------
async function complete(actor, id, { note, file }, ctx) {
  const t0 = await repo.findById(id);
  if (!t0) throw new AppError(404, "Task not found.");
  if (!canWork(actor, t0)) throw new AppError(403, "You do not have permission to do that.");
  if (t0.status !== "open") throw new AppError(409, "This task is already closed.");
  const late = t0.due_date < calendar.localDate();
  if (late && t0.category === "regulatory" && !isManager(actor)) {
    throw new AppError(403, "This task is past its deadline. Only a manager can close it.");
  }
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
      if (t.agent_id && t.type === "INDUCTION") await require("./inductionService").recordFromTask(client, { agentId: t.agent_id, actor, note });
      await audit.log({
        actorId: actor.id, action: "task.completed", entityType: "task", entityId: id,
        before: { status: "open" }, after: { status: "done" },
        metadata: { type: t.type, agent: t.agent_id, evidence: file ? file.name : null, note: note || null, late: t.due_date < calendar.localDate(), manager_override: t.due_date < calendar.localDate() && t.category === "regulatory" }, ...ctx,
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
// Month 11 of an active agreement: open one renewal task per agreement (owner: the account manager, else marketing)
async function createRenewalTasks() {
  const rows = (await require("../config/db").query(
    `SELECT ag.id AS agreement_id, a.id AS agent_id, a.legal_name, a.account_manager_id,
            to_char(ag.expires_at,'YYYY-MM-DD') AS expires_at
       FROM agreements ag
       JOIN agent_persons p ON p.portal_user_id = ag.agent_id AND p.deleted_at IS NULL
       JOIN agents a ON a.id = p.agent_id AND a.deleted_at IS NULL AND a.status IN ('active','under_review')
      WHERE ag.status = 'active' AND ag.effective_date IS NOT NULL
        AND ag.effective_date + interval '11 months' <= CURRENT_DATE AND ag.expires_at >= CURRENT_DATE
        AND NOT EXISTS (SELECT 1 FROM coms_tasks t WHERE t.agreement_id = ag.id AND t.type = 'RENEWAL' AND t.deleted_at IS NULL)
      GROUP BY ag.id, a.id`)).rows;
  const today = calendar.localDate();
  const role = roleFor("RENEWAL") || TASK_TYPES.RENEWAL.ownerRole;
  let n = 0;
  for (const r of rows) {
    const ownerId = await repo.ownerFor(role, r.account_manager_id);
    const id = await repo.insert(require("../config/db"), {
      category: "general", type: "RENEWAL", title: `Review the agreement renewal for ${r.legal_name}`, agentId: r.agent_id, agreementId: r.agreement_id,
      triggerEvent: "agreement_month_11", triggerDate: today, dueDate: r.expires_at, dueBasis: "calendar", ownerId, ownerRole: role, actorId: null,
      description: `The agreement ends on ${r.expires_at}. Decide whether to renew, then send the renewal agreement from the agent record.`,
    });
    if (id) n++;
  }
  return n;
}

async function runAlerts() {
  const today = calendar.localDate();
  const counts = { warned: 0, escalated: 0 };
  const escalateDay = settings.timers().task_escalation_days;
  const managers = await repo.usersWithRoles([ROLES.DIRECTOR]);
  const ceo = await repo.usersWithRoles([ROLES.CEO]);
  const tell = (users, t, level) => users.forEach((u) => email.sendTaskAlert({ to: u.email, firstName: u.first_name, title: t.title, agentName: t.agent_name, dueDate: t.due_date, level, link }));

  for (const t of await repo.openRegulatory()) {
    // the induction task has its own reminders (inductionService); the 5-working-day escalation is for registration tasks only
    if (t.type === "INDUCTION" || t.due_basis !== "business") continue;
    const owner = t.owner_id ? await repo.userById(t.owner_id) : null;
    const ownerList = owner?.status === "active" ? [owner] : [];
    // registration tasks: escalate to a manager on working day 4 (the deadline is working day 5)
    if (!t.escalated_at && (await calendar.businessDaysBetween(t.trigger_day, today)) >= escalateDay) {
      tell(managers.length ? [...managers, ...ceo] : ceo, t, t.due_date < today ? "escalated" : "due_soon");
      await repo.markEscalated(t.id);
      counts.escalated++;
    }
    if (t.due_date < today && !t.warned_at) { tell(ownerList, t, "overdue"); await repo.markWarned(t.id); counts.warned++; }
  }
  return counts;
}

module.exports = {
  list, forAgent, meta, create, createOnboardingTasks, createTerminationTasks, onAgreementCountersigned, maybeActivate, complete, assign, cancel,
  openEvidence, exportCsv, runAlerts, canWork, createRenewalTasks,
};
