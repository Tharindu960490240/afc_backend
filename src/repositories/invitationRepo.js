const { query } = require("../config/db");

const COLUMNS = `id, email, role, first_name, invited_by, agent_id, expires_at, accepted_at, revoked_at, created_at`;

const create = async (client, i) =>
  (
    await client.query(
      `INSERT INTO invitations (email, role, first_name, token_hash, invited_by, expires_at, agent_id)
       VALUES (lower($1),$2,$3,$4,$5,$6,$7) RETURNING ${COLUMNS}`,
      [i.email, i.role, i.firstName || null, i.tokenHash, i.invitedBy, i.expiresAt, i.agentId || null],
    )
  ).rows[0];

const findOpenByEmail = async (client, email) =>
  (
    await client.query(
      `SELECT * FROM invitations WHERE lower(email)=lower($1) AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
      [email],
    )
  ).rows[0];

const findById = async (id) => (await query(`SELECT * FROM invitations WHERE id = $1`, [id])).rows[0];

// A usable invitation: not accepted, not revoked, not expired.
const findValidByHash = async (tokenHash, client) =>
  (
    await (client || { query }).query(
      `SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       ${client ? "FOR UPDATE" : ""}`,
      [tokenHash],
    )
  ).rows[0];

const revoke = (client, id) =>
  (client || { query }).query(`UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [id]);

const markAccepted = (client, id, userId) =>
  client.query(`UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`, [id, userId]);

const list = async ({ status, invitedBy, limit, offset }) => {
  const where = [];
  const values = [];
  if (invitedBy) { values.push(invitedBy); where.push(`invited_by = $${values.length}`); }
  if (status === "pending") where.push(`accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`);
  if (status === "accepted") where.push(`accepted_at IS NOT NULL`);
  if (status === "revoked") where.push(`revoked_at IS NOT NULL AND accepted_at IS NULL`);
  if (status === "expired") where.push(`accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((await query(`SELECT COUNT(*) FROM invitations ${clause}`, values)).rows[0].count);
  const rows = (
    await query(
      `SELECT ${COLUMNS},
         CASE WHEN accepted_at IS NOT NULL THEN 'accepted'
              WHEN revoked_at IS NOT NULL THEN 'revoked'
              WHEN expires_at <= now() THEN 'expired' ELSE 'pending' END AS status
       FROM invitations ${clause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    )
  ).rows;
  return { rows, total };
};

module.exports = { create, findOpenByEmail, findById, findValidByHash, revoke, markAccepted, list };
