// ===============================================================
// Daily agreement reminders (email only; documents stay in the portal).
//   - agent has not signed:       every 3 days, up to 5 reminders
//   - admin has not reviewed:     after 2 days, then every 2 days
//   - active agreement expiring:  at 60, 30 and 7 days, and once it expires
// ===============================================================
const cron = require("node-cron");
const env = require("../config/env");
const { query } = require("../config/db");
const repo = require("../repositories/agreementRepo");
const email = require("../services/emailService");

const AGENT_EVERY_DAYS = 3;
const AGENT_MAX = 5;
const REVIEW_AFTER_DAYS = 2;

const stageFor = (daysLeft) => (daysLeft < 0 ? -1 : daysLeft <= 7 ? 7 : daysLeft <= 30 ? 30 : 60);

async function run() {
  const admins = (await query(`SELECT first_name, email FROM users WHERE role='admin' AND status='active'`)).rows;
  const counts = { agent: 0, review: 0, expiry: 0 };

  for (const a of await repo.dueAgentReminders(AGENT_EVERY_DAYS, AGENT_MAX)) {
    email.sendAgreementReminder({ to: a.agent_email, firstName: a.agent_first_name, title: a.title, rejected: a.stored_status === "rejected" });
    await repo.touchReminder(a.id);
    counts.agent++;
  }

  for (const a of await repo.dueReviewReminders(REVIEW_AFTER_DAYS)) {
    const agentName = `${a.agent_first_name} ${a.agent_last_name}`;
    for (const admin of admins) email.sendReviewReminder({ to: admin.email, firstName: admin.first_name, agentName, id: a.id });
    await repo.touchReminder(a.id);
    counts.review++;
  }

  for (const a of await repo.dueExpiryNotices()) {
    const daysLeft = Number(a.days_left);
    const agentName = `${a.agent_first_name} ${a.agent_last_name}`;
    email.sendAgreementExpiry({ to: a.agent_email, firstName: a.agent_first_name, title: a.title, expiresAt: a.expires_at, daysLeft });
    for (const admin of admins) {
      email.sendAgreementExpiryToAdmin({ to: admin.email, firstName: admin.first_name, agentName, expiresAt: a.expires_at, daysLeft, id: a.id });
    }
    await repo.setExpiryNotice(a.id, stageFor(daysLeft));
    counts.expiry++;
  }

  if (counts.agent || counts.review || counts.expiry) console.log("agreement reminders sent:", counts);
  return counts;
}

const start = () =>
  cron.schedule("0 8 * * *", () => run().catch((e) => console.error("agreement reminders failed:", e.message)), {
    timezone: env.timezone,
  });

module.exports = { start, run, stageFor };
