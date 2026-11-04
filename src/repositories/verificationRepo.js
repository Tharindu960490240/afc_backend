const { query } = require("../config/db");

// Only one live confirmation link per user: issuing a new one voids the old ones.
const issue = async (client, userId, tokenHash, expiresAt) => {
  await client.query(`UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await client.query(`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [userId, tokenHash, expiresAt]);
};

const findValidByHash = async (client, tokenHash) =>
  (
    await client.query(
      `SELECT ev.id, ev.user_id, u.status, u.email, u.first_name, u.last_name
       FROM email_verifications ev JOIN users u ON u.id = ev.user_id
       WHERE ev.token_hash = $1 AND ev.used_at IS NULL AND ev.expires_at > now()
       FOR UPDATE OF ev`,
      [tokenHash],
    )
  ).rows[0];

const markUsed = (client, id) => client.query(`UPDATE email_verifications SET used_at = now() WHERE id = $1`, [id]);

module.exports = { issue, findValidByHash, markUsed, query };
