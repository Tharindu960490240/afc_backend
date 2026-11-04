const env = require("./config/env");
const app = require("./app");
const { pool } = require("./config/db");
const cleanup = require("./jobs/cleanup");
const agreementReminders = require("./jobs/agreementReminders");

async function main() {
  await pool.query("SELECT 1"); // fail fast if the database is unreachable
  const pending = await pool.query("SELECT to_regclass('public.users') AS t");
  if (!pending.rows[0].t) throw new Error("Database is not set up. Run: npm run migrate");

  cleanup.start();
  agreementReminders.start();
  const server = app.listen(env.port, () => console.log(`AFC API listening on http://localhost:${env.port} (${env.nodeEnv})`));

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
