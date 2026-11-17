// ===============================
// Agent induction (Phase 3).
//   - staff schedule an induction (date, who runs it, how) and later record that it was held (date, who ran it, attendees, notes)
//   - a held induction sets the BR-02 milestone, finishes the INDUCTION task and activates the agent once the agreement
//     and PRISMS are also in place (E1-7)
//   - reminders: the person running a scheduled induction hears the day before, and again if the outcome is not recorded;
//     the INDUCTION task owner is reminded a week before the deadline and when it is overdue
// ===============================
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { ROLES, STAFF_ROLES, AGENT_PERMS } = require("../const");
const repo = require("../repositories/inductionRepo");
const agentRepo = require("../repositories/comsAgentRepo");
const taskRepo = require("../repositories/taskRepo");
const audit = require("../repositories/auditRepo");
const calendar = require("./calendarService");
const email = require("./emailService");

const ENTITY = "agent";
const REMIND_DAYS_BEFORE_DUE = 7; // the induction task owner is reminded this many days before the deadline
const ELIGIBLE = ["approved", "onboarding", "active", "under_review"];
const MODE_LABEL = { online: "online", in_person: "in person", phone: "by phone" };

const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });
const need = (actor) => {
  if (!AGENT_PERMS.recordInduction.includes(actor.role)) throw new AppError(403, "You do not have permission to do that.");
};
const noon = (day) => new Date(`${day}T12:00:00`);

async function loadAgent(id) {
  const a = await agentRepo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  if (!ELIGIBLE.includes(a.status)) throw new AppError(409, "An induction can only be recorded for an approved agent.");
  return a;
}
async function staffMember(id, field = "conducted_by") {
  const u = await taskRepo.userById(id);
  if (!u || u.status !== "active" || !STAFF_ROLES.includes(u.role)) throw fieldError(field, "Choose an active staff member");
  return u;
}
const fullName = (u) => `${u.first_name || ""} ${u.last_name || ""}`.trim();

// ---------- reading ----------
async function list(agentId) {
  return repo.forAgent(agentId);
}

// ---------- the held record: shared by the induction screen and the task board ----------
async function applyHeld(client, { agent, actor, heldOn, conductedByName, ctx, source }) {
  await agentRepo.setMilestone(client, agent.id, "induction", noon(heldOn), actor.id);
  await client.query(
    `UPDATE coms_tasks SET status = 'done', completed_at = now(), completed_by = $2, completion_note = $3, updated_at = now()
     WHERE agent_id = $1 AND type = 'INDUCTION' AND status = 'open' AND deleted_at IS NULL`,
    [agent.id, actor.id, `Induction held on ${heldOn}${conductedByName ? ` by ${conductedByName}` : ""}`],
  );
  await audit.log({ actorId: actor.id, action: "agent.induction_recorded", entityType: ENTITY, entityId: agent.id, after: { date: heldOn, by: conductedByName, source }, ...ctx }, client);
}
const activate = (agentId, actor, ctx) => require("./taskService").maybeActivate(agentId, actor, ctx);

// The task board finishes the INDUCTION task: keep the induction record in step with it
async function recordFromTask(client, { agentId, actor, note }) {
  const today = calendar.localDate();
  const open = (await repo.forAgent(agentId, client)).find((i) => i.status === "scheduled");
  const d = { heldOn: today, mode: open?.mode || "online", conductedBy: open?.conducted_by || actor.id, attendees: open?.attendees, notes: note || "Recorded from the task board", actorId: actor.id };
  if (open) await repo.markHeld(client, open.id, d);
  else await repo.insert(client, { agentId, status: "held", ...d });
  await agentRepo.setMilestone(client, agentId, "induction", noon(today), actor.id);
}

