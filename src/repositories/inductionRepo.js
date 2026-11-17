// Agent induction records (Phase 3).
const { query } = require("../config/db");
const q = (client) => client || { query };

const COLS = `i.id, i.agent_id, i.status, i.mode, to_char(i.scheduled_for, 'YYYY-MM-DD') AS scheduled_for,
  to_char(i.held_on, 'YYYY-MM-DD') AS held_on, i.conducted_by, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS conducted_by_name,
  i.attendees, i.notes, i.cancel_reason, i.created_at, i.updated_at,
  trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS created_by_name`;
const FROM = `FROM agent_inductions i LEFT JOIN users u ON u.id = i.conducted_by LEFT JOIN users c ON c.id = i.created_by`;

const forAgent = async (agentId, client) =>
  (await q(client).query(`SELECT ${COLS} ${FROM} WHERE i.agent_id = $1 ORDER BY i.created_at DESC`, [agentId])).rows;
const findById = async (id, client, { lock = false } = {}) =>
  (await q(client).query(`SELECT ${COLS} ${FROM} WHERE i.id = $1 ${lock ? "FOR UPDATE OF i" : ""}`, [id])).rows[0];

const insert = async (client, d) =>
  (await client.query(
    `INSERT INTO agent_inductions (agent_id, status, mode, scheduled_for, held_on, conducted_by, attendees, notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [d.agentId, d.status, d.mode, d.scheduledFor || null, d.heldOn || null, d.conductedBy || null, d.attendees || null, d.notes || null, d.actorId || null],
  )).rows[0].id;

const markHeld = (client, id, d) =>
  client.query(
    `UPDATE agent_inductions SET status = 'held', held_on = $2, mode = $3, conducted_by = $4, attendees = $5, notes = $6, updated_by = $7, updated_at = now() WHERE id = $1`,
    [id, d.heldOn, d.mode, d.conductedBy || null, d.attendees || null, d.notes || null, d.actorId || null],
  );
const cancel = (client, id, reason, actorId) =>
  client.query(`UPDATE agent_inductions SET status = 'cancelled', cancel_reason = $2, updated_by = $3, updated_at = now() WHERE id = $1`, [id, reason, actorId]);
const reschedule = (client, id, d) =>
  client.query(
    `UPDATE agent_inductions SET scheduled_for = $2, mode = $3, conducted_by = $4, reminder_sent_at = NULL, followup_sent_at = NULL, updated_by = $5, updated_at = now() WHERE id = $1`,
    [id, d.scheduledFor, d.mode, d.conductedBy || null, d.actorId || null],
  );

// ---------- reminder job ----------
const scheduledOpen = async () =>
  (await query(
    `SELECT ${COLS}, a.legal_name AS agent_name, a.email AS agent_email, cu.email AS conductor_email, cu.first_name AS conductor_first_name,
            i.reminder_sent_at, i.followup_sent_at
     ${FROM} JOIN agents a ON a.id = i.agent_id AND a.deleted_at IS NULL LEFT JOIN users cu ON cu.id = i.conducted_by AND cu.status = 'active'
     WHERE i.status = 'scheduled'`)).rows;
const markReminded = (id) => query(`UPDATE agent_inductions SET reminder_sent_at = now() WHERE id = $1`, [id]);
const markFollowedUp = (id) => query(`UPDATE agent_inductions SET followup_sent_at = now() WHERE id = $1`, [id]);

module.exports = { forAgent, findById, insert, markHeld, cancel, reschedule, scheduledOpen, markReminded, markFollowedUp };
