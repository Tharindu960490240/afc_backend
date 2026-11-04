const { query } = require("../config/db");

// Only one live reset link per user: issuing a new one voids the old ones.
const issue = async (client, userId, tokenHash, expiresAt) => {
  await client.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await client.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [userId, tokenHash, expiresAt]);
};

const findValidByHash = async (tokenHash, client) =>
  (
    await (client || { query }).query(
      `SELECT pr.id, pr.user_id, u.email, u.status
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()
       ${client ? "FOR UPDATE OF pr" : ""}`,
      [tokenHash],
    )
  ).rows[0];

const markUsed = (client, id) => client.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [id]);

const purgeOld = () =>
  query(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`);

module.exports = { issue, findValidByHash, markUsed, purgeOld };
