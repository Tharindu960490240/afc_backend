const { query } = require("../config/db");

// Agents who registered themselves from the website, with what the college needs to decide.
const list = async ({ status, limit, offset }) => {
  const values = [status];
  const total = Number(
    (await query(`SELECT COUNT(*) FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
                  WHERE u.role='agent' AND ap.registered_via='website' AND u.status = $1`, values)).rows[0].count,
  );
  const rows = (
    await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.status, u.created_at,
              ap.agency_name, ap.business_number, ap.country, ap.email_verified_at,
              ap.decided_at, ap.rejection_reason
       FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
       WHERE u.role='agent' AND ap.registered_via='website' AND u.status = $1
       ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    )
  ).rows;
  return { rows, total };
};

const counts = async () => {
  const r = (
    await query(
      `SELECT u.status, COUNT(*)::int AS n FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
       WHERE u.role='agent' AND ap.registered_via='website' AND u.status IN ('pending_approval','unverified','rejected')
       GROUP BY u.status`,
    )
  ).rows;
  return Object.fromEntries(r.map((x) => [x.status, x.n]));
};

module.exports = { list, counts };
