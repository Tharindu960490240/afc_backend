// Wipes ALL data except: administrator accounts, the public-holiday calendar and the agreement template.
// Removes every other user, agent, agreement, task, document record, invitation and the audit log.
// Files stored on disk (uploads/) are not touched.
//
// Usage:   npm run reset:data              (asks you to type the database name)
//          npm run reset:data -- --force   (no question: for scripts only)
require("dotenv").config();
const readline = require("readline");
const { pool } = require("../src/config/db");

const KEEP = ["users (role = admin only)", "public_holidays", "agreement_templates", "schema_migrations"];
const WIPE = [
  "agent_documents", "coms_files", "coms_tasks", "referee_checks", "agent_referees", "agent_due_diligence", "agent_status_history",
  "agent_persons", "agents", "agreement_events", "agreement_files", "agreements", "invitations", "password_resets",
  "email_verifications", "student_profiles", "agent_profiles",
];

const ask = (q) => new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); resolve(a.trim()); }); });

async function main() {
  const info = (await pool.query("SELECT current_database() AS db, inet_server_addr()::text AS host")).rows[0];
  const admins = (await pool.query("SELECT email FROM users WHERE role = 'admin' ORDER BY id")).rows;
  if (admins.length === 0) throw new Error("There is no administrator account. Run `npm run seed:admin` first, then try again. Nothing was deleted.");
  const others = (await pool.query("SELECT count(*)::int AS n FROM users WHERE role <> 'admin'")).rows[0].n;

  console.log(`\nDatabase: ${info.db}  (server ${info.host || "local socket"})`);
  console.log(`Will KEEP: ${KEEP.join(", ")}`);
  console.log(`Administrators kept: ${admins.map((a) => a.email).join(", ")}`);
  console.log(`Will DELETE: ${others} other user(s), all agents and their records, agreements, tasks, invitations and the audit log.\n`);

  if (!process.argv.includes("--force")) {
    const typed = await ask(`This cannot be undone. Type the database name (${info.db}) to continue: `);
    if (typed !== info.db) { console.log("Cancelled. Nothing was deleted."); return; }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL afc.allow_audit_purge = 'on'"); // the audit log is otherwise kept for 7 years
    await client.query("DELETE FROM audit_logs");
    await client.query(`TRUNCATE ${WIPE.join(", ")} RESTART IDENTITY CASCADE`);
    const r = await client.query("DELETE FROM users WHERE role <> 'admin'");
    await client.query("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE role = 'admin'");
    await client.query("COMMIT");
    console.log(`Done. Removed ${r.rowCount} user(s) and all agent data. Kept ${admins.length} administrator(s).`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
main().catch((e) => { console.error("Failed, nothing was changed:", e.message); process.exitCode = 1; }).finally(() => pool.end());
