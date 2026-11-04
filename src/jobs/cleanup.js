const cron = require("node-cron");
const { query } = require("../config/db");

async function purgeExpired() {
  const a = await query(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`);
  const b = await query(`DELETE FROM invitations WHERE accepted_at IS NULL AND (expires_at < now() - interval '90 days' OR revoked_at < now() - interval '90 days')`);
  // registrations that never confirmed their email within a week
  const c = await query(`DELETE FROM users WHERE status = 'unverified' AND created_at < now() - interval '7 days'`);
  console.log(`cleanup: removed ${a.rowCount} reset tokens, ${b.rowCount} old invitations, ${c.rowCount} unconfirmed registrations`);
}

const start = () =>
  cron.schedule("30 2 * * *", () => purgeExpired().catch((e) => console.error("cleanup failed:", e.message)), {
    timezone: "Australia/Melbourne",
  });

module.exports = { start, purgeExpired };
