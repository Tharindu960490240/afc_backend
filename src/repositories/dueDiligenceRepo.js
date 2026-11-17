const { query } = require("../config/db");

const q = (client) => client || { query };

// ---------- files ----------
const insertFile = async (client, f) =>
  (await q(client).query(
    `INSERT INTO coms_files (kind, original_name, storage_key, mime_type, size_bytes, sha256, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [f.kind, f.name, f.key, f.mime, f.size, f.sha256, f.actorId || null],
  )).rows[0].id;
const findFile = async (id) => (await query(`SELECT * FROM coms_files WHERE id = $1`, [id])).rows[0];
const fileInfo = (alias) => `(SELECT json_build_object('id', f.id, 'name', f.original_name, 'size', f.size_bytes)
                              FROM coms_files f WHERE f.id = ${alias}) `;

// ---------- the due-diligence record ----------
const find = async (agentId, client) =>
  (await q(client).query(
    `SELECT d.*, ${fileInfo("d.coi_file_id")} AS coi_file,
            ob.first_name AS opened_first, ob.last_name AS opened_last,
            db.first_name AS decided_first, db.last_name AS decided_last,
            (SELECT COALESCE(json_agg(trim(u.first_name || ' ' || u.last_name)), '[]'::json)
               FROM users u WHERE u.id = ANY(d.preparers)) AS preparer_names
     FROM agent_due_diligence d
     LEFT JOIN users ob ON ob.id = d.opened_by
     LEFT JOIN users db ON db.id = d.decided_by
     WHERE d.agent_id = $1`, [agentId])).rows[0];

// prepared = false when the record is only created to hold a decision (nobody prepared anything)
const open = (client, agentId, actorId, prepared = true) =>
  client.query(
    `INSERT INTO agent_due_diligence (agent_id, opened_by, preparers)
     VALUES ($1,$2, CASE WHEN $3::boolean THEN ARRAY[$2]::bigint[] ELSE '{}'::bigint[] END)
     ON CONFLICT (agent_id) DO NOTHING`, [agentId, actorId, prepared]);

const addPreparer = (client, agentId, actorId) =>
  client.query(
    `UPDATE agent_due_diligence SET preparers = array_append(preparers, $2::bigint)
     WHERE agent_id = $1 AND NOT ($2::bigint = ANY(preparers))`, [agentId, actorId]);

const setCheck = (client, agentId, key, { status, note }, actorId) =>
  client.query(
    `UPDATE agent_due_diligence SET ${key}_check_status = $2, ${key}_check_note = $3,
       ${key}_checked_at = now(), ${key}_checked_by = $4 WHERE agent_id = $1`,
    [agentId, status, note || null, actorId]);

const setCoiReview = (client, agentId, { note, fileId }, actorId) =>
  client.query(
    `UPDATE agent_due_diligence SET coi_reviewed_at = now(), coi_reviewed_by = $2, coi_review_note = $3,
       coi_file_id = COALESCE($4, coi_file_id) WHERE agent_id = $1`,
    [agentId, actorId, note || null, fileId || null]);

const setDecision = (client, agentId, { decision, reason }, actorId) =>
  client.query(
    `UPDATE agent_due_diligence SET decision = $2, decision_reason = $3, decided_by = $4, decided_at = now() WHERE agent_id = $1`,
    [agentId, decision, reason, actorId]);

// ---------- referees (the people named on the form) ----------
const findReferee = async (agentId, refereeId, client) =>
  (await q(client).query(
    `SELECT id, name, position, organisation, email, phone FROM agent_referees WHERE id = $1 AND agent_id = $2 AND deleted_at IS NULL`,
    [refereeId, agentId])).rows[0];
const insertReferee = async (client, agentId, r, actorId) =>
  (await client.query(
    `INSERT INTO agent_referees (agent_id, name, position, organisation, email, phone, created_by, updated_by, created_at)
     VALUES ($1,$2,$3,$4,lower($5),$6,$7,$7,clock_timestamp()) RETURNING id`,
    [agentId, r.name, r.position || null, r.organisation, r.email, r.phone || null, actorId])).rows[0].id;
async function updateReferee(client, id, patch, actorId) {
  const cols = Object.keys(patch).filter((k) => ["name", "position", "organisation", "email", "phone"].includes(k));
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  await client.query(
    `UPDATE agent_referees SET ${sets.join(", ")}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
    [id, ...cols.map((c) => (c === "email" ? String(patch[c]).toLowerCase() : patch[c])), actorId]);
}
const softDeleteReferee = (client, id, reason, actorId) =>
  client.query(`UPDATE agent_referees SET deleted_at = now(), deleted_by = $3, delete_reason = $2 WHERE id = $1`, [id, reason, actorId]);

// ---------- referee checks ----------
const CHECK_COLS = `c.id, c.agent_id, c.referee_id, c.method, c.sent_at, c.sent_by, c.reminder_count, c.last_reminder_at,
  c.call_date, c.spoke_to, c.response_at, c.answers, c.outcome, c.outcome_by, c.summary, c.created_at,
  c.token_expires_at, ${fileInfo("c.file_id")} AS file,
  trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS sent_by_name`;

const checksFor = async (agentId, client) =>
  (await q(client).query(
    `SELECT ${CHECK_COLS} FROM referee_checks c LEFT JOIN users s ON s.id = c.sent_by
     WHERE c.agent_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at, c.id`, [agentId])).rows;

const findCheck = async (agentId, checkId, client) =>
  (await q(client).query(
    `SELECT ${CHECK_COLS} FROM referee_checks c LEFT JOIN users s ON s.id = c.sent_by
     WHERE c.id = $1 AND c.agent_id = $2 AND c.deleted_at IS NULL`, [checkId, agentId])).rows[0];

