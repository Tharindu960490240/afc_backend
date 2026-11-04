const { query } = require("../config/db");

const PUBLIC_COLUMNS = `id, email, first_name, last_name, phone, role, status, profile_image, last_login_at, created_at`;

const findByEmail = async (email) =>
  (await query("SELECT * FROM users WHERE lower(email) = lower($1)", [email])).rows[0];

const findById = async (id) => (await query("SELECT * FROM users WHERE id = $1", [id])).rows[0];

const emailExists = async (email, client) =>
  (await (client || { query }).query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email])).rowCount > 0;

const create = async (client, u) =>
  (
    await client.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone, role, consent_at, status)
       VALUES (lower($1),$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${PUBLIC_COLUMNS}`,
      [u.email, u.passwordHash, u.firstName, u.lastName, u.phone || null, u.role, u.consentAt || null, u.status || "active"],
    )
  ).rows[0];

const registerFailedLogin = async (id, maxFailed, lockMinutes) =>
  (
    await query(
      `UPDATE users SET
         failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
       WHERE id = $1 RETURNING locked_until`,
      [id, maxFailed, String(lockMinutes)],
    )
  ).rows[0];

const registerSuccessfulLogin = (id) =>
  query("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [id]);

// Changes the password and invalidates every existing token.
const setPassword = (client, id, passwordHash) =>
  client.query(
    `UPDATE users SET password_hash = $2, token_version = token_version + 1,
       failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [id, passwordHash],
  );

const setStatus = async (id, status) =>
  (
    await query(
      `UPDATE users SET status = $2, token_version = token_version + 1, updated_at = now()
       WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [id, status],
    )
  ).rows[0];

const updateProfile = async (id, { firstName, lastName, phone }) =>
  (
    await query(
      `UPDATE users SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
         phone = COALESCE($4, phone), updated_at = now()
       WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [id, firstName ?? null, lastName ?? null, phone ?? null],
    )
  ).rows[0];

const list = async ({ role, status, search, limit, offset }) => {
  const where = [];
  const values = [];
  if (role) { values.push(role); where.push(`role = $${values.length}`); }
  if (status) { values.push(status); where.push(`status = $${values.length}`); }
  if (search) {
    values.push(`%${search.replace(/[%_\\]/g, "\\$&")}%`);
    where.push(`(first_name ILIKE $${values.length} OR last_name ILIKE $${values.length} OR email ILIKE $${values.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((await query(`SELECT COUNT(*) FROM users ${clause}`, values)).rows[0].count);
  const rows = (
    await query(
      `SELECT ${PUBLIC_COLUMNS} FROM users ${clause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    )
  ).rows;
  return { rows, total };
};

const countActiveAdmins = async () =>
  Number((await query("SELECT COUNT(*) FROM users WHERE role='admin' AND status='active'")).rows[0].count);

module.exports = {
  findByEmail, findById, emailExists, create, registerFailedLogin, registerSuccessfulLogin,
  setPassword, setStatus, updateProfile, list, countActiveAdmins, PUBLIC_COLUMNS,
};
