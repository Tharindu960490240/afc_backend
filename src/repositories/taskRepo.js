const { query } = require("../config/db");

const q = (client) => client || { query };

const COLS = `t.id, t.category, t.type, t.title, t.description, t.agent_id, t.agreement_id, t.trigger_event, t.trigger_date,
  to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.due_basis, to_char(t.legal_deadline, 'YYYY-MM-DD') AS legal_deadline,
  t.owner_id, t.owner_role, t.status, t.completed_at, t.completed_by, t.completion_note, t.evidence_file_id,
  t.warned_at, t.escalated_at, t.reminded_at, t.created_at,
  a.legal_name AS agent_name,
  trim(coalesce(o.first_name,'') || ' ' || coalesce(o.last_name,'')) AS owner_name,
  trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS completed_by_name,
  (SELECT json_build_object('id', f.id, 'name', f.original_name, 'size', f.size_bytes) FROM coms_files f WHERE f.id = t.evidence_file_id) AS evidence`;
const FROM = `FROM coms_tasks t LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN users o ON o.id = t.owner_id LEFT JOIN users c ON c.id = t.completed_by`;

function filters(f, actor) {
  const where = ["t.deleted_at IS NULL"];
  const v = [];
  const add = (sql, val) => { v.push(val); where.push(sql.replace(/\?/g, `$${v.length}`)); };
  if (f.status && f.status !== "all") add("t.status = ?", f.status);
  if (f.type?.length) add("t.type = ANY(?)", f.type);
  if (f.category) add("t.category = ?", f.category);
  if (f.agent_id) add("t.agent_id = ?", f.agent_id);
  if (f.owner === "me") add("t.owner_id = ?", actor.id);
  else if (f.owner === "unassigned") where.push("t.owner_id IS NULL");
  else if (f.owner) add("t.owner_id = ?", f.owner);
  if (f.overdue) { v.push(f.today); where.push(`t.status = 'open' AND t.due_date < $${v.length}::date`); }
  if (f.search) {
    const like = `%${f.search.replace(/[\\%_]/g, "\\$&")}%`;
    add("(t.title ILIKE ? OR a.legal_name ILIKE ?)", like);
  }
  return { clause: `WHERE ${where.join(" AND ")}`, v };
}

async function list(f, actor, { limit, offset }) {
  const { clause, v } = filters(f, actor);
  const total = Number((await query(`SELECT COUNT(*) ${FROM} ${clause}`, v)).rows[0].count);
  const rows = (await query(
    `SELECT ${COLS} ${FROM} ${clause} ORDER BY (t.status = 'open') DESC, t.due_date ASC, t.created_at
     LIMIT $${v.length + 1} OFFSET $${v.length + 2}`, [...v, limit, offset])).rows;
  return { rows, total };
}
async function listAll(f, actor, max) {
  const { clause, v } = filters(f, actor);
  return (await query(`SELECT ${COLS} ${FROM} ${clause} ORDER BY t.due_date, t.created_at LIMIT ${Number(max)}`, v)).rows;
}
const forAgent = async (agentId) =>
  (await query(`SELECT ${COLS} ${FROM} WHERE t.agent_id = $1 AND t.deleted_at IS NULL ORDER BY (t.status='open') DESC, t.due_date, t.created_at`, [agentId])).rows;
const findById = async (id, client, { lock = false } = {}) =>
  (await q(client).query(`SELECT ${COLS} ${FROM} WHERE t.id = $1 AND t.deleted_at IS NULL ${lock ? "FOR UPDATE OF t" : ""}`, [id])).rows[0];

const insert = async (client, t) =>
  (await client.query(
    `INSERT INTO coms_tasks (category, type, title, description, agent_id, agreement_id, trigger_event, trigger_date,
       due_date, due_basis, legal_deadline, owner_id, owner_role, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) ON CONFLICT DO NOTHING RETURNING id`,
    [t.category, t.type, t.title, t.description || null, t.agentId || null, t.agreementId || null, t.triggerEvent || null,
     t.triggerDate, t.dueDate, t.dueBasis, t.legalDeadline || null, t.ownerId || null, t.ownerRole || null, t.actorId || null])).rows[0]?.id;

const complete = (client, id, { note, fileId }, actorId) =>
  client.query(
    `UPDATE coms_tasks SET status = 'done', completed_at = now(), completed_by = $2, completion_note = $3,
       evidence_file_id = $4, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, actorId, note || null, fileId || null]);
const cancel = (client, id, reason, actorId) =>
  client.query(`UPDATE coms_tasks SET status = 'cancelled', completion_note = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, reason, actorId]);
const assign = (client, id, ownerId, actorId) =>
  client.query(`UPDATE coms_tasks SET owner_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, ownerId, actorId]);
const setDue = (client, id, due, actorId) =>
  client.query(`UPDATE coms_tasks SET due_date = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, due, actorId]);

// ---------- people ----------
// first active user with a role, an account manager if they hold it, otherwise any administrator
async function ownerFor(role, preferId) {
  if (preferId) {
    const m = (await query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [preferId])).rows[0];
    if (m) return m.id;
  }
  const byRole = role && (await query(`SELECT id FROM users WHERE role = $1 AND status = 'active' ORDER BY id LIMIT 1`, [role])).rows[0];
  if (byRole) return byRole.id;
  return (await query(`SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`)).rows[0]?.id || null;
}
const usersWithRoles = async (roles) =>
  (await query(`SELECT id, first_name, email, role FROM users WHERE status = 'active' AND role = ANY($1)`, [roles])).rows;
const userById = async (id) => (await query(`SELECT id, first_name, last_name, email, role, status FROM users WHERE id = $1`, [id])).rows[0];

// ---------- job queries ----------
const openRegulatory = async () =>
  (await query(`SELECT ${COLS}, to_char(t.trigger_date, 'YYYY-MM-DD') AS trigger_day ${FROM}
                WHERE t.status = 'open' AND t.deleted_at IS NULL`)).rows;
const openOfType = async (type) =>
  (await query(`SELECT ${COLS} ${FROM} WHERE t.status = 'open' AND t.deleted_at IS NULL AND t.type = $1`, [type])).rows;
const markReminded = (id) => query(`UPDATE coms_tasks SET reminded_at = now() WHERE id = $1`, [id]);
const markWarned = (id) => query(`UPDATE coms_tasks SET warned_at = now() WHERE id = $1`, [id]);
const markEscalated = (id) => query(`UPDATE coms_tasks SET escalated_at = now() WHERE id = $1`, [id]);

module.exports = { list, listAll, forAgent, findById, insert, complete, cancel, assign, setDue, ownerFor, usersWithRoles, userById, openRegulatory, openOfType, markReminded, markWarned, markEscalated };
