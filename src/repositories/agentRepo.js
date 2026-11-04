const { query } = require("../config/db");

// Everything about one agent for the admin's detail page.
const findDetail = async (id) =>
  (
    await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.status, u.created_at, u.consent_at,
              u.last_login_at, u.locked_until,
              ap.agency_name, ap.business_number, ap.country, ap.registered_via,
              ap.email_verified_at, ap.decided_at, ap.rejection_reason,
              d.first_name AS decided_by_first_name, d.last_name AS decided_by_last_name
       FROM users u
       JOIN agent_profiles ap ON ap.user_id = u.id
       LEFT JOIN users d ON d.id = ap.decided_by
       WHERE u.id = $1 AND u.role = 'agent'`,
      [id],
    )
  ).rows[0];

// The invitation this agent came in through (none for website registrations).
const findInvitation = async (id) =>
  (
    await query(
      `SELECT i.created_at, i.accepted_at, b.first_name AS invited_by_first_name, b.last_name AS invited_by_last_name
       FROM invitations i LEFT JOIN users b ON b.id = i.invited_by
       WHERE i.accepted_user_id = $1`,
      [id],
    )
  ).rows[0];

// Sign-ins and everything the agent did, plus what staff did to their account.
const recentActivity = async (id, limit = 20) =>
  (
    await query(
      `SELECT a.id, a.action, a.created_at, a.ip, a.actor_id,
              s.first_name AS actor_first_name, s.last_name AS actor_last_name
       FROM audit_logs a LEFT JOIN users s ON s.id = a.actor_id
       WHERE a.actor_id = $1 OR (a.entity_type = 'user' AND a.entity_id = $1::text)
       ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
      [id, limit],
    )
  ).rows;

const studentCount = async (id) =>
  Number((await query(`SELECT COUNT(*) FROM student_profiles WHERE agent_id = $1`, [id])).rows[0].count);

// The agent's own business details (shown on their profile page).
const findOwn = async (id) =>
  (await query("SELECT agency_name, business_number, country FROM agent_profiles WHERE user_id = $1", [id])).rows[0] || null;

module.exports = { findOwn, findDetail, findInvitation, recentActivity, studentCount };
