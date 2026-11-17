// Agent induction records (Phase 3).
const { query } = require("../config/db");
const q = (client) => client || { query };

const COLS = `i.id, i.agent_id, i.status, i.mode, to_char(i.scheduled_for, 'YYYY-MM-DD') AS scheduled_for,
  to_char(i.held_on, 'YYYY-MM-DD') AS held_on, to_char(i.start_time, 'HH24:MI') AS start_time, i.meeting_url, i.location, i.conducted_by, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS conducted_by_name,
  i.attendees, i.notes, i.cancel_reason, i.created_at, i.updated_at,
  trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS created_by_name`;
const FROM = `FROM agent_inductions i LEFT JOIN users u ON u.id = i.conducted_by LEFT JOIN users c ON c.id = i.created_by`;

const forAgent = async (agentId, client) =>
  (await q(client).query(`SELECT ${COLS} ${FROM} WHERE i.agent_id = $1 ORDER BY i.created_at DESC`, [agentId])).rows;
const findById = async (id, client, { lock = false } = {}) =>
  (await q(client).query(`SELECT ${COLS} ${FROM} WHERE i.id = $1 ${lock ? "FOR UPDATE OF i" : ""}`, [id])).rows[0];

const insert = async (client, d) =>
  (await client.query(
    `INSERT INTO agent_inductions (agent_id, status, mode, scheduled_for, held_on, conducted_by, attendees, notes, start_time, meeting_url, location, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
    [d.agentId, d.status, d.mode, d.scheduledFor || null, d.heldOn || null, d.conductedBy || null, d.attendees || null, d.notes || null,
      d.startTime || null, d.meetingUrl || null, d.location || null, d.actorId || null],
  )).rows[0].id;

const markHeld = (client, id, d) =>
  client.query(
    `UPDATE agent_inductions SET status = 'held', held_on = $2, mode = $3, conducted_by = $4, attendees = $5, notes = $6, updated_by = $7, updated_at = now() WHERE id = $1`,
    [id, d.heldOn, d.mode, d.conductedBy || null, d.attendees || null, d.notes || null, d.actorId || null],
  );
const cancel = (client, id, reason, actorId, status = "cancelled") =>
  client.query(`UPDATE agent_inductions SET status = $4, cancel_reason = $2, updated_by = $3, updated_at = now() WHERE id = $1`, [id, reason, actorId, status]);
const editHeld = (client, id, d) =>
  client.query(
    `UPDATE agent_inductions SET held_on = $2, mode = $3, conducted_by = $4, attendees = $5, notes = $6, updated_by = $7, updated_at = now() WHERE id = $1`,
    [id, d.heldOn, d.mode, d.conductedBy || null, d.attendees || null, d.notes || null, d.actorId || null],
  );
// the date that counts for BR-02 is the latest held induction that is still standing
const latestHeld = async (client, agentId) =>
  (await client.query(`SELECT to_char(max(held_on), 'YYYY-MM-DD') AS d FROM agent_inductions WHERE agent_id = $1 AND status = 'held'`, [agentId])).rows[0].d;
const reschedule = (client, id, d) =>
  client.query(
    `UPDATE agent_inductions SET scheduled_for = $2, mode = $3, conducted_by = $4, start_time = $6, meeting_url = $7, location = $8,
       reminder_sent_at = NULL, followup_sent_at = NULL, updated_by = $5, updated_at = now() WHERE id = $1`,
    [id, d.scheduledFor, d.mode, d.conductedBy || null, d.actorId || null, d.startTime || null, d.meetingUrl || null, d.location || null],
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

module.exports = { forAgent, findById, insert, markHeld, editHeld, latestHeld, cancel, reschedule, scheduledOpen, markReminded, markFollowedUp };
