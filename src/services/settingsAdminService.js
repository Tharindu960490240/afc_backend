// The Settings screen (administrators only): reference questions, document types, timers, college details, onboarding tasks.
const { withTransaction, query } = require("../config/db");
const AppError = require("../utils/AppError");
const audit = require("../repositories/auditRepo");
const settings = require("./settingsService");
const college = require("../emails/college");
const { parseSignatureImage } = require("./agreementDocument");
const { STAFF_ROLES } = require("../const");

const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
const COLLEGE_FIELDS = ["name", "abn", "rto", "cricos", "phone", "email", "website", "websiteLabel", "campuses", "signer_name", "signer_position"];

function uniqueKey(label, taken) {
  const base = slug(label);
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  taken.add(key);
  return key;
}

async function getAll() {
  await settings.reload();
  const c = college;
  return {
    reference_questions: settings.allQuestions().map(({ key, label, type, required, favourable, ask_details, active }) => ({ key, label, type, required, favourable, ask_details, active })),
    document_types: settings.allDocTypes().map(({ key, label, file_name, required, active }) => ({ key, label, file_name, required, active })),
    timers: settings.timers(),
    timer_defaults: settings.TIMER_DEFAULTS,
    college: {
      name: c.name, abn: c.abn, rto: c.rto, cricos: c.cricos, phone: c.phone, email: c.email, website: c.website, websiteLabel: c.websiteLabel,
      campuses: c.campuses, signer_name: c.signer.name, signer_position: c.signer.position,
    },
    has_custom_signature: !!settings.signatureImage(),
    onboarding_tasks: settings.taskTemplates().map(({ type, title, owner_role, due_days, due_basis, prefer_account_manager, enabled }) => ({ type, title, owner_role, due_days, due_basis, prefer_account_manager, enabled })),
    roles: STAFF_ROLES,
  };
}

const log = (actor, action, key, before, after, ctx) =>
  audit.log({ actorId: actor.id, action, entityType: "settings", entityId: key, before, after, ...ctx });

// ---- reference questions ----
async function saveQuestions(actor, { items }, ctx) {
  const before = settings.allQuestions().map(({ key, label, type, required, favourable, ask_details, active }) => ({ key, label, type, required, favourable, ask_details, active }));
  const existing = new Set(before.map((q) => q.key));
  const taken = new Set(existing);
  const seen = new Set();
  const rows = items.map((it, i) => {
    if (it.key && !existing.has(it.key)) throw fieldError(`items.${i}.key`, "Unknown question");
    if (it.key && seen.has(it.key)) throw fieldError(`items.${i}.key`, "Question listed twice");
    if (it.key) seen.add(it.key);
    const favourable = it.type === "yesno" && it.favourable !== undefined ? it.favourable : null;
    return { ...it, key: it.key || uniqueKey(it.label, taken), favourable, ask_details: favourable !== null && !!it.ask_details, sort_order: i + 1 };
  });
  for (const k of existing) if (!seen.has(k)) throw new AppError(400, "Questions cannot be deleted, only switched off.", { errors: { items: "Keep every question in the list; switch off the ones you no longer want." } });
  const active = rows.filter((r) => r.active);
  if (!active.length) throw fieldError("items", "At least one question must stay switched on");
  if (!active.some((r) => r.favourable !== null)) throw fieldError("items", "At least one yes/no question needs a favourable answer, otherwise every reference counts as positive");
  await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO reference_questions (key, label, type, required, favourable, ask_details, sort_order, active, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$9,$6,$7,$8,now())
         ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label, type=EXCLUDED.type, required=EXCLUDED.required, favourable=EXCLUDED.favourable, ask_details=EXCLUDED.ask_details,
           sort_order=EXCLUDED.sort_order, active=EXCLUDED.active, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [r.key, r.label, r.type, r.required, r.favourable, r.sort_order, r.active, actor.id, r.ask_details]);
    }
    await log(actor, "settings.reference_questions_updated", "reference_questions", before, rows.map(({ key, label, type, required, favourable, ask_details, active }) => ({ key, label, type, required, favourable, ask_details, active })), ctx);
  });
  await settings.reload();
  return getAll();
}

