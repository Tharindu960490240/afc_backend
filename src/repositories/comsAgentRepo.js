const { query } = require("../config/db");

const q = (client) => client || { query };

// columns staff may change through the edit screen (never status, never ids)
const EDITABLE = [
  "legal_name", "trading_names", "abn_acn", "country", "is_body_corporate", "principal_address",
  "registered_office_address", "postal_address", "phone", "email", "website", "marn",
  "account_manager_id", "tier", "risk_rating", "risk_override_reason", "contact_cadence_days",
];

const LIST_SELECT = `
  a.id, a.legal_name, a.trading_names, a.abn_acn, a.country, a.is_body_corporate, a.principal_address,
  a.registered_office_address, a.postal_address, a.phone, a.email, a.website, a.marn,
  a.status, a.status_changed_at, a.source, a.tier, a.risk_rating, a.risk_override_reason, a.contact_cadence_days,
  a.account_manager_id, a.last_contact_at, a.application_received_at, a.ack_sent_at, a.ack_due_date, a.decision_due_date,
  a.prisms_recorded_at, a.induction_recorded_at, a.rejection_reason, a.xero_contact_id, a.axcelerate_agent_id,
  a.created_at, a.updated_at, a.deleted_at, a.delete_reason,
  m.first_name AS manager_first_name, m.last_name AS manager_last_name,
  (SELECT COUNT(*)::int FROM agent_persons p
     WHERE p.agent_id = a.id AND p.deleted_at IS NULL AND p.active AND p.role = 'director') AS director_count,
  (SELECT MAX(ag.expires_at) FROM agreements ag JOIN agent_persons p ON p.portal_user_id = ag.agent_id
     WHERE p.agent_id = a.id AND p.deleted_at IS NULL AND ag.status = 'active') AS agreement_end`;
const FROM = `FROM agents a LEFT JOIN users m ON m.id = a.account_manager_id`;

const SORTS = {
  created_at: "a.created_at",
  legal_name: "lower(a.legal_name)",
  status: "a.status",
  country: "a.country",
  decision_due: "a.decision_due_date",
  agreement_end: "agreement_end",
};

