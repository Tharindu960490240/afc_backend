// Phase 5: student applications. The portal is the only way an agent submits one (client requirements).
// An agent starts a draft, completes the AFC enrolment form (V3.1) and uploads the documents, then submits.
// Only an active agent who has finished the induction can start or submit one (the gate in onlineInductionService).
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { APP_STATUS, APP_PERMS, ROLES } = require("../const");
const { parseUpload } = require("../utils/upload");
const repo = require("../repositories/studentAppRepo");
const courseRepo = require("../repositories/courseRepo");
const taskRepo = require("../repositories/taskRepo");
const audit = require("../repositories/auditRepo");
const storage = require("./fileStorage");
const calendar = require("./calendarService");
const email = require("./emailService");
const induction = require("./onlineInductionService");
const ddRepo = require("../repositories/dueDiligenceRepo");
const v = require("../validators/studentApplication");

const S = APP_STATUS;
const EDITABLE = [S.DRAFT, S.INFO_REQUESTED];
const DEFAULTS = { loo_template: "", loo_conditions: "", loo_signer_name: "", loo_signer_title: "", voe_template: "", letters_confirmed: false, docs_deadline_hours: 24, assessment_working_days: 5, declaration_items: [], privacy_notice: "", agent_not_signed_text: "", pre_enrolment_text: "" };
const fieldErrors = (errors, message = "Please check the highlighted fields.") => new AppError(400, message, { errors });
const need = (actor, perm) => { if (!APP_PERMS[perm].includes(actor.role)) throw new AppError(403, "You do not have permission to do that."); };
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
const clean = (x) => String(x || "").replace(/[\\/:*?"<>|\r\n\0]/g, " ").replace(/\s+/g, " ").trim();

const config = async () => ({ ...DEFAULTS, ...(await repo.settingsAll()) });
const studentName = (a) => `${a.student_given_names || ""} ${a.student_surname || ""}`.trim() || "the student";
const courseTitle = (a) => (a.course_code ? `${a.course_code} ` : "") + (a.course_name || "") + (a.course_specialisation ? ` (${a.course_specialisation})` : "");

// the few answers staff search and sort on
function columns(data) {
  const g = (s, f) => (data[s] || {})[f] ?? null;
  return {
    course_id: g("course", "course_id"), campus_id: g("course", "campus_id"), commencement_date: g("course", "commencement_date"),
    given: g("student", "given_names"), surname: g("student", "surname"), email: g("student", "email"), dob: g("student", "date_of_birth"),
    nationality: g("student", "nationality"), docs_received_on: g("confirmations", "docs_received_on"),
  };
}

async function agentFor(user) {
  if (user.role !== ROLES.AGENT) throw new AppError(403, "Only education agents submit student applications.");
  const a = await induction.assertUnlocked(user); // throws unless the induction is complete
  if (a.status !== "active") throw new AppError(403, "Your agreement must be active before you can submit student applications.");
  return a;
}
// reading your own applications does not need the induction, only that you are an agent
async function agentForRead(user) {
  if (user.role !== ROLES.AGENT) throw new AppError(403, "Only education agents use this page.");
  const agentRepo = require("../repositories/comsAgentRepo");
  const found = await agentRepo.findByPortalUser(user.id);
  const a = found && (await agentRepo.findById(found.id));
  if (!a || a.deleted_at) throw new AppError(404, "We could not find your application.");
  return a;
}
async function ownApplication(user, id) {
  const agent = await agentForRead(user);
  const app = await repo.find(id);
  if (!app || app.agent_id !== agent.id) throw new AppError(404, "Application not found.");
  return { agent, app };
}

// ---------- what the form screens need ----------
async function formConfig(user) {
  const agent = await agentForRead(user);
  const [cfg, campuses, courses, types, forms] = await Promise.all([config(), courseRepo.campuses(), courseRepo.list({ activeOnly: true }), repo.docTypes(), repo.forms({ activeOnly: true })]);
  const unlocked = (await induction.statusFor(agent.id, agent)).unlocked;
  return {
    can_submit: unlocked && agent.status === "active",
    blocked_reason: !unlocked ? "Please complete your induction first." : agent.status !== "active" ? "Your agreement must be active first." : null,
    campuses: campuses.filter((c) => c.active),
    courses: courses.map((c) => ({ id: c.id, code: c.code, name: c.name, specialisation: c.specialisation, course_type: c.course_type, campus_ids: c.campus_ids, duration_weeks: c.duration_weeks })),
    doc_types: types.filter((t) => t.active),
    forms,
    options: v.OPTIONS,
    declaration_items: cfg.declaration_items,
    privacy_notice: cfg.privacy_notice,
    agent_not_signed_text: cfg.agent_not_signed_text,
    pre_enrolment_text: cfg.pre_enrolment_text,
    docs_deadline_hours: cfg.docs_deadline_hours,
    assessment_working_days: cfg.assessment_working_days,
    agent: { legal_name: agent.legal_name },
  };
}

async function shape(app) {
  const [docs, history, types] = await Promise.all([repo.docs(app.id), repo.history(app.id), repo.docTypes()]);
  const required = types.filter((t) => t.active && t.required).map((t) => {
    const d = docs.filter((x) => x.kind === t.key).pop();
    return { kind: t.key, label: t.label, status: d ? d.status : "missing" };
  });
  const outputs = await require("./studentLetterService").outputs(app);
  return { ...app, documents: docs, history, required_documents: required, outputs, can_edit: EDITABLE.includes(app.status) };
}

const summaryRow = (a) => ({
  id: a.id, ref_no: a.ref_no, status: a.status, student: studentName(a), course: courseTitle(a), campus: a.campus_name,
  commencement_date: a.commencement_date, submitted_at: a.submitted_at, assessment_due: a.assessment_due, decision: a.decision, created_at: a.created_at, updated_at: a.updated_at,
});

async function listMine(user) {
  const agent = await agentForRead(user);
  return (await repo.listForAgent(agent.id)).map(summaryRow);
}
async function getMine(user, id) {
  const { app } = await ownApplication(user, id);
  return shape(app);
}

async function createDraft(user, ctx) {
  const agent = await agentFor(user);
  const person = await taskRepo.userById(user.id);
  const data = { agent: { counsellor_name: `${person.first_name} ${person.last_name || ""}`.trim(), counsellor_email: person.email, phone: agent.phone || undefined, counsellor_marn: agent.marn || undefined } };
  const id = await withTransaction(async (client) => {
    const newId = await repo.insert(client, { agentId: agent.id, userId: user.id, data, cols: columns(data) });
    await repo.log(client, { appId: newId, to: S.DRAFT, actorId: user.id, note: "Draft started" });
    await audit.log({ actorId: user.id, action: "student_application.created", entityType: "student_application", entityId: newId, ...ctx }, client);
    return newId;
  });
  return getMine(user, id);
}

// Each section the screen sends replaces the saved section. Boxes may be empty while the agent works.
async function saveDraft(user, id, body, ctx) {
  const { app } = await ownApplication(user, id);
  if (!EDITABLE.includes(app.status)) throw new AppError(409, "This application can no longer be changed.");
  const data = { ...app.data, ...body.data };
  await withTransaction(async (client) => {
    await repo.saveData(client, id, data, columns(data));
    await audit.log({ actorId: user.id, action: "student_application.saved", entityType: "student_application", entityId: id, metadata: { sections: Object.keys(body.data) }, ...ctx }, client);
  });
  return getMine(user, id);
}

async function discard(user, id, ctx) {
  const { app } = await ownApplication(user, id);
  if (app.status !== S.DRAFT) throw new AppError(409, "Only a draft can be discarded.");
  await withTransaction(async (client) => {
    await repo.discard(client, id);
    await audit.log({ actorId: user.id, action: "student_application.discarded", entityType: "student_application", entityId: id, ...ctx }, client);
  });
  return { id };
}

// ---------- documents ----------
async function addDocument(user, id, body, ctx) {
  const { app } = await ownApplication(user, id);
  if (!EDITABLE.includes(app.status)) throw new AppError(409, "Documents can no longer be added to this application.");
  const types = await repo.docTypes();
  if (!types.some((t) => t.key === body.kind && t.active)) throw fieldErrors({ kind: "Choose a document type from the list" });
  const up = parseUpload(body.file);
  const saved = await storage.save(up.buffer, up.ext, "students");
  try {
    await withTransaction(async (client) => {
      const fileId = await ddRepo.insertFile(client, { kind: "application_document", name: up.name, ...saved, mime: up.mime, actorId: user.id });
      if (body.kind !== "other") await repo.supersedeDocs(client, id, body.kind);
      await repo.insertDoc(client, { appId: id, kind: body.kind, label: body.label, fileId, userId: user.id });
      await audit.log({ actorId: user.id, action: "student_application.document_added", entityType: "student_application", entityId: id, after: { kind: body.kind, name: up.name }, ...ctx }, client);
    });
  } catch (e) { await storage.remove(saved.key); throw e; }
  return getMine(user, id);
}
async function removeDocument(user, id, docId, ctx) {
  const { app } = await ownApplication(user, id);
  if (!EDITABLE.includes(app.status)) throw new AppError(409, "Documents can no longer be removed from this application.");
  const d = await repo.doc(id, docId);
  if (!d) throw new AppError(404, "Document not found.");
  if (d.status === "accepted") throw new AppError(409, "The college has already accepted this document.");
  await withTransaction(async (client) => {
    await repo.removeDoc(client, docId, "Removed by the agent");
    await audit.log({ actorId: user.id, action: "student_application.document_removed", entityType: "student_application", entityId: id, before: { kind: d.kind, name: d.original_name }, ...ctx }, client);
  });
  return getMine(user, id);
}
const filingName = (app, d) => `${clean(studentName(app))} - ${clean(d.label || d.kind)} - ${calendar.localDate(d.created_at)}.${String(d.original_name).split(".").pop().toLowerCase()}`.slice(0, 200);
async function openDocument(actor, id, docId, ctx) {
  const app = await repo.find(id);
  if (!app) throw new AppError(404, "Application not found.");
  if (actor.role === ROLES.AGENT) await ownApplication(actor, id);
  else { need(actor, "read"); if (app.status === S.DRAFT) throw new AppError(404, "Application not found."); }
  const d = await repo.doc(id, docId);
  if (!d || !(await storage.exists(d.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: actor.id, action: "coms.file_downloaded", entityType: "file", entityId: d.file_id, metadata: { kind: "application_document", name: d.original_name, application: app.ref_no }, ...ctx });
  return { stream: storage.createReadStream(d.storage_key), name: filingName(app, d), mime: d.mime_type, size: d.size_bytes };
}

// ---------- checking the form before it is submitted ----------
async function problems(app, cfg) {
  const errors = {};
  const add = (section, field, msg) => { errors[`${section}.${field}`] = msg; };
  const data = {};
  for (const k of v.SECTIONS) data[k] = app.data[k] || {};
  data.addresses = { ...data.addresses, overseas: data.addresses.overseas || {} }; // so a missing address reports each box
  const parsed = v.submitForm.safeParse(data);
  if (!parsed.success) for (const i of parsed.error.issues) {
    const key = i.path.join(".");
    // zod's own wording for an empty box is not for agents
    const plain = i.code === "invalid_type" || i.code === "invalid_value" ? (i.message.includes("undefined") || i.message.includes("NaN") ? "Please answer this" : "Choose an answer from the list") : i.message;
    if (!errors[key]) errors[key] = plain;
  }
  const d = app.data;
  for (const [section, fields] of Object.entries(v.conditionalErrors(d))) for (const [f, m] of Object.entries(fields)) if (!errors[`${section}.${f}`]) add(section, f, m);

  const today = calendar.localDate();
  const g = (s, f) => (d[s] || {})[f];
  const commence = g("course", "commencement_date");
  if (commence && commence < today) add("course", "commencement_date", "The start date cannot be in the past");
  const dob = g("student", "date_of_birth");
  if (dob && commence) {
    const [y, m, day] = dob.split("-").map(Number);
    const eighteen = `${y + 18}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (eighteen > commence) add("student", "date_of_birth", "The student must be at least 18 when the course starts");
  }
  if (g("passport", "expiry") && g("passport", "expiry") <= today) add("passport", "expiry", "The passport has expired");
  if (g("confirmations", "docs_received_on") && g("confirmations", "docs_received_on") > today) add("confirmations", "docs_received_on", "This date is in the future");
  if (g("english", "test_date") && g("english", "test_date") > today) add("english", "test_date", "The test date is in the future");

  // the course must be on offer at the campus
  if (g("course", "course_id") && g("course", "campus_id")) {
    const c = (await courseRepo.list({ activeOnly: true })).find((x) => Number(x.id) === Number(g("course", "course_id")));
    if (!c || !c.campus_ids.map(Number).includes(Number(g("course", "campus_id")))) add("course", "course_id", "This course is not offered at that campus");
    else if (c.course_type === "ELICOS" && !g("course", "elicos_weeks")) add("course", "elicos_weeks", "Enter the number of weeks");
  }

  const items = (d.declaration || {}).items || [];
  if (cfg.declaration_items.length && (items.length < cfg.declaration_items.length || items.slice(0, cfg.declaration_items.length).some((x) => x !== true))) add("declaration", "items", "The student must tick every declaration");
  if (g("confirmations", "pre_enrolment_sent") !== true) add("confirmations", "pre_enrolment_sent", "Confirm that the pre-enrolment pack was sent");
  if (g("confirmations", "agent_not_signed") !== true) add("confirmations", "agent_not_signed", "Confirm that you did not sign for the student");

  const docs = await repo.docs(app.id);
  const missing = (await repo.docTypes()).filter((t) => t.active && t.required && !docs.some((x) => x.kind === t.key)).map((t) => t.label);
  if (missing.length) errors.documents = `Please upload: ${missing.join("; ")}`;
  return errors;
}

async function submit(user, id, ctx) {
  const agent = await agentFor(user);
  const { app } = await ownApplication(user, id);
  if (!EDITABLE.includes(app.status)) throw new AppError(409, "This application has already been submitted.");
  const cfg = await config();
  const errors = await problems(app, cfg);
  if (Object.keys(errors).length) throw fieldErrors(errors, "Some answers need attention before you can submit.");

  const d = app.data;
  const today = calendar.localDate();
  const graceDays = Math.max(1, Math.ceil(Number(cfg.docs_deadline_hours) / 24));
  const late = calendar.addDays(app.docs_received_on, graceDays) < today;
  const cs = d.current_studies || {};
  const transfer = cs.enrolled_elsewhere === true && cs.is_principal === true && cs.released === false && Number(cs.months_completed) < 12;
  const first = app.status === S.DRAFT;
  const due = first ? await calendar.addBusinessDays(today, Number(cfg.assessment_working_days)) : app.assessment_due;
  const to = first ? S.RECEIVED : S.UNDER_REVIEW;

  const ref = await withTransaction(async (client) => {
    const refNo = app.ref_no || (await repo.nextRef(client));
    await repo.markSubmitted(client, id, { status: to, ref: refNo, late, transfer, credit: (d.credit || {}).apply === true, due });
    await repo.log(client, { appId: id, from: app.status, to, actorId: user.id, note: first ? "Submitted by the agent" : "Agent replied to the request for information" });
    await audit.log({ actorId: user.id, action: first ? "student_application.submitted" : "student_application.resubmitted", entityType: "student_application", entityId: id, metadata: { ref: refNo, late }, ...ctx }, client);
    return refNo;
  });

  const fresh = await repo.find(id);
  if (first) await notifySubmitted(fresh, agent, user);
  return getMine(user, id);
}

async function notifySubmitted(app, agent, user) {
  const person = await taskRepo.userById(user.id);
  const dueText = app.assessment_due ? new Date(`${app.assessment_due}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
  const base = { ref: app.ref_no, studentName: studentName(app), courseName: courseTitle(app), campusName: app.campus_name, dueText, agentName: agent.legal_name };
  email.sendStudentAppReceived({ ...base, to: person.email, firstName: person.first_name, forStudent: false, link: `${env.frontendUrl}/agent/applications/${app.id}` });
  if (app.student_email) email.sendStudentAppReceived({ ...base, to: app.student_email, firstName: app.student_given_names || "there", forStudent: true });
  const flags = [];
  if (app.late_submission) flags.push("submitted more than 24 hours after the agent received the documents");
  if (app.needs_transfer_review) flags.push("the student may be inside 12 months of a principal course with another provider (National Code Standard 7)");
  if (app.wants_credit) flags.push("the student wants to apply for RPL or credit transfer");
  let staff = await taskRepo.usersWithRoles([ROLES.ADMISSIONS]);
  if (!staff.length) staff = await taskRepo.usersWithRoles([ROLES.DIRECTOR, ROLES.ADMIN]);
  for (const u of staff) email.sendStudentAppToStaff({ ...base, to: u.email, firstName: u.first_name, flags, link: `${env.frontendUrl}/coms/applications/${app.id}` });
}

// ---------- downloadable forms (for agents and staff) ----------
async function openForm(actor, formId, ctx) {
  const f = await repo.form(formId);
  if (!f || (!f.active && actor.role === ROLES.AGENT) || !(await storage.exists(f.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: actor.id, action: "coms.file_downloaded", entityType: "file", entityId: f.file_id, metadata: { kind: "student_form", name: f.original_name }, ...ctx });
  return { stream: storage.createReadStream(f.storage_key), name: clean(f.label) + "." + String(f.original_name).split(".").pop().toLowerCase(), mime: f.mime_type, size: f.size_bytes };
}

// ---------- administrators: wording, numbers, documents, forms ----------
async function adminGet(actor) {
  need(actor, "settings");
  const [cfg, types, forms] = await Promise.all([config(), repo.docTypes(), repo.forms({ activeOnly: false })]);
  return { settings: Object.fromEntries(["declaration_items", "privacy_notice", "agent_not_signed_text", "pre_enrolment_text", "docs_deadline_hours", "assessment_working_days", "loo_template", "loo_conditions", "loo_signer_name", "loo_signer_title", "voe_template", "letters_confirmed"].map((k) => [k, cfg[k]])), doc_types: types, forms };
}
async function adminSaveSettings(actor, body, ctx) {
  need(actor, "settings");
  const before = (await adminGet(actor)).settings;
  await withTransaction(async (client) => {
    for (const [k, val] of Object.entries(body)) await repo.settingSet(client, k, val, actor.id);
    await audit.log({ actorId: actor.id, action: "student_application.settings_saved", entityType: "settings", entityId: "student_applications", before, after: body, ...ctx }, client);
  });
  return adminGet(actor);
}
async function adminSaveDocTypes(actor, { items }, ctx) {
  need(actor, "settings");
  const existing = new Map((await repo.docTypes()).map((t) => [t.key, t]));
  const seen = new Set();
  const rows = items.map((it, i) => {
    let key = it.key;
    if (key && !existing.has(key)) throw fieldErrors({ [`items.${i}.key`]: "Unknown document type" });
    if (!key) { const base = slug(it.label); key = base; for (let n = 2; existing.has(key) || seen.has(key); n++) key = `${base}_${n}`; }
    if (seen.has(key)) throw fieldErrors({ [`items.${i}.key`]: "Listed twice" });
    seen.add(key);
    return { key, label: it.label, required: it.required && it.active, active: it.active, sort: i + 1 };
  });
  for (const k of existing.keys()) if (!seen.has(k)) throw new AppError(400, "Document types cannot be deleted, only switched off.", { errors: { items: "Keep every document type in the list; switch off the ones you no longer want." } });
  if (!rows.some((r) => r.key === "signed_form" && r.active && r.required)) throw fieldErrors({ items: "The signed enrolment form must stay switched on and required" });
  const before = [...existing.values()];
  await withTransaction(async (client) => {
    for (const r of rows) await repo.docTypeUpsert(client, r);
    await audit.log({ actorId: actor.id, action: "student_application.document_types_saved", entityType: "settings", entityId: "student_applications", before, after: rows, ...ctx }, client);
  });
  return adminGet(actor);
}
async function adminUploadForm(actor, body, ctx) {
  need(actor, "settings");
  const up = parseUpload(body.file);
  const saved = await storage.save(up.buffer, up.ext, "forms");
  try {
    await withTransaction(async (client) => {
      const fileId = await ddRepo.insertFile(client, { kind: "student_form", name: up.name, ...saved, mime: up.mime, actorId: actor.id });
      const formId = await repo.insertForm(client, { label: body.label, fileId, userId: actor.id });
      await audit.log({ actorId: actor.id, action: "student_application.form_uploaded", entityType: "student_form", entityId: formId, after: { label: body.label, name: up.name }, ...ctx }, client);
    });
  } catch (e) { await storage.remove(saved.key); throw e; }
  return adminGet(actor);
}
async function adminToggleForm(actor, formId, { active }, ctx) {
  need(actor, "settings");
  if (!(await repo.form(formId))) throw new AppError(404, "Form not found.");
  await withTransaction(async (client) => {
    await repo.setFormActive(client, formId, active);
    await audit.log({ actorId: actor.id, action: active ? "student_application.form_shown" : "student_application.form_hidden", entityType: "student_form", entityId: formId, ...ctx }, client);
  });
  return adminGet(actor);
}

module.exports = {
  config, clean, filingName, studentName, courseTitle,
  formConfig, listMine, getMine, createDraft, saveDraft, discard, addDocument, removeDocument, openDocument, submit, openForm,
  adminGet, adminSaveSettings, adminSaveDocTypes, adminUploadForm, adminToggleForm, summaryRow, shape, problems,
};
