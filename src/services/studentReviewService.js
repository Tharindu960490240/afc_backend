// Phase 5 step 2: what staff do with a submitted student application.
// Assess (admin, director, admissions) = start the review, check each document, ask the agent for more, record the decision.
// Everyone on staff can read. The agent hears about every change by email, and the status log keeps the history.
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { APP_STATUS, APP_PERMS, ROLES } = require("../const");
const repo = require("../repositories/studentAppRepo");
const taskRepo = require("../repositories/taskRepo");
const agentRepo = require("../repositories/comsAgentRepo");
const audit = require("../repositories/auditRepo");
const calendar = require("./calendarService");
const email = require("./emailService");
const main = require("./studentApplicationService");

const S = APP_STATUS;
const OPEN = [S.RECEIVED, S.UNDER_REVIEW];
const need = (actor, perm) => { if (!APP_PERMS[perm].includes(actor.role)) throw new AppError(403, "You do not have permission to do that."); };
const fieldError = (field, msg) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: msg } });
const niceDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");

async function load(id) {
  const app = await repo.find(id);
  if (!app || app.status === S.DRAFT) throw new AppError(404, "Application not found.");
  return app;
}
// working days left to the assessment date (0 = due today, negative = late)
async function clock(app) {
  if (!app.assessment_due || !OPEN.includes(app.status)) return { days_left: null, overdue: false };
  const left = await calendar.businessDaysBetween(calendar.localDate(), app.assessment_due);
  return { days_left: left, overdue: left < 0 };
}

async function queue(actor, { status, q, attention }) {
  need(actor, "read");
  const rows = await repo.staffList({ status, q: q && q.trim() ? q.trim() : null, attention });
  const out = [];
  for (const r of rows) {
    out.push({
      ...main.summaryRow(r), agent: r.agent_name, late_submission: r.late_submission, needs_transfer_review: r.needs_transfer_review, wants_credit: r.wants_credit,
      ...(await clock(r)),
    });
  }
  return { rows: out, counts: await repo.counts() };
}

async function detail(actor, id) {
  need(actor, "read");
  const app = await load(id);
  const agent = await agentRepo.findById(app.agent_id);
  return {
    ...(await main.shape(app)), can_edit: false, ...(await clock(app)),
    agent: agent ? { id: agent.id, legal_name: agent.legal_name, country: agent.country, status: agent.status } : null,
    can_assess: APP_PERMS.assess.includes(actor.role) && OPEN.includes(app.status),
    ...(await stage(app, actor)),
    can_review_docs: APP_PERMS.assess.includes(actor.role) && [S.RECEIVED, S.UNDER_REVIEW, S.INFO_REQUESTED].includes(app.status),
  };
}

// where the application is after the decision: letter, payment, CoE, VoE, and what this person may do next
async function stage(app, actor) {
  const letter = await repo.liveLetter(app.id);
  const cfg = await main.config();
  const offered = app.status === S.DECISION_MADE && app.decision === "offer";
  const can = (perm) => APP_PERMS[perm].includes(actor.role);
  return {
    letter: letter || null,
    letters_confirmed: Boolean(cfg.letters_confirmed),
    payment: app.payment_confirmed_at ? { at: app.payment_confirmed_at, note: app.payment_note } : null,
    coe: app.coe_number ? { number: app.coe_number, issued_on: app.coe_issued_on, has_file: Boolean(app.coe_file_id) } : null,
    voe: app.voe_issued_at ? { at: app.voe_issued_at } : null,
    can_prepare_letter: offered && !letter && can("letter"),
    can_edit_letter: offered && letter && letter.status === "draft" && can("letter"),
    can_issue_letter: offered && letter && letter.status === "draft" && can("issueLetter"),
    can_revise_letter: offered && letter && letter.status === "issued" && !app.payment_confirmed_at && can("issueLetter"),
    can_confirm_payment: offered && letter && letter.status === "issued" && !app.payment_confirmed_at && can("confirmPayment"),
    can_record_coe: offered && Boolean(app.payment_confirmed_at) && can("recordCoe"),
    can_issue_voe: app.status === S.COE_ISSUED && !app.voe_issued_at && can("recordCoe"),
  };
}

async function move(actor, app, to, { note, decision, reason, action, ctx, extra }) {
  await withTransaction(async (client) => {
    await repo.setStatus(client, app.id, { status: to, decision, reason, userId: actor.id });
    await repo.log(client, { appId: app.id, from: app.status, to, actorId: actor.id, note });
    await audit.log({ actorId: actor.id, action, entityType: "student_application", entityId: app.id, before: { status: app.status }, after: { status: to, decision, ...extra }, ...ctx }, client);
  });
}
const agentPeople = async (app) => {
  const agent = await agentRepo.findById(app.agent_id);
  const user = app.created_by && (await taskRepo.userById(app.created_by));
  return { agent, user };
};
async function tellAgent(app, fn, payload) {
  const { user } = await agentPeople(app);
  if (user) fn({ to: user.email, firstName: user.first_name, ref: app.ref_no, studentName: `${app.student_given_names || ""} ${app.student_surname || ""}`.trim(), ...payload, link: `${env.frontendUrl}/agent/applications/${app.id}` });
}

