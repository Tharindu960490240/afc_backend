const { query } = require("../config/db");

const active = async (client) =>
  (await (client || { query }).query(
    `SELECT t.id, t.name, t.body, t.version, t.created_at, u.first_name AS updated_by_first_name, u.last_name AS updated_by_last_name
     FROM agreement_templates t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.is_active`,
  )).rows[0];

// Saves an edit as a new version and makes it the active one.
const publish = async (client, { name, body, userId }) => {
  const version = Number((await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM agreement_templates`)).rows[0].v);
  await client.query(`UPDATE agreement_templates SET is_active = false WHERE is_active`);
  await client.query(
    `INSERT INTO agreement_templates (name, body, version, is_active, created_by) VALUES ($1,$2,$3,true,$4)`,
    [name, body, version, userId],
  );
};

module.exports = { active, publish };