const insertCheck = async (client, c) =>
  (await client.query(
    `INSERT INTO referee_checks (agent_id, referee_id, method, token_hash, token_expires_at, sent_at, sent_by,
       call_date, spoke_to, response_at, answers, outcome, outcome_by, summary, file_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$7) RETURNING id`,
    [c.agentId, c.refereeId, c.method, c.tokenHash || null, c.tokenExpires || null, c.sentAt || null, c.actorId || null,
     c.callDate || null, c.spokeTo || null, c.responseAt || null, c.answers ? JSON.stringify(c.answers) : null,
     c.outcome || "pending", c.outcomeBy || null, c.summary || null, c.fileId || null])).rows[0].id;

const pendingEmailCheck = async (refereeId, client) =>
  (await q(client).query(
    `SELECT id FROM referee_checks WHERE referee_id = $1 AND method = 'email_form' AND outcome = 'pending'
       AND response_at IS NULL AND deleted_at IS NULL`, [refereeId])).rows[0];

const setReminder = (checkId, tokenHash, expires) =>
  query(
    `UPDATE referee_checks SET reminder_count = reminder_count + 1, last_reminder_at = now(),
       token_hash = $2, token_expires_at = $3, updated_at = now() WHERE id = $1`, [checkId, tokenHash, expires]);

const setOutcome = (client, checkId, { outcome, summary }, actorId) =>
  client.query(
    `UPDATE referee_checks SET outcome = $2, summary = $3, outcome_by = $4, updated_at = now() WHERE id = $1`,
    [checkId, outcome, summary, actorId]);

// the referee opens the emailed link
const findByToken = async (hash, client) =>
  (await q(client).query(
    `SELECT c.id, c.agent_id, c.referee_id, c.response_at, c.token_expires_at, r.name AS referee_name, r.organisation,
            a.legal_name AS agent_name, a.status AS agent_status
     FROM referee_checks c JOIN agent_referees r ON r.id = c.referee_id JOIN agents a ON a.id = c.agent_id
     WHERE c.token_hash = $1 AND c.method = 'email_form' AND c.deleted_at IS NULL AND a.deleted_at IS NULL`, [hash])).rows[0];

const saveResponse = (client, checkId, answersJson, outcome) =>
  client.query(
    `UPDATE referee_checks SET answers = $2, response_at = now(), outcome = $3, token_hash = NULL, updated_at = now() WHERE id = $1`,
    [checkId, JSON.stringify(answersJson), outcome]);

// reminders: email checks waiting for an answer
const awaitingReminder = async () =>
  (await query(
    `SELECT c.id, c.agent_id, c.referee_id, c.sent_at, c.reminder_count, COALESCE(c.last_reminder_at, c.sent_at) AS last_at,
            r.name AS referee_name, r.email AS referee_email, a.legal_name AS agent_name
     FROM referee_checks c JOIN agent_referees r ON r.id = c.referee_id JOIN agents a ON a.id = c.agent_id
     WHERE c.method = 'email_form' AND c.outcome = 'pending' AND c.response_at IS NULL AND c.deleted_at IS NULL
       AND a.deleted_at IS NULL AND a.status IN ('applied','due_diligence')`)).rows;

// ---------- decision timer alerts ----------
const openDecisions = async () =>
  (await query(
    `SELECT a.id, a.legal_name, a.application_received_at, a.decision_due_date, d.warned_at, d.alerted_at
     FROM agents a JOIN agent_due_diligence d ON d.agent_id = a.id
     WHERE a.status = 'due_diligence' AND a.deleted_at IS NULL AND a.application_received_at IS NOT NULL`)).rows;
const markWarned = (id) => query(`UPDATE agent_due_diligence SET warned_at = now() WHERE agent_id = $1`, [id]);
const markAlerted = (id) => query(`UPDATE agent_due_diligence SET alerted_at = now() WHERE agent_id = $1`, [id]);

module.exports = {
  insertFile, findFile, find, open, addPreparer, setCheck, setCoiReview, setDecision,
  findReferee, insertReferee, updateReferee, softDeleteReferee,
  checksFor, findCheck, insertCheck, pendingEmailCheck, setReminder, setOutcome, findByToken, saveResponse, awaitingReminder,
  openDecisions, markWarned, markAlerted,
};

// staff recording the declarations on the applicant's behalf (or correcting them)
module.exports.setDeclarations = (client, agentId, d, actorId) =>
  client.query(
    `UPDATE agents SET coi_declared = $2, coi_details = $3,
       code_of_ethics_ack_at = CASE WHEN $4::boolean THEN COALESCE(code_of_ethics_ack_at, now()) ELSE code_of_ethics_ack_at END,
       updated_at = now(), updated_by = $5 WHERE id = $1`,
    [agentId, d.coi_declared, d.coi_declared ? d.coi_details : null, !!d.ack, actorId]);
// a portal login follows the agent's decision
module.exports.decideUsers = async (client, agentId, approve, actorId, reason) => {
  const ids = (await client.query(
    `SELECT portal_user_id FROM agent_persons WHERE agent_id = $1 AND portal_user_id IS NOT NULL AND deleted_at IS NULL`, [agentId]))
    .rows.map((r) => r.portal_user_id);
  if (!ids.length) return;
  await client.query(
    `UPDATE users SET status = $2, updated_at = now() WHERE id = ANY($1) AND status = 'pending_approval'`,
    [ids, approve ? "active" : "rejected"]);
  await client.query(
    `UPDATE agent_profiles SET decided_by = $2, decided_at = now(), rejection_reason = $3
     WHERE user_id = ANY($1) AND decided_at IS NULL`, [ids, actorId, approve ? null : reason]);
};
