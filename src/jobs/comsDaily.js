// ===============================================================
// Daily COMS jobs (Part 2):
//   - referee reminders: every 3 working days, up to 2 reminders, for forms nobody has answered
//   - decision timer: email the decision makers at day 7 (amber) and day 10 (red) of 10 working days (BR-08)
//   - task alerts and escalation (E5-1, BR-09)
//   - safety net: an approved agent with a countersigned agreement is moved to Onboarding if that step was missed
// Runs from node-cron on a normal server, or from GET /api/jobs/daily (Vercel Cron) on serverless hosting.
// ===============================================================
const cron = require("node-cron");
const env = require("../config/env");
const { query } = require("../config/db");
const ddRepo = require("../repositories/dueDiligenceRepo");
const taskRepo = require("../repositories/taskRepo");
const calendar = require("../services/calendarService");
const email = require("../services/emailService");
const tasks = require("../services/taskService");
const { generateToken, hashToken } = require("../utils/tokens");
const { ROLES } = require("../const");

const settings = require("../services/settingsService");

async function referenceReminders() {
  const today = calendar.localDate();
  const { referee_reminder_days: REMIND_EVERY_WD, referee_max_reminders: REMIND_MAX } = settings.timers();
  let sent = 0;
  for (const c of await ddRepo.awaitingReminder()) {
    if (c.reminder_count >= REMIND_MAX) continue;
    if ((await calendar.businessDaysBetween(calendar.localDate(c.last_at), today)) < REMIND_EVERY_WD) continue;
    const token = generateToken();
    await ddRepo.setReminder(c.id, hashToken(token), new Date(Date.now() + 21 * 24 * 3600 * 1000));
    email.sendReferenceRequest({ to: c.referee_email, refereeName: c.referee_name, agentName: c.agent_name, officerName: null, link: `${env.frontendUrl}/reference/${token}`, reminder: true });
    sent++;
  }
  return sent;
}

async function decisionTimers() {
  const today = calendar.localDate();
  const { decision_days: DECIDE, amber_after_days: AMBER } = settings.timers();
  const people = (await taskRepo.usersWithRoles([ROLES.DIRECTOR, ROLES.CEO]));
  const out = { amber: 0, red: 0 };
  for (const d of await ddRepo.openDecisions()) {
    const elapsed = await calendar.businessDaysBetween(calendar.localDate(d.application_received_at), today);
    const level = elapsed >= DECIDE ? "red" : elapsed >= AMBER ? "amber" : null;
    if (!level || (level === "amber" && d.warned_at) || (level === "red" && d.alerted_at)) continue;
    const daysLeft = Math.max(0, DECIDE - elapsed);
    for (const u of people) email.sendDecisionTimer({ to: u.email, firstName: u.first_name, agentName: d.legal_name, level, daysLeft, link: `${env.frontendUrl}/coms/agents/${d.id}` });
    if (level === "red") { await ddRepo.markAlerted(d.id); if (!d.warned_at) await ddRepo.markWarned(d.id); out.red++; }
    else { await ddRepo.markWarned(d.id); out.amber++; }
  }
  return out;
}

async function reconcileOnboarding() {
  const rows = (await query(
    `SELECT DISTINCT ag.id FROM agreements ag JOIN agent_persons p ON p.portal_user_id = ag.agent_id
     JOIN agents a ON a.id = p.agent_id
     WHERE ag.status = 'active' AND ag.effective_date IS NOT NULL AND a.status = 'approved' AND a.deleted_at IS NULL AND p.deleted_at IS NULL`)).rows;
  let n = 0;
  const system = { id: null, role: ROLES.ADMIN };
  for (const r of rows) { if ((await tasks.onAgreementCountersigned(r.id, system, {}))?.length) n++; }
  return n;
}

async function run() {
  await settings.ensureFresh();
  const result = {
    referenceReminders: await referenceReminders(),
    decisionTimers: await decisionTimers(),
    tasks: await tasks.runAlerts(),
    onboardingStarted: await reconcileOnboarding(),
  };
  console.log("COMS daily jobs:", JSON.stringify(result));
  return result;
}

const start = () =>
  cron.schedule("10 8 * * *", () => run().catch((e) => console.error("COMS daily jobs failed:", e.message)), { timezone: env.timezone });

module.exports = { start, run, referenceReminders, decisionTimers, reconcileOnboarding };
