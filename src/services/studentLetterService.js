// Phase 5 step 3: Letter of Offer, payment, CoE record and Verification of Enrolment.
// Admissions (or the Director/Admin) prepare a draft from the editable template. The Director, CEO or Admin review and issue it as a PDF.
// Accounts confirm payment, the CoE Administrator records the PRISMS CoE number, then a Verification of Enrolment can be issued.
// Nothing can be issued until an administrator has confirmed the wording (Application settings).
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { APP_STATUS, APP_PERMS, ROLES } = require("../const");
const { parseUpload } = require("../utils/upload");
const repo = require("../repositories/studentAppRepo");
const audit = require("../repositories/auditRepo");
const ddRepo = require("../repositories/dueDiligenceRepo");
const taskRepo = require("../repositories/taskRepo");
const storage = require("./fileStorage");
const calendar = require("./calendarService");
const email = require("./emailService");
const pdf = require("./studentLetterPdf");
const main = require("./studentApplicationService");

const S = APP_STATUS;
const need = (actor, perm) => { if (!APP_PERMS[perm].includes(actor.role)) throw new AppError(403, "You do not have permission to do that."); };
const fieldError = (field, msg) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: msg } });
const aud = (n) => (n === null || n === undefined || n === "" ? "To be advised" : `AUD ${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const longDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");
const fill = (tpl, vars) => String(tpl).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const leftover = (text) => [...new Set((String(text).match(/\{\{[^}]*\}\}/g) || []))];

async function load(id) {
  const app = await repo.find(id);
  if (!app || app.status === S.DRAFT) throw new AppError(404, "Application not found.");
  return app;
}
const course = async (app) => (await require("../repositories/courseRepo").list({ activeOnly: false })).find((c) => Number(c.id) === Number(app.course_id)) || {};

async function variables(app, cfg, extra = {}) {
  const c = await course(app);
  const total = ["tuition_fee", "material_fee", "enrolment_fee"].map((k) => Number(extra[k] ?? c[k] ?? 0)).reduce((a, b) => a + b, 0);
  const d = app.data || {};
  return {
    student_name: main.studentName(app), ref_no: app.ref_no, course: main.courseTitle(app), cricos_code: c.cricos_code || "To be advised", campus: app.campus_name,
    start_date: longDate(app.commencement_date), duration_weeks: (d.course || {}).elicos_weeks || c.duration_weeks || "To be advised",
    tuition_fee: aud(extra.tuition_fee ?? c.tuition_fee), material_fee: aud(extra.material_fee ?? c.material_fee), enrolment_fee: aud(extra.enrolment_fee ?? c.enrolment_fee), total_fee: aud(total),
    conditions: cfg.loo_conditions, signer_name: cfg.loo_signer_name, signer_title: cfg.loo_signer_title, date: longDate(calendar.localDate()),
    date_of_birth: longDate(app.date_of_birth), passport_number: (d.passport || {}).number || "", coe_number: app.coe_number || "",
  };
}

// ---------- Letter of Offer ----------
async function prepareLetter(actor, id, ctx) {
  need(actor, "letter");
  const app = await load(id);
  if (app.status !== S.DECISION_MADE || app.decision !== "offer") throw new AppError(409, "A Letter of Offer can only be prepared after the decision is to offer a place.");
  if (await repo.liveLetter(id)) throw new AppError(409, "There is already a letter for this application.");
  const cfg = await main.config();
  const c = await course(app);
  const body = fill(cfg.loo_template, await variables(app, cfg));
  await withTransaction(async (client) => {
    const n = await repo.letterCount(id, client);
    const letterId = await repo.insertLetter(client, { appId: id, version: n + 1, body, tuition: c.tuition_fee ?? null, material: c.material_fee ?? null, enrolment: c.enrolment_fee ?? null, userId: actor.id });
    await repo.log(client, { appId: id, from: app.status, to: app.status, actorId: actor.id, note: "Letter of Offer draft prepared" });
    await audit.log({ actorId: actor.id, action: "student_application.letter_prepared", entityType: "student_application", entityId: id, after: { letter: letterId }, ...ctx }, client);
  });
}
async function saveLetter(actor, id, body, ctx) {
  need(actor, "letter");
  await load(id);
  const l = await repo.liveLetter(id);
  if (!l || l.status !== "draft") throw new AppError(409, "There is no draft letter to change.");
  await withTransaction(async (client) => {
    await repo.saveLetter(client, l.id, { body: body.body, tuition: body.tuition_fee ?? null, material: body.material_fee ?? null, enrolment: body.enrolment_fee ?? null });
    await audit.log({ actorId: actor.id, action: "student_application.letter_edited", entityType: "student_application", entityId: id, ...ctx }, client);
  });
}
async function issueLetter(actor, id, ctx) {
  need(actor, "issueLetter");
  const app = await load(id);
  const l = await repo.liveLetter(id);
  if (!l || l.status !== "draft") throw new AppError(409, "There is no draft letter to issue.");
  const cfg = await main.config();
  if (!cfg.letters_confirmed) throw new AppError(409, "The Letter of Offer wording has not been confirmed yet. An administrator must confirm it on the Application settings screen.");
  if (l.tuition_fee === null) throw fieldError("tuition_fee", "Enter the tuition fee before issuing");
  const open = leftover(l.body);
  if (open.length) throw fieldError("body", `Fill in or remove: ${open.join(", ")}`);
  const buffer = await pdf.render({ title: "Letter of Offer", text: l.body, ref: app.ref_no, dateText: longDate(calendar.localDate()) });
  const saved = await storage.save(buffer, "pdf", "students");
  try {
    await withTransaction(async (client) => {
      const fileId = await ddRepo.insertFile(client, { kind: "letter_of_offer", name: `Letter of Offer - ${main.clean(main.studentName(app))} - ${app.ref_no}.pdf`, ...saved, mime: "application/pdf", actorId: actor.id });
      await repo.issueLetter(client, l.id, { fileId, userId: actor.id });
      await repo.log(client, { appId: id, from: app.status, to: app.status, actorId: actor.id, note: `Letter of Offer issued (version ${l.version})` });
      await audit.log({ actorId: actor.id, action: "student_application.letter_issued", entityType: "student_application", entityId: id, after: { letter: l.id, version: l.version }, ...ctx }, client);
    });
  } catch (e) { await storage.remove(saved.key); throw e; }
  await tellAgent(app, "Your student's Letter of Offer is ready", "The Letter of Offer is ready to download from the application page.");
}
// a new version after an issue: the old one stays on record as superseded
async function reviseLetter(actor, id, ctx) {
  need(actor, "issueLetter");
  const app = await load(id);
  const l = await repo.liveLetter(id);
  if (!l || l.status !== "issued") throw new AppError(409, "Only an issued letter can be revised.");
  if (app.status === S.COE_ISSUED || app.payment_confirmed_at) throw new AppError(409, "Payment has been confirmed, so the letter can no longer be changed.");
  await withTransaction(async (client) => {
    await repo.supersedeLetter(client, l.id);
    await repo.insertLetter(client, { appId: id, version: l.version + 1, body: l.body, tuition: l.tuition_fee, material: l.material_fee, enrolment: l.enrolment_fee, userId: actor.id });
    await repo.log(client, { appId: id, from: app.status, to: app.status, actorId: actor.id, note: `Letter of Offer version ${l.version} withdrawn for revision` });
    await audit.log({ actorId: actor.id, action: "student_application.letter_revised", entityType: "student_application", entityId: id, ...ctx }, client);
  });
}

// ---------- payment, CoE, VoE ----------
async function confirmPayment(actor, id, { note }, ctx) {
  need(actor, "confirmPayment");
  const app = await load(id);
  const l = await repo.liveLetter(id);
  if (app.status !== S.DECISION_MADE || !l || l.status !== "issued") throw new AppError(409, "Payment can be confirmed after the Letter of Offer has been issued.");
  if (app.payment_confirmed_at) throw new AppError(409, "Payment has already been confirmed.");
  await withTransaction(async (client) => {
    await repo.confirmPayment(client, id, { note, userId: actor.id });
    await repo.log(client, { appId: id, from: app.status, to: app.status, actorId: actor.id, note: "Payment confirmed" });
    await audit.log({ actorId: actor.id, action: "student_application.payment_confirmed", entityType: "student_application", entityId: id, after: { note }, ...ctx }, client);
  });
  for (const u of await taskRepo.usersWithRoles([ROLES.COE_ADMIN])) {
    email.sendStudentAppReadyForCoe({ to: u.email, firstName: u.first_name, ref: app.ref_no, studentName: main.studentName(app), link: `${env.frontendUrl}/coms/applications/${id}` });
  }
}
async function recordCoe(actor, id, body, ctx) {
  need(actor, "recordCoe");
  const app = await load(id);
  if (app.status !== S.DECISION_MADE || !app.payment_confirmed_at) throw new AppError(409, "A CoE can be recorded once payment has been confirmed.");
  if (body.issued_on > calendar.localDate()) throw fieldError("issued_on", "The date is in the future");
  let saved = null; let up = null;
  if (body.file) { up = parseUpload(body.file); saved = await storage.save(up.buffer, up.ext, "students"); }
  try {
    await withTransaction(async (client) => {
      const fileId = saved ? await ddRepo.insertFile(client, { kind: "coe_confirmation", name: up.name, ...saved, mime: up.mime, actorId: actor.id }) : null;
      await repo.recordCoe(client, id, { number: body.coe_number, issuedOn: body.issued_on, fileId, userId: actor.id });
      await repo.log(client, { appId: id, from: app.status, to: S.COE_ISSUED, actorId: actor.id, note: `CoE ${body.coe_number} recorded` });
      await audit.log({ actorId: actor.id, action: "student_application.coe_recorded", entityType: "student_application", entityId: id, after: { coe_number: body.coe_number, issued_on: body.issued_on }, ...ctx }, client);
    });
  } catch (e) { if (saved) await storage.remove(saved.key); throw e; }
  await tellAgent(app, "CoE issued", `The Confirmation of Enrolment ${body.coe_number} has been issued for this student.`);
}
async function issueVoe(actor, id, ctx) {
  need(actor, "recordCoe");
  const app = await load(id);
  if (app.status !== S.COE_ISSUED) throw new AppError(409, "A Verification of Enrolment can be issued after the CoE has been recorded.");
  if (app.voe_issued_at) throw new AppError(409, "The Verification of Enrolment has already been issued.");
  const cfg = await main.config();
  if (!cfg.letters_confirmed) throw new AppError(409, "The letter wording has not been confirmed yet. An administrator must confirm it on the Application settings screen.");
  const text = fill(cfg.voe_template, await variables(app, cfg));
  const open = leftover(text);
  if (open.length) throw new AppError(409, `The Verification of Enrolment template has unknown fields: ${open.join(", ")}`);
  const buffer = await pdf.render({ title: "Verification of Enrolment", text, ref: app.ref_no, dateText: longDate(calendar.localDate()) });
  const saved = await storage.save(buffer, "pdf", "students");
  try {
    await withTransaction(async (client) => {
      const fileId = await ddRepo.insertFile(client, { kind: "voe", name: `Verification of Enrolment - ${main.clean(main.studentName(app))} - ${app.ref_no}.pdf`, ...saved, mime: "application/pdf", actorId: actor.id });
      await repo.recordVoe(client, id, { fileId, userId: actor.id });
      await repo.log(client, { appId: id, from: app.status, to: app.status, actorId: actor.id, note: "Verification of Enrolment issued" });
      await audit.log({ actorId: actor.id, action: "student_application.voe_issued", entityType: "student_application", entityId: id, ...ctx }, client);
    });
  } catch (e) { await storage.remove(saved.key); throw e; }
  await tellAgent(app, "Verification of Enrolment ready", "The Verification of Enrolment is ready to download from the application page.");
}

async function tellAgent(app, subject, message) {
  const user = app.created_by && (await taskRepo.userById(app.created_by));
  if (!user) return;
  email.sendStudentAppUpdate({ to: user.email, firstName: user.first_name, ref: app.ref_no, studentName: main.studentName(app), subject, message, link: `${env.frontendUrl}/agent/applications/${app.id}` });
}

// ---------- downloads (the agent sees only what has been issued) ----------
async function outputs(app) {
  const l = await repo.liveLetter(app.id);
  const list = [];
  if (l && l.status === "issued") list.push({ kind: "letter", label: "Letter of Offer", at: l.issued_at });
  if (app.coe_file_id) list.push({ kind: "coe", label: `Confirmation of Enrolment ${app.coe_number}`, at: app.updated_at });
  if (app.voe_file_id) list.push({ kind: "voe", label: "Verification of Enrolment", at: app.voe_issued_at });
  return list;
}
async function openOutput(actor, id, kind, ctx) {
  const app = await load(id);
  if (actor.role === ROLES.AGENT) {
    const agent = await require("../repositories/comsAgentRepo").findByPortalUser(actor.id);
    if (!agent || agent.id !== app.agent_id) throw new AppError(404, "Application not found.");
  } else if (!APP_PERMS.read.includes(actor.role)) throw new AppError(403, "You do not have permission to do that.");
  const l = await repo.liveLetter(id);
  const fileId = kind === "letter" ? (l && l.status === "issued" ? l.file_id : null) : kind === "coe" ? app.coe_file_id : app.voe_file_id;
  const f = fileId && (await repo.fileOf(fileId));
  if (!f || !(await storage.exists(f.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: actor.id, action: "coms.file_downloaded", entityType: "file", entityId: f.id, metadata: { kind, application: app.ref_no }, ...ctx });
  return { stream: storage.createReadStream(f.storage_key), name: f.original_name, mime: f.mime_type, size: f.size_bytes };
}

module.exports = { prepareLetter, saveLetter, issueLetter, reviseLetter, confirmPayment, recordCoe, issueVoe, outputs, openOutput, variables };
