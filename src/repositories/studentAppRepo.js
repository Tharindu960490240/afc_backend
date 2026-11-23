const { query } = require("../config/db");
const q = (client) => client || { query };

const ISO = (c) => `to_char(${c}, 'YYYY-MM-DD')`;
const COLS = `a.id, a.ref_no, a.agent_id, a.created_by, a.status, a.decision, a.decision_reason, a.decided_at, a.form_version, a.data,
  a.course_id, a.campus_id, ${ISO("a.commencement_date")} AS commencement_date, a.student_given_names, a.student_surname, a.student_email,
  ${ISO("a.date_of_birth")} AS date_of_birth, a.nationality, ${ISO("a.docs_received_on")} AS docs_received_on,
  a.submitted_at, a.payment_confirmed_at, a.payment_note, a.coe_number, ${ISO("a.coe_issued_on")} AS coe_issued_on, a.coe_file_id, a.voe_issued_at, a.voe_file_id, a.late_submission, a.needs_transfer_review, a.wants_credit, ${ISO("a.assessment_due")} AS assessment_due,
  a.created_at, a.updated_at,
  ag.legal_name AS agent_name, c.code AS course_code, c.name AS course_name, c.specialisation AS course_specialisation, k.name AS campus_name`;
const FROM = `FROM student_applications a JOIN agents ag ON ag.id = a.agent_id
  LEFT JOIN courses c ON c.id = a.course_id LEFT JOIN campuses k ON k.id = a.campus_id`;

const find = async (id, client) => (await q(client).query(`SELECT ${COLS} ${FROM} WHERE a.id = $1 AND a.deleted_at IS NULL`, [id])).rows[0];
const listForAgent = async (agentId) =>
  (await query(`SELECT ${COLS} ${FROM} WHERE a.agent_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at DESC`, [agentId])).rows;

