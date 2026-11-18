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
// time, and the link (online) or place / phone number (in person, by phone) the agent needs to attend
function bookingDetails(body, mode, prev = {}) {
  const startTime = body.start_time || prev.start_time;
  if (!startTime) throw fieldError("start_time", "Choose the start time");
  const out = { startTime, meetingUrl: null, location: null };
  if (mode === "online") {
    const url = (body.meeting_url || prev.meeting_url || "").trim();
    if (!url) throw fieldError("meeting_url", "Add the meeting link so the agent can join");
    if (!/^https?:\/\//i.test(url)) throw fieldError("meeting_url", "Enter a full link starting with https://");
    out.meetingUrl = url;
  } else {
    const loc = (body.location || prev.location || "").trim();
    if (!loc) throw fieldError("location", mode === "phone" ? "Add the phone number the agent will be called on" : "Add where the induction will be held");
    out.location = loc;
  }
  return out;
}
// "10:30 am AEDT" for the college's time zone
const timeText = (date, time) => {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  const when = new Date(`${date}T${time}:00`);
  const zone = new Intl.DateTimeFormat("en-AU", { timeZone: env.timezone, timeZoneName: "short" }).formatToParts(when).find((x) => x.type === "timeZoneName")?.value;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}${zone ? ` ${zone}` : ""}`;
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
  if (body.online_confirmation) {
    // staff confirm the online induction (modules finished and policies acknowledged): a second check, not just the agent's word
    const st = await require("./onlineInductionService").statusFor(agentId, agent);
    if (!["awaiting_staff", "complete"].includes(st.stage)) throw new AppError(409, "The agent has not finished the online modules and acknowledged the policies yet.");
    body = { ...body, outcome: "held", held_on: body.held_on || today, mode: "online", notes: body.notes || "Online induction checked and confirmed by staff" };
  }
  const conductor = await staffMember(conductorId);
  const existing = (await repo.forAgent(agentId)).find((i) => i.status === "scheduled");
  const common = { mode: body.mode || "online", conductedBy: conductor.id, attendees: body.attendees || null, actorId: actor.id };

  if (body.outcome === "scheduled") {
    if (!body.scheduled_for) throw fieldError("scheduled_for", "Choose the date");
    if (body.scheduled_for < today) throw fieldError("scheduled_for", "Choose today or a later date");
    if (existing) throw new AppError(409, "An induction is already scheduled. Change or cancel it first.");
    const det = bookingDetails(body, common.mode);
    const id = await withTransaction(async (client) => {
      const iid = await repo.insert(client, { agentId, status: "scheduled", scheduledFor: body.scheduled_for, notes: body.notes, ...det, ...common });
      await audit.log({ actorId: actor.id, action: "agent.induction_scheduled", entityType: ENTITY, entityId: agentId, after: { date: body.scheduled_for, by: fullName(conductor), mode: common.mode }, ...ctx }, client);
      return iid;
    });
    await notifySchedule(agent, conductor, await repo.findById(id));
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
  const mode = body.mode || i.mode;
  const det = bookingDetails(body, mode, mode === i.mode ? i : { start_time: i.start_time });
  await withTransaction(async (client) => {
    await repo.reschedule(client, i.id, { scheduledFor: body.scheduled_for, mode, conductedBy: conductor.id, actorId: actor.id, ...det });
    await audit.log({ actorId: actor.id, action: "agent.induction_rescheduled", entityType: ENTITY, entityId: agentId, before: { date: i.scheduled_for }, after: { date: body.scheduled_for, by: fullName(conductor) }, ...ctx }, client);
  });
  await notifySchedule(agent, conductor, await repo.findById(i.id));
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

// ---------- correcting a held induction ----------
const heldFor = async (agentId, inductionId) => {
  const i = await repo.findById(inductionId);
  if (!i || i.agent_id !== agentId) throw new AppError(404, "Induction not found.");
  if (i.status !== "held") throw new AppError(409, "Only a held induction can be changed.");
  return i;
};

// fix the date, who ran it, how, attendees or notes of a held induction. The change is audited with before and after.
async function editHeld(actor, agentId, inductionId, body, ctx) {
  need(actor);
  const agent = await loadAgent(agentId);
  const i = await heldFor(agentId, inductionId);
  const heldOn = body.held_on || i.held_on;
  const notes = body.notes ?? i.notes;
  if (heldOn > calendar.localDate()) throw fieldError("held_on", "The date cannot be in the future");
  if (!notes || notes.trim().length < 3) throw fieldError("notes", "Add a note about what was covered");
  const conductor = await staffMember(body.conducted_by || i.conducted_by || actor.id);
  const next = { heldOn, mode: body.mode || i.mode, conductedBy: conductor.id, attendees: body.attendees ?? i.attendees, notes, actorId: actor.id };
  await withTransaction(async (client) => {
    await repo.editHeld(client, i.id, next);
    const latest = await repo.latestHeld(client, agentId);
    if (latest) await agentRepo.setMilestone(client, agentId, "induction", noon(latest), actor.id);
    await audit.log({
      actorId: actor.id, action: "agent.induction_edited", entityType: ENTITY, entityId: agentId,
      before: { date: i.held_on, by: i.conducted_by_name, mode: i.mode, attendees: i.attendees, notes: i.notes },
      after: { date: heldOn, by: fullName(conductor), mode: next.mode, attendees: next.attendees, notes }, ...ctx,
    }, client);
  });
  return repo.findById(i.id);
}

// undo a held induction recorded by mistake (director or administrator, with a reason).
// If it was the only one, the "induction recorded" milestone is cleared and the finished task is opened again.
// An agent who is already Active is not demoted: a warning tells the manager to review it.
async function voidHeld(actor, agentId, inductionId, reason, ctx) {
  if (!AGENT_PERMS.remove.includes(actor.role)) throw new AppError(403, "You do not have permission to do that.");
  const agent = await loadAgent(agentId);
  const i = await heldFor(agentId, inductionId);
  let stillRecorded = false;
  await withTransaction(async (client) => {
    await repo.cancel(client, i.id, reason, actor.id, "voided");
    const latest = await repo.latestHeld(client, agentId);
    stillRecorded = !!latest;
    await agentRepo.setMilestone(client, agentId, "induction", latest ? noon(latest) : null, actor.id);
    if (!latest) {
      await client.query(
        `UPDATE coms_tasks SET status = 'open', completed_at = NULL, completed_by = NULL, completion_note = NULL, warned_at = NULL, reminded_at = NULL, updated_at = now()
         WHERE id = (SELECT id FROM coms_tasks WHERE agent_id = $1 AND type = 'INDUCTION' AND status = 'done' AND deleted_at IS NULL ORDER BY completed_at DESC NULLS LAST LIMIT 1)`,
        [agentId],
      );
    }
    await audit.log({ actorId: actor.id, action: "agent.induction_undone", entityType: ENTITY, entityId: agentId, before: { date: i.held_on, by: i.conducted_by_name }, metadata: { reason, still_recorded: stillRecorded }, ...ctx }, client);
  });
  const warning = !stillRecorded && agent.status === "active"
    ? "This agent is already Active and has not been changed. Record a new induction, or review whether they should stay Active."
    : null;
  return { ...(await repo.findById(i.id)), warning };
}

// the agent did not come: the booking is closed (not recorded as held) and a new one can be made
async function markMissed(actor, agentId, inductionId, reason, ctx) {
  need(actor);
  await loadAgent(agentId);
  const i = await repo.findById(inductionId);
  if (!i || i.agent_id !== agentId) throw new AppError(404, "Induction not found.");
  if (i.status !== "scheduled") throw new AppError(409, "This induction is already closed.");
  await withTransaction(async (client) => {
    await repo.cancel(client, i.id, reason, actor.id, "missed");
    await audit.log({ actorId: actor.id, action: "agent.induction_missed", entityType: ENTITY, entityId: agentId, before: { date: i.scheduled_for }, metadata: { reason }, ...ctx }, client);
  });
  return repo.findById(i.id);
}

// what the agent sees in their portal: the booking with the way to join, and past sessions (no internal notes)
async function mine(user) {
  const found = await agentRepo.findByPortalUser(user.id);
  const a = found && (await agentRepo.findById(found.id));
  if (!a || a.deleted_at || !ELIGIBLE.includes(a.status)) return { eligible: false, scheduled: null, history: [], recorded_at: null };
  const rows = await repo.forAgent(a.id);
  const view = (i) => ({
    id: i.id, status: i.status, mode: i.mode, date: i.scheduled_for || i.held_on, time: timeText(i.scheduled_for || i.held_on, i.start_time),
    run_by: i.conducted_by_name, meeting_url: i.status === "scheduled" ? i.meeting_url : null, location: i.status === "scheduled" ? i.location : null,
  });
  return {
    eligible: true,
    recorded_at: a.induction_recorded_at,
    scheduled: rows.filter((i) => i.status === "scheduled").map(view)[0] || null,
    history: rows.filter((i) => i.status === "held").map(view),
  };
}

// ---------- emails and reminders ----------
const detailsOf = (i) => ({
  date: i.scheduled_for, time: timeText(i.scheduled_for, i.start_time), mode: MODE_LABEL[i.mode] || i.mode,
  meetingUrl: i.meeting_url, location: i.location,
});
async function notifySchedule(agent, conductor, i) {
  const people = await agentRepo.persons(agent.id);
  const contact = people.find((p) => p.is_primary_contact) || people[0];
  const to = contact?.email || agent.email;
  const d = detailsOf(i);
  if (to) email.sendInductionScheduled({ to, firstName: (contact?.name || agent.legal_name).split(" ")[0], conductor: fullName(conductor), portalLink: `${env.frontendUrl}/agent/induction`, ...d });
  if (conductor.email) email.sendInductionReminder({ to: conductor.email, firstName: conductor.first_name, agentName: agent.legal_name, level: "scheduled", link: `${env.frontendUrl}/coms/agents/${agent.id}`, ...d });
}

async function runReminders() {
  const today = calendar.localDate();
  const tomorrow = calendar.addDays(today, 1);
  const out = { reminded: 0, followUps: 0, taskDueSoon: 0, taskOverdue: 0 };

  for (const i of await repo.scheduledOpen()) {
    if (!i.conductor_email) continue;
    const link = `${env.frontendUrl}/coms/agents/${i.agent_id}`;
    const base = { to: i.conductor_email, firstName: i.conductor_first_name, agentName: i.agent_name, link, ...detailsOf(i) };
    if (i.scheduled_for >= today && i.scheduled_for <= tomorrow && !i.reminder_sent_at) {
      email.sendInductionReminder({ ...base, level: "upcoming" });
      if (i.agent_email) email.sendInductionScheduled({ to: i.agent_email, firstName: i.agent_name.split(" ")[0], conductor: i.conducted_by_name, portalLink: `${env.frontendUrl}/agent/induction`, reminder: true, ...detailsOf(i) });
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

module.exports = { list, mine, record, complete, reschedule, cancel, markMissed, editHeld, voidHeld, recordFromTask, runReminders };