// ---- document types ----
async function saveDocTypes(actor, { items }, ctx) {
  const before = settings.allDocTypes().map(({ key, label, file_name, required, active }) => ({ key, label, file_name, required, active }));
  const existing = new Set(before.map((d) => d.key));
  const taken = new Set(existing);
  const seen = new Set();
  const rows = items.map((it, i) => {
    if (it.key && !existing.has(it.key)) throw fieldError(`items.${i}.key`, "Unknown document type");
    if (it.key) seen.add(it.key);
    if (it.required && !it.active) throw fieldError(`items.${i}.required`, "A document that is switched off cannot be required");
    return { ...it, key: it.key || uniqueKey(it.label, taken), sort_order: i + 1 };
  });
  for (const k of existing) if (!seen.has(k)) throw new AppError(400, "Document types cannot be deleted, only switched off.", { errors: { items: "Keep every type in the list; switch off the ones you no longer want." } });
  const other = rows.find((r) => r.key === "other");
  if (!other || !other.active || other.required) throw fieldError("items", "'Other supporting document' must stay switched on and optional");
  await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO document_types (key, label, file_name, required, sort_order, active, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label, file_name=EXCLUDED.file_name, required=EXCLUDED.required, sort_order=EXCLUDED.sort_order,
           active=EXCLUDED.active, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [r.key, r.label, r.file_name, r.required, r.sort_order, r.active, actor.id]);
    }
    await log(actor, "settings.document_types_updated", "document_types", before, rows.map(({ key, label, file_name, required, active }) => ({ key, label, file_name, required, active })), ctx);
  });
  await settings.reload();
  return getAll();
}

// ---- timers ----
async function saveTimers(actor, body, ctx) {
  if (body.amber_after_days > body.decision_days) throw fieldError("amber_after_days", "The amber warning must come on or before the decision deadline");
  const before = settings.timers();
  await settings.save("timers", body, actor.id);
  await log(actor, "settings.timers_updated", "timers", before, body, ctx);
  return getAll();
}

// ---- college details and certificate signatory ----
async function saveCollege(actor, body, ctx) {
  const before = (await getAll()).college;
  const clean = {};
  for (const f of COLLEGE_FIELDS) {
    const v = body[f];
    if (Array.isArray(v) ? v.length : v) clean[f] = v;
  }
  await settings.save("college", clean, actor.id);
  await log(actor, "settings.college_updated", "college", before, (await getAll()).college, ctx);
  return getAll();
}
async function saveSignature(actor, { signature_image: image }, ctx) {
  const buf = parseSignatureImage(image);
  if (!buf) throw fieldError("signature_image", "Choose a PNG image of the signature");
  await settings.save("signature", { data: buf.toString("base64") }, actor.id);
  await log(actor, "settings.signature_changed", "signature", { custom: false }, { custom: true, bytes: buf.length }, ctx);
  return getAll();
}
async function removeSignature(actor, ctx) {
  await settings.remove("signature");
  await log(actor, "settings.signature_removed", "signature", { custom: true }, { custom: false }, ctx);
  return getAll();
}

// ---- onboarding tasks ----
const MUST_STAY_ON = ["PRISMS_ADD", "INDUCTION"]; // an agent cannot become Active without them
async function saveTasks(actor, { items }, ctx) {
  const current = settings.taskTemplates();
  const known = new Set(current.map((t) => t.type));
  const before = current.map(({ type, title, owner_role, due_days, due_basis, prefer_account_manager, enabled }) => ({ type, title, owner_role, due_days, due_basis, prefer_account_manager, enabled }));
  const seen = new Set();
  items.forEach((it, i) => {
    if (!known.has(it.type)) throw fieldError(`items.${i}.type`, "Unknown task");
    if (seen.has(it.type)) throw fieldError(`items.${i}.type`, "Task listed twice");
    seen.add(it.type);
    if (!STAFF_ROLES.includes(it.owner_role)) throw fieldError(`items.${i}.owner_role`, "Choose a staff role");
    if (MUST_STAY_ON.includes(it.type) && !it.enabled) throw fieldError(`items.${i}.enabled`, "This task is needed to make the agent Active and cannot be switched off");
  });
  await withTransaction(async (client) => {
    for (const it of items) {
      await client.query(
        `UPDATE onboarding_task_templates SET title=$2, owner_role=$3, due_days=$4, due_basis=$5, prefer_account_manager=$6, enabled=$7, updated_by=$8, updated_at=now() WHERE type=$1`,
        [it.type, it.title, it.owner_role, it.due_days, it.due_basis, it.prefer_account_manager, it.enabled, actor.id]);
    }
    await log(actor, "settings.onboarding_tasks_updated", "onboarding_tasks", before, items, ctx);
  });
  await settings.reload();
  return getAll();
}

module.exports = { getAll, saveQuestions, saveDocTypes, saveTimers, saveCollege, saveSignature, removeSignature, saveTasks };
