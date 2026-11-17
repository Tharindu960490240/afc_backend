const { query } = require("../config/db");
const q = (client) => client || { query };

const COLS = `d.id, d.agent_id, d.kind, d.label, d.status, d.review_note, d.reviewed_at, d.created_at, d.uploaded_by_agent,
  d.file_id, f.original_name, f.size_bytes, f.mime_type,
  trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS uploaded_by_name,
  trim(coalesce(r.first_name,'') || ' ' || coalesce(r.last_name,'')) AS reviewed_by_name`;
const FROM = `FROM agent_documents d JOIN coms_files f ON f.id = d.file_id
  LEFT JOIN users u ON u.id = d.uploaded_by LEFT JOIN users r ON r.id = d.reviewed_by`;

const list = async (agentId, client) =>
  (await q(client).query(`SELECT ${COLS} ${FROM} WHERE d.agent_id = $1 AND d.deleted_at IS NULL ORDER BY d.created_at, d.id`, [agentId])).rows;
const find = async (agentId, docId, client) =>
  (await q(client).query(`SELECT ${COLS}, f.storage_key ${FROM} WHERE d.id = $1 AND d.agent_id = $2 AND d.deleted_at IS NULL`, [docId, agentId])).rows[0];

const insert = async (client, d) =>
  (await client.query(
    `INSERT INTO agent_documents (agent_id, kind, label, file_id, uploaded_by, uploaded_by_agent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [d.agentId, d.kind, d.label || null, d.fileId, d.actorId || null, !!d.byAgent])).rows[0].id;
const review = (client, id, { status, note }, actorId) =>
  client.query(`UPDATE agent_documents SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`, [id, status, note || null, actorId]);
const softDelete = (client, id, reason, actorId) =>
  client.query(`UPDATE agent_documents SET deleted_at = now(), deleted_by = $3, delete_reason = $2 WHERE id = $1`, [id, reason, actorId]);
// a kind that must exist once: a new upload of the same kind replaces the old one
const supersede = (client, agentId, kind, actorId) =>
  client.query(
    `UPDATE agent_documents SET deleted_at = now(), deleted_by = $3, delete_reason = 'Replaced by a newer upload'
     WHERE agent_id = $1 AND kind = $2 AND deleted_at IS NULL AND status <> 'accepted'`, [agentId, kind, actorId || null]);

module.exports = { list, find, insert, review, softDelete, supersede };