// ---------- writing ----------
// body: { outcome: "held" | "scheduled", held_on, scheduled_for, conducted_by, mode, attendees, notes }
async function record(actor, agentId, body, ctx) {
  need(actor);
  const agent = await loadAgent(agentId);
  const today = calendar.localDate();
  const conductorId = body.conducted_by || actor.id;
  const conductor = await staffMember(conductorId);
  const existing = (await repo.forAgent(agentId)).find((i) => i.status === "scheduled");
  const common = { mode: body.mode || "online", conductedBy: conductor.id, attendees: body.attendees || null, actorId: actor.id };

  if (body.outcome === "scheduled") {
    if (!body.scheduled_for) throw fieldError("scheduled_for", "Choose the date");
    if (body.scheduled_for < today) throw fieldError("scheduled_for", "Choose today or a later date");
    if (existing) throw new AppError(409, "An induction is already scheduled. Change or cancel it first.");
    const id = await withTransaction(async (client) => {
      const iid = await repo.insert(client, { agentId, status: "scheduled", scheduledFor: body.scheduled_for, notes: body.notes, ...common });
      await audit.log({ actorId: actor.id, action: "agent.induction_scheduled", entityType: ENTITY, entityId: agentId, after: { date: body.scheduled_for, by: fullName(conductor), mode: common.mode }, ...ctx }, client);
      return iid;
    });
    await notifySchedule(agent, conductor, body.scheduled_for, common.mode);
    return repo.findById(id);
  }

  if (!body.held_on) throw fieldError("held_on", "Choose the date the induction was held");
  if (body.held_on > today) throw fieldError("held_on", "The date cannot be in the future");
  if (!body.notes || body.notes.trim().length < 3) throw fieldError("notes", "Add a note about what was covered");
  const id = await withTransaction(async (client) => {
    const d = { heldOn: body.held_on, notes: body.notes, ...common };
    let iid;
    if (existing) { await repo.markHeld(client, existing.id, d); iid = existing.id; }
    else iid = await repo.insert(client, { agentId, status: "held", ...d });
    await applyHeld(client, { agent, actor, heldOn: body.held_on, conductedByName: fullName(conductor), ctx, source: "induction_form" });
    return iid;
  });
  await activate(agentId, actor, ctx);
  return repo.findById(id);
}

// finish a scheduled induction
async function complete(actor, agentId, inductionId, body, ctx) {
  need(actor);
  const agent = await loadAgent(agentId);
  const i = await repo.findById(inductionId);
  if (!i || i.agent_id !== agentId) throw new AppError(404, "Induction not found.");
  if (i.status !== "scheduled") throw new AppError(409, "This induction is already closed.");
  const today = calendar.localDate();
  if (!body.held_on) throw fieldError("held_on", "Choose the date the induction was held");
  if (body.held_on > today) throw fieldError("held_on", "The date cannot be in the future");
  if (!body.notes || body.notes.trim().length < 3) throw fieldError("notes", "Add a note about what was covered");
  const conductor = await staffMember(body.conducted_by || i.conducted_by || actor.id);
  await withTransaction(async (client) => {
    await repo.markHeld(client, i.id, { heldOn: body.held_on, mode: body.mode || i.mode, conductedBy: conductor.id, attendees: body.attendees ?? i.attendees, notes: body.notes, actorId: actor.id });
    await applyHeld(client, { agent, actor, heldOn: body.held_on, conductedByName: fullName(conductor), ctx, source: "induction_form" });
  });
  await activate(agentId, actor, ctx);
  return repo.findById(i.id);
}

async function reschedule(actor, agentId, inductionId, body, ctx) {
  need(actor);
  const agent = await loadAgent(agentId);
  const i = await repo.findById(inductionId);
  if (!i || i.agent_id !== agentId) throw new AppError(404, "Induction not found.");
  if (i.status !== "scheduled") throw new AppError(409, "This induction is already closed.");
  if (!body.scheduled_for) throw fieldError("scheduled_for", "Choose the date");
  if (body.scheduled_for < calendar.localDate()) throw fieldError("scheduled_for", "Choose today or a later date");
  const conductor = await staffMember(body.conducted_by || i.conducted_by || actor.id);
  await withTransaction(async (client) => {
    await repo.reschedule(client, i.id, { scheduledFor: body.scheduled_for, mode: body.mode || i.mode, conductedBy: conductor.id, actorId: actor.id });
    await audit.log({ actorId: actor.id, action: "agent.induction_rescheduled", entityType: ENTITY, entityId: agentId, before: { date: i.scheduled_for }, after: { date: body.scheduled_for, by: fullName(conductor) }, ...ctx }, client);
  });
  await notifySchedule(agent, conductor, body.scheduled_for, body.mode || i.mode);
  return repo.findById(i.id);
}

