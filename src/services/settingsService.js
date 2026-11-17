// Settings the college can change (see migration 010). Read synchronously from a short-lived cache so the rest of
// the code stays simple; `ensureFresh()` runs before every request and every scheduled job.
// Until the first load (or if the tables are missing) the built-in defaults from const.js are used.
const { query } = require("../config/db");
const C = require("../const");

const TTL_MS = 30 * 1000;
let cache = null;
let loadedAt = 0;
let loading = null;

const TIMER_DEFAULTS = Object.freeze({ ack_days: 3, decision_days: 10, amber_after_days: 7, referee_link_days: 21, referee_reminder_days: 3, referee_max_reminders: 2, task_escalation_days: 4 });

const defaults = () => ({
  questions: C.REFERENCE_QUESTIONS.map((q, i) => ({ key: q.key, label: q.label, type: q.type, required: q.required, favourable: "favourable" in q ? q.favourable : null, ask_details: !!q.detail, sort_order: i + 1, active: true })),
  docTypes: Object.entries(C.DOC_KINDS).map(([key, d], i) => ({ key, label: d.label, file_name: d.file, required: !!d.required, sort_order: i + 1, active: true })),
  tasks: [],
  values: {},
});

async function load() {
  try {
    const [q, d, t, s] = await Promise.all([
      query(`SELECT id, key, label, type, required, favourable, ask_details, sort_order, active FROM reference_questions ORDER BY sort_order, id`),
      query(`SELECT key, label, file_name, required, sort_order, active FROM document_types ORDER BY sort_order, key`),
      query(`SELECT * FROM onboarding_task_templates ORDER BY sort_order, type`),
      query(`SELECT key, value FROM settings`),
    ]);
    cache = { questions: q.rows, docTypes: d.rows, tasks: t.rows, values: Object.fromEntries(s.rows.map((r) => [r.key, r.value])) };
  } catch (err) {
    // tables not created yet (migration 010 not run): keep working with the built-in defaults
    if (!cache) cache = defaults();
    if (!/relation .* does not exist/.test(err.message)) console.error("settings load failed:", err.message);
  }
  loadedAt = Date.now();
}

async function ensureFresh() {
  if (cache && Date.now() - loadedAt < TTL_MS) return;
  loading = loading || load().finally(() => { loading = null; });
  await loading;
}
const reload = async () => { loadedAt = 0; await ensureFresh(); };
const data = () => cache || defaults();

// ---- reference questions ----
const allQuestions = () => data().questions;
const questions = () => allQuestions().filter((q) => q.active).map((q) => ({
  key: q.key, type: q.type, label: q.label, required: !!q.required,
  favourable: q.favourable === null || q.favourable === undefined ? undefined : q.favourable,
  detail: q.type === "yesno" && !!q.ask_details && q.favourable !== null && q.favourable !== undefined,
}));

// ---- document types ----
const allDocTypes = () => data().docTypes;
// the shape the screens already use: { key: { label, file, required, active } }
const docKinds = ({ includeInactive = true } = {}) =>
  Object.fromEntries(allDocTypes().filter((d) => includeInactive || d.active).map((d) => [d.key, { label: d.label, file: d.file_name, required: !!d.required && !!d.active, active: !!d.active }]));
const requiredDocKinds = () => allDocTypes().filter((d) => d.required && d.active).map((d) => d.key);

// ---- timers ----
const timers = () => ({ ...TIMER_DEFAULTS, ...(data().values.timers || {}) });

// ---- college details and certificate signatory ----
const collegeValues = () => data().values.college || {};
const signatureImage = () => {
  const v = data().values.signature;
  return v && v.data ? Buffer.from(v.data, "base64") : null;
};

// ---- onboarding task templates ----
const taskTemplates = () => data().tasks;

async function save(key, value, actorId) {
  await query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), actorId || null]);
  await reload();
}
const remove = async (key) => { await query(`DELETE FROM settings WHERE key = $1`, [key]); await reload(); };

module.exports = {
  ensureFresh, reload, save, remove, TIMER_DEFAULTS,
  allQuestions, questions, allDocTypes, docKinds, requiredDocKinds, timers, collegeValues, signatureImage, taskTemplates,
};