function filters(f) {
  const where = [f.deleted ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL"];
  const v = [];
  const add = (sql, val) => { v.push(val); where.push(sql.replace(/\?/g, `$${v.length}`)); };
  if (f.status?.length) add("a.status = ANY(?)", f.status);
  if (f.tier) add("a.tier = ?", f.tier);
  if (f.risk) add("a.risk_rating = ?", f.risk);
  if (f.country) add("lower(a.country) = lower(?)", f.country);
  if (f.manager === "unassigned") where.push("a.account_manager_id IS NULL");
  else if (f.manager) add("a.account_manager_id = ?", f.manager);
  if (f.search) {
    const like = `%${f.search.replace(/[\\%_]/g, "\\$&")}%`;
    add(
      `(a.legal_name ILIKE ? OR a.email ILIKE ? OR coalesce(a.abn_acn,'') ILIKE ? OR array_to_string(a.trading_names,' ') ILIKE ?)`,
      like,
    );
  }
  return { clause: `WHERE ${where.join(" AND ")}`, v };
}

async function list(f, { limit, offset, sort = "created_at", dir = "desc" }) {
  const { clause, v } = filters(f);
  const total = Number((await query(`SELECT COUNT(*) ${FROM} ${clause}`, v)).rows[0].count);
  const col = SORTS[sort] || SORTS.created_at;
  const rows = (
    await query(
      `SELECT ${LIST_SELECT} ${FROM} ${clause}
       ORDER BY ${col} ${dir === "asc" ? "ASC" : "DESC"} NULLS LAST, a.created_at DESC
       LIMIT $${v.length + 1} OFFSET $${v.length + 2}`,
      [...v, limit, offset],
    )
  ).rows;
  return { rows, total };
}

async function listAll(f, max) {
  const { clause, v } = filters(f);
  return (await query(`SELECT ${LIST_SELECT} ${FROM} ${clause} ORDER BY lower(a.legal_name) LIMIT ${Number(max)}`, v)).rows;
}

const findById = async (id, client, { lock = false } = {}) =>
  (await q(client).query(`SELECT ${LIST_SELECT} ${FROM} WHERE a.id = $1 ${lock ? "FOR UPDATE OF a" : ""}`, [id])).rows[0];

const findByEmail = async (email, client) =>
  (await q(client).query(`SELECT id FROM agents WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [email])).rows[0];

const insert = async (client, a) =>
  (
    await client.query(
      `INSERT INTO agents (legal_name, country, email, phone, is_body_corporate, abn_acn, status, source, created_by, updated_by)
       VALUES ($1,$2,lower($3),$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [a.legal_name, a.country, a.email, a.phone || null, !!a.is_body_corporate, a.abn_acn || null, a.status || "prospect", a.source, a.actor || null],
    )
  ).rows[0].id;

// patch = { column: value } limited to EDITABLE
async function update(client, id, patch, actorId) {
  const cols = Object.keys(patch).filter((k) => EDITABLE.includes(k));
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  await client.query(
    `UPDATE agents SET ${sets.join(", ")}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
    [id, ...cols.map((c) => (c === "email" ? String(patch[c]).toLowerCase() : patch[c])), actorId],
  );
}

const setStatus = (client, id, status, actorId, extra = {}) =>
  client.query(
    `UPDATE agents SET status = $2::varchar, status_changed_at = now(), updated_at = now(), updated_by = $3,
       rejection_reason = CASE WHEN $2::varchar = 'rejected' THEN $4 ELSE rejection_reason END
     WHERE id = $1`,
    [id, status, actorId, extra.reason || null],
  );

const addHistory = (client, { agentId, from, to, reason, actorId }) =>
  client.query(
    `INSERT INTO agent_status_history (agent_id, from_status, to_status, reason, changed_by) VALUES ($1,$2,$3,$4,$5)`,
    [agentId, from || null, to, reason || null, actorId || null],
  );

const history = async (agentId) =>
  (
    await query(
      `SELECT h.id, h.from_status, h.to_status, h.reason, h.changed_at, h.changed_by,
              u.first_name AS by_first_name, u.last_name AS by_last_name
       FROM agent_status_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.agent_id = $1 ORDER BY h.changed_at DESC, h.id DESC`,
      [agentId],
    )
  ).rows;

const softDelete = (client, id, reason, actorId) =>
  client.query(`UPDATE agents SET deleted_at = now(), deleted_by = $3, delete_reason = $2, updated_at = now() WHERE id = $1`, [id, reason, actorId]);
const restore = (client, id, actorId) =>
  client.query(`UPDATE agents SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, actorId]);

const setSla = (client, id, { receivedAt, ackDue, decisionDue }) =>
  client.query(
    `UPDATE agents SET application_received_at = $2, ack_due_date = $3, decision_due_date = $4 WHERE id = $1`,
    [id, receivedAt, ackDue, decisionDue],
  );
const markAcknowledged = (id) => query(`UPDATE agents SET ack_sent_at = now() WHERE id = $1 AND ack_sent_at IS NULL`, [id]);
const setMilestone = (client, id, column, when, actorId) =>
  client.query(`UPDATE agents SET ${column === "prisms" ? "prisms_recorded_at" : "induction_recorded_at"} = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, when, actorId]);

// ---------- people ----------
const PERSON_COLS = `p.id, p.agent_id, p.name, p.email, p.role, p.marn, p.is_director, p.involved_in_enrolments,
  p.is_primary_contact, p.location, p.portal_user_id, p.training_completed_at, p.active, p.created_at`;

const persons = async (agentId, client) =>
  (
    await q(client).query(
      `SELECT ${PERSON_COLS} FROM agent_persons p WHERE p.agent_id = $1 AND p.deleted_at IS NULL
       ORDER BY p.is_primary_contact DESC, p.created_at`,
      [agentId],
    )
  ).rows;
const findPerson = async (agentId, personId, client) =>
  (await q(client).query(`SELECT ${PERSON_COLS} FROM agent_persons p WHERE p.id = $1 AND p.agent_id = $2 AND p.deleted_at IS NULL`, [personId, agentId])).rows[0];

const insertPerson = async (client, agentId, p, actorId) =>
  (
    await client.query(
      `INSERT INTO agent_persons (agent_id, name, email, role, marn, is_director, involved_in_enrolments,
                                  is_primary_contact, location, portal_user_id, active, created_by, updated_by)
       VALUES ($1,$2,lower($3),$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
      [
        agentId, p.name, p.email, p.role || "staff", p.marn || null, (p.role || "staff") === "director",
        !!p.involved_in_enrolments, !!p.is_primary_contact, p.location || null, p.portal_user_id || null,
        p.active !== false, actorId || null,
      ],
    )
  ).rows[0].id;

const PERSON_EDITABLE = ["name", "email", "role", "marn", "involved_in_enrolments", "location", "training_completed_at", "active", "is_primary_contact"];
async function updatePerson(client, id, patch, actorId) {
  const cols = Object.keys(patch).filter((k) => PERSON_EDITABLE.includes(k));
  const values = cols.map((c) => (c === "email" ? String(patch[c]).toLowerCase() : patch[c]));
  if (patch.role) { cols.push("is_director"); values.push(patch.role === "director"); }
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  await client.query(`UPDATE agent_persons SET ${sets.join(", ")}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`, [id, ...values, actorId]);
}
const linkPortalUser = (client, personId, userId) =>
  client.query(`UPDATE agent_persons SET portal_user_id = $2, updated_at = now() WHERE id = $1`, [personId, userId]);
const clearPrimary = (client, agentId) =>
  client.query(`UPDATE agent_persons SET is_primary_contact = false WHERE agent_id = $1 AND is_primary_contact`, [agentId]);
const softDeletePerson = (client, id, reason, actorId) =>
  client.query(`UPDATE agent_persons SET deleted_at = now(), deleted_by = $3, delete_reason = $2, active = false WHERE id = $1`, [id, reason, actorId]);

// ---------- links to the existing portal ----------
const findByPortalUser = async (userId, client, { lock = false } = {}) =>
  (
    await q(client).query(
      `SELECT a.id FROM agents a JOIN agent_persons p ON p.agent_id = a.id
       WHERE p.portal_user_id = $1 AND p.deleted_at IS NULL AND a.deleted_at IS NULL ${lock ? "FOR UPDATE OF a" : ""}`,
      [userId],
    )
  ).rows[0];

const portalUserIds = async (agentId, client) =>
  (await q(client).query(`SELECT portal_user_id FROM agent_persons WHERE agent_id=$1 AND portal_user_id IS NOT NULL AND deleted_at IS NULL`, [agentId])).rows.map((r) => r.portal_user_id);

// agreements of every portal login that belongs to this agent
const agreements = async (agentId) =>
  (
    await query(
      `SELECT ag.id, ag.title, ag.status, ag.sent_at, ag.effective_date, ag.expires_at,
              CASE WHEN ag.status = 'active' AND ag.expires_at < current_date THEN 'expired' ELSE ag.status END AS display_status
       FROM agreements ag JOIN agent_persons p ON p.portal_user_id = ag.agent_id
       WHERE p.agent_id = $1 AND p.deleted_at IS NULL ORDER BY ag.sent_at DESC`,
      [agentId],
    )
  ).rows;

// BR-01: a fully signed (countersigned) agreement that is still in force and has both dates
const hasSignedAgreement = async (agentId, client) =>
  (
    await q(client).query(
      `SELECT 1 FROM agreements ag JOIN agent_persons p ON p.portal_user_id = ag.agent_id
       WHERE p.agent_id = $1 AND p.deleted_at IS NULL AND ag.status = 'active'
         AND ag.effective_date IS NOT NULL AND ag.expires_at IS NOT NULL AND ag.expires_at >= current_date LIMIT 1`,
      [agentId],
    )
  ).rowCount > 0;

const staffUsers = async () =>
  (
    await query(
      `SELECT id, first_name, last_name, role FROM users
       WHERE status = 'active' AND role = ANY($1) ORDER BY first_name, last_name`,
      [["admin", "ceo", "director", "marketing_officer", "admissions", "coe_admin", "accounts", "compliance"]],
    )
  ).rows;

module.exports = {
  EDITABLE, list, listAll, findById, findByEmail, insert, update, setStatus, addHistory, history,
  softDelete, restore, setSla, markAcknowledged, setMilestone,
  persons, findPerson, insertPerson, updatePerson, linkPortalUser, clearPrimary, softDeletePerson,
  findByPortalUser, portalUserIds, agreements, hasSignedAgreement, staffUsers,
};
