const { Pool, types } = require("pg");
const env = require("./env");

// DATE columns (agreement dates, date of birth) stay plain "YYYY-MM-DD" text, so no time-zone shifting
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  connectionString: env.db.url,
  ssl: env.db.ssl ? { rejectUnauthorized: env.db.rejectUnauthorized } : false,
  // dates such as agreement expiry follow the college's local day
  options: `-c timezone=${env.timezone}`,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => console.error("Unexpected PostgreSQL error:", err.message));

const query = (text, params) => pool.query(text, params);

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any error.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