async function startReview(actor, id, ctx) {
  need(actor, "assess");
  const app = await load(id);
  if (app.status !== S.RECEIVED) throw new AppError(409, "Only a newly received application can be taken for review.");
  await move(actor, app, S.UNDER_REVIEW, { note: "Review started", action: "student_application.review_started", ctx });
  return detail(actor, id);
}

async function reviewDocument(actor, id, docId, { status, note }, ctx) {
  need(actor, "assess");
  const app = await load(id);
  if (![S.RECEIVED, S.UNDER_REVIEW, S.INFO_REQUESTED].includes(app.status)) throw new AppError(409, "This application is no longer being reviewed.");
  const d = await repo.doc(id, docId);
  if (!d) throw new AppError(404, "Document not found.");
  if (status === "needs_update" && !(note || "").trim()) throw fieldError("note", "Say what needs to change");
  await withTransaction(async (client) => {
    await repo.reviewDoc(client, id, docId, { status, note: note && note.trim(), userId: actor.id });
    await audit.log({ actorId: actor.id, action: `student_application.document_${status}`, entityType: "student_application", entityId: id, after: { kind: d.kind, note }, ...ctx }, client);
  });
  return detail(actor, id);
}

async function requestInfo(actor, id, { note }, ctx) {
  need(actor, "assess");
  const app = await load(id);
  if (!OPEN.includes(app.status)) throw new AppError(409, "Information can only be requested while the application is being assessed.");
  const docs = (await repo.docs(id)).filter((d) => d.status === "needs_update").map((d) => d.label || d.kind);
  await move(actor, app, S.INFO_REQUESTED, { note: note.trim(), action: "student_application.info_requested", ctx });
  await tellAgent(app, email.sendStudentAppInfoRequest, { note: note.trim(), docs });
  return detail(actor, id);
}

async function decide(actor, id, { decision, reason }, ctx) {
  need(actor, "assess");
  const app = await load(id);
  if (!OPEN.includes(app.status)) throw new AppError(409, "A decision can only be recorded while the application is being assessed.");
  if (decision === "not_offered" && !(reason || "").trim()) throw fieldError("reason", "Give the agent a reason");
  const docs = await repo.docs(id);
  if (decision === "offer" && docs.some((d) => d.status === "needs_update")) throw fieldError("decision", "A document is still marked as needing an update");
  await move(actor, app, S.DECISION_MADE, { note: decision === "offer" ? "Decision: offer" : `Decision: not offered. ${reason.trim()}`, decision, reason: reason && reason.trim(), action: "student_application.decided", ctx, extra: { reason } });
  await tellAgent(app, email.sendStudentAppDecision, { offered: decision === "offer", reason: reason && reason.trim() });
  return detail(actor, id);
}

async function withdraw(actor, id, { reason }, ctx) {
  need(actor, "assess");
  const app = await load(id);
  if ([S.WITHDRAWN, S.COE_ISSUED].includes(app.status)) throw new AppError(409, "This application can no longer be withdrawn.");
  await move(actor, app, S.WITHDRAWN, { note: `Withdrawn. ${reason.trim()}`, reason: null, action: "student_application.withdrawn", ctx, extra: { reason } });
  return detail(actor, id);
}

// Daily: the day-4 alert. When one working day is left and nothing is decided, the managers are told once.
async function runAlerts() {
  const managers = await (async () => {
    const d = await taskRepo.usersWithRoles([ROLES.DIRECTOR]);
    return d.length ? d : taskRepo.usersWithRoles([ROLES.ADMIN]);
  })();
  const today = calendar.localDate();
  let n = 0;
  for (const a of await repo.dueForAlert()) {
    if ((await calendar.businessDaysBetween(today, a.assessment_due)) > 1) continue;
    for (const u of managers) {
      email.sendStudentAppDueAlert({ to: u.email, firstName: u.first_name, ref: a.ref_no, studentName: `${a.student_given_names} ${a.student_surname}`, agentName: a.agent_name, dueText: niceDate(a.assessment_due), link: `${env.frontendUrl}/coms/applications/${a.id}` });
    }
    await repo.markAlerted(a.id);
    n++;
  }
  return n;
}

module.exports = { queue, detail, startReview, reviewDocument, requestInfo, decide, withdraw, runAlerts };