const insert = async (client, { agentId, userId, data, cols }) =>
  (await client.query(
    `INSERT INTO student_applications (agent_id, created_by, data, course_id, campus_id, commencement_date, student_given_names, student_surname, student_email, date_of_birth, nationality, docs_received_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [agentId, userId, data, cols.course_id, cols.campus_id, cols.commencement_date, cols.given, cols.surname, cols.email, cols.dob, cols.nationality, cols.docs_received_on],
  )).rows[0].id;

const saveData = (client, id, data, cols) =>
  client.query(
    `UPDATE student_applications SET data = $2, course_id = $3, campus_id = $4, commencement_date = $5, student_given_names = $6, student_surname = $7,
       student_email = $8, date_of_birth = $9, nationality = $10, docs_received_on = $11, updated_at = now() WHERE id = $1`,
    [id, data, cols.course_id, cols.campus_id, cols.commencement_date, cols.given, cols.surname, cols.email, cols.dob, cols.nationality, cols.docs_received_on],
  );
const discard = (client, id) => client.query(`UPDATE student_applications SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);

const nextRef = async (client) => {
  const n = (await client.query(`SELECT nextval('student_application_seq') AS n`)).rows[0].n;
  return `SA-${new Date().getUTCFullYear()}-${String(n).padStart(4, "0")}`;
};
const markSubmitted = (client, id, v) =>
  client.query(
    `UPDATE student_applications SET status = $2, ref_no = COALESCE(ref_no, $3), submitted_at = COALESCE(submitted_at, now()),
       late_submission = late_submission OR $4, needs_transfer_review = $5, wants_credit = $6, assessment_due = COALESCE(assessment_due, $7), updated_at = now() WHERE id = $1`,
    [id, v.status, v.ref, v.late, v.transfer, v.credit, v.due],
  );

// ---- staff ----
const staffList = async ({ status, q, attention }) => {
  const where = [`a.deleted_at IS NULL`, `a.status <> 'draft'`];
  const args = [];
  if (status) { args.push(status); where.push(`a.status = $${args.length}`); }
  if (q) { args.push(`%${q}%`); where.push(`(a.ref_no ILIKE $${args.length} OR a.student_given_names || ' ' || a.student_surname ILIKE $${args.length} OR ag.legal_name ILIKE $${args.length})`); }
  if (attention) where.push(`(a.late_submission OR a.needs_transfer_review OR a.wants_credit)`);
  return (await query(`SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY (a.status IN ('received','under_review')) DESC, a.assessment_due NULLS LAST, a.submitted_at DESC LIMIT 500`, args)).rows;
};
const setStatus = (client, id, { status, decision, reason, userId }) =>
  client.query(
    `UPDATE student_applications SET status = $2, decision = COALESCE($3, decision), decision_reason = COALESCE($4, decision_reason),
       decided_by = CASE WHEN $3::text IS NULL THEN decided_by ELSE $5 END, decided_at = CASE WHEN $3::text IS NULL THEN decided_at ELSE now() END,
       assessed_by = COALESCE(assessed_by, $5), updated_at = now() WHERE id = $1`,
    [id, status, decision || null, reason || null, userId || null],
  );
const reviewDoc = (client, appId, docId, { status, note, userId }) =>
  client.query(`UPDATE application_documents SET status = $3, review_note = $4, reviewed_by = $5, reviewed_at = now() WHERE id = $2 AND application_id = $1 AND deleted_at IS NULL`, [appId, docId, status, note || null, userId]);
const dueForAlert = async () =>
  (await query(`SELECT ${COLS} ${FROM} WHERE a.deleted_at IS NULL AND a.status IN ('received','under_review') AND a.day4_alerted_at IS NULL AND a.assessment_due IS NOT NULL`)).rows;
const markAlerted = (id) => query(`UPDATE student_applications SET day4_alerted_at = now() WHERE id = $1`, [id]);
const counts = async () => Object.fromEntries((await query(`SELECT status, count(*)::int AS n FROM student_applications WHERE deleted_at IS NULL AND status <> 'draft' GROUP BY status`)).rows.map((r) => [r.status, r.n]));

// ---- Letter of Offer, payment, CoE, VoE ----
const LCOLS = `l.id, l.application_id, l.version, l.status, l.body, l.tuition_fee, l.material_fee, l.enrolment_fee, l.issued_at, l.file_id, l.created_at, l.updated_at,
  trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) AS prepared_by_name, trim(coalesce(i.first_name,'') || ' ' || coalesce(i.last_name,'')) AS issued_by_name`;
const LFROM = `FROM letters_of_offer l LEFT JOIN users p ON p.id = l.prepared_by LEFT JOIN users i ON i.id = l.issued_by`;
const liveLetter = async (appId, client) => (await q(client).query(`SELECT ${LCOLS} ${LFROM} WHERE l.application_id = $1 AND l.status IN ('draft','issued')`, [appId])).rows[0];
const letterCount = async (appId, client) => (await q(client).query(`SELECT count(*)::int AS n FROM letters_of_offer WHERE application_id = $1`, [appId])).rows[0].n;
const insertLetter = async (client, l) =>
  (await client.query(`INSERT INTO letters_of_offer (application_id, version, body, tuition_fee, material_fee, enrolment_fee, prepared_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [l.appId, l.version, l.body, l.tuition, l.material, l.enrolment, l.userId])).rows[0].id;
const saveLetter = (client, id, l) =>
  client.query(`UPDATE letters_of_offer SET body = $2, tuition_fee = $3, material_fee = $4, enrolment_fee = $5, updated_at = now() WHERE id = $1 AND status = 'draft'`, [id, l.body, l.tuition, l.material, l.enrolment]);
const issueLetter = (client, id, { fileId, userId }) =>
  client.query(`UPDATE letters_of_offer SET status = 'issued', file_id = $2, issued_by = $3, issued_at = now(), updated_at = now() WHERE id = $1`, [id, fileId, userId]);
const supersedeLetter = (client, id) => client.query(`UPDATE letters_of_offer SET status = 'superseded', updated_at = now() WHERE id = $1`, [id]);
const fileOf = async (fileId) => (await query(`SELECT id, original_name, mime_type, size_bytes, storage_key FROM coms_files WHERE id = $1`, [fileId])).rows[0];
const confirmPayment = (client, id, { note, userId }) =>
  client.query(`UPDATE student_applications SET payment_confirmed_at = now(), payment_confirmed_by = $3, payment_note = $2, updated_at = now() WHERE id = $1`, [id, note || null, userId]);
const recordCoe = (client, id, { number, issuedOn, fileId, userId }) =>
  client.query(`UPDATE student_applications SET status = 'coe_issued', coe_number = $2, coe_issued_on = $3, coe_file_id = $4, coe_recorded_by = $5, updated_at = now() WHERE id = $1`, [id, number, issuedOn, fileId || null, userId]);
const recordVoe = (client, id, { fileId, userId }) =>
  client.query(`UPDATE student_applications SET voe_issued_at = now(), voe_issued_by = $3, voe_file_id = $2, updated_at = now() WHERE id = $1`, [id, fileId, userId]);

// ---- documents ----
const DCOLS = `d.id, d.application_id, d.kind, d.label, d.status, d.review_note, d.reviewed_at, d.created_at, d.file_id,
  f.original_name, f.size_bytes, f.mime_type`;
const DFROM = `FROM application_documents d JOIN coms_files f ON f.id = d.file_id`;
const docs = async (appId, client) =>
  (await q(client).query(`SELECT ${DCOLS} ${DFROM} WHERE d.application_id = $1 AND d.deleted_at IS NULL ORDER BY d.created_at, d.id`, [appId])).rows;
const doc = async (appId, docId) =>
  (await query(`SELECT ${DCOLS}, f.storage_key ${DFROM} WHERE d.id = $2 AND d.application_id = $1 AND d.deleted_at IS NULL`, [appId, docId])).rows[0];
const insertDoc = async (client, d) =>
  (await client.query(`INSERT INTO application_documents (application_id, kind, label, file_id, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [d.appId, d.kind, d.label || null, d.fileId, d.userId || null])).rows[0].id;
const removeDoc = (client, id, reason) => client.query(`UPDATE application_documents SET deleted_at = now(), delete_reason = $2 WHERE id = $1`, [id, reason]);
const supersedeDocs = (client, appId, kind) =>
  client.query(`UPDATE application_documents SET deleted_at = now(), delete_reason = 'Replaced by a newer upload' WHERE application_id = $1 AND kind = $2 AND deleted_at IS NULL AND status <> 'accepted'`, [appId, kind]);

// ---- status log ----
const log = (client, { appId, from, to, actorId, note }) =>
  client.query(`INSERT INTO application_status_log (application_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5)`, [appId, from || null, to, actorId || null, note || null]);
const history = async (appId) =>
  (await query(`SELECT l.id, l.from_status, l.to_status, l.note, l.created_at, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS actor_name, u.role AS actor_role
     FROM application_status_log l LEFT JOIN users u ON u.id = l.actor_id WHERE l.application_id = $1 ORDER BY l.id`, [appId])).rows;

// ---- settings, document types, downloadable forms ----
const settingsAll = async () => Object.fromEntries((await query(`SELECT key, value FROM student_app_settings`)).rows.map((r) => [r.key, r.value]));
const settingSet = (client, key, value, userId) =>
  client.query(`INSERT INTO student_app_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, JSON.stringify(value), userId]);
const docTypes = async (client) => (await q(client).query(`SELECT key, label, required, active, sort_order FROM application_doc_types ORDER BY sort_order, key`)).rows;
const docTypeUpsert = (client, t) =>
  client.query(`INSERT INTO application_doc_types (key, label, required, active, sort_order) VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, required = EXCLUDED.required, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order`, [t.key, t.label, t.required, t.active, t.sort]);
const forms = async ({ activeOnly }) =>
  (await query(`SELECT f.id, f.label, f.active, f.created_at, x.original_name, x.size_bytes FROM student_forms f JOIN coms_files x ON x.id = f.file_id ${activeOnly ? "WHERE f.active" : ""} ORDER BY f.created_at DESC`)).rows;
const form = async (id) =>
  (await query(`SELECT f.id, f.label, f.active, x.original_name, x.mime_type, x.size_bytes, x.storage_key, x.id AS file_id FROM student_forms f JOIN coms_files x ON x.id = f.file_id WHERE f.id = $1`, [id])).rows[0];
const insertForm = async (client, { label, fileId, userId }) =>
  (await client.query(`INSERT INTO student_forms (label, file_id, uploaded_by) VALUES ($1,$2,$3) RETURNING id`, [label, fileId, userId])).rows[0].id;
const setFormActive = (client, id, active) => client.query(`UPDATE student_forms SET active = $2 WHERE id = $1`, [id, active]);

module.exports = {
  liveLetter, letterCount, insertLetter, saveLetter, issueLetter, supersedeLetter, fileOf, confirmPayment, recordCoe, recordVoe,
  staffList, setStatus, reviewDoc, dueForAlert, markAlerted, counts,
  find, listForAgent, insert, saveData, discard, nextRef, markSubmitted,
  docs, doc, insertDoc, removeDoc, supersedeDocs, log, history,
  settingsAll, settingSet, docTypes, docTypeUpsert, forms, form, insertForm, setFormActive,
};