async function cancel(actor, agentId, inductionId, reason, ctx) {
  need(actor);
  await loadAgent(agentId);
  const i = await repo.findById(inductionId);
  if (!i || i.agent_id !== agentId) throw new AppError(404, "Induction not found.");
  if (i.status !== "scheduled") throw new AppError(409, "This induction is already closed.");
  await withTransaction(async (client) => {
    await repo.cancel(client, i.id, reason, actor.id);
    await audit.log({ actorId: actor.id, action: "agent.induction_cancelled", entityType: ENTITY, entityId: agentId, before: { date: i.scheduled_for }, metadata: { reason }, ...ctx }, client);
  });
  return repo.findById(i.id);
}

// ---------- emails and reminders ----------
async function notifySchedule(agent, conductor, date, mode) {
  const link = `${env.frontendUrl}/coms/agents/${agent.id}`;
  const people = await agentRepo.persons(agent.id);
  const contact = people.find((p) => p.is_primary_contact) || people[0];
  const to = contact?.email || agent.email;
  if (to) email.sendInductionScheduled({ to, firstName: (contact?.name || agent.legal_name).split(" ")[0], date, mode: MODE_LABEL[mode] || mode, conductor: fullName(conductor) });
  if (conductor.email) email.sendInductionReminder({ to: conductor.email, firstName: conductor.first_name, agentName: agent.legal_name, date, mode: MODE_LABEL[mode] || mode, level: "scheduled", link });
}

async function runReminders() {
  const today = calendar.localDate();
  const tomorrow = calendar.addDays(today, 1);
  const out = { reminded: 0, followUps: 0, taskDueSoon: 0, taskOverdue: 0 };

  for (const i of await repo.scheduledOpen()) {
    if (!i.conductor_email) continue;
    const link = `${env.frontendUrl}/coms/agents/${i.agent_id}`;
    const base = { to: i.conductor_email, firstName: i.conductor_first_name, agentName: i.agent_name, date: i.scheduled_for, mode: MODE_LABEL[i.mode] || i.mode, link };
    if (i.scheduled_for >= today && i.scheduled_for <= tomorrow && !i.reminder_sent_at) {
      email.sendInductionReminder({ ...base, level: "upcoming" });
      await repo.markReminded(i.id);
      out.reminded++;
    } else if (i.scheduled_for < today && !i.followup_sent_at) {
      email.sendInductionReminder({ ...base, level: "record_outcome" });
      await repo.markFollowedUp(i.id);
      out.followUps++;
    }
  }

  // the INDUCTION task: due soon (once) and overdue (once, to the owner and the directors)
  const directors = await taskRepo.usersWithRoles([ROLES.DIRECTOR]);
  const taskLink = `${env.frontendUrl}/coms/tasks`;
  for (const t of await taskRepo.openOfType("INDUCTION")) {
    const owner = t.owner_id ? await taskRepo.userById(t.owner_id) : null;
    const ownerList = owner?.status === "active" ? [owner] : [];
    const tell = (users, level) => users.forEach((u) => email.sendTaskAlert({ to: u.email, firstName: u.first_name, title: t.title, agentName: t.agent_name, dueDate: t.due_date, level, link: taskLink }));
    if (t.due_date < today) {
      if (!t.warned_at) { tell([...ownerList, ...directors.filter((d) => d.id !== owner?.id)], "overdue"); await taskRepo.markWarned(t.id); out.taskOverdue++; }
    } else if (!t.reminded_at && t.due_date <= calendar.addDays(today, REMIND_DAYS_BEFORE_DUE)) {
      tell(ownerList, "due_soon");
      await taskRepo.markReminded(t.id);
      out.taskDueSoon++;
    }
  }
  return out;
}

module.exports = { list, record, complete, reschedule, cancel, recordFromTask, runReminders };
