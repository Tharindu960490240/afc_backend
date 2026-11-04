// ===============================
// Agents registering themselves from the college website.
//
//   register -> confirm email (link) -> college approves -> can sign in
//
// The public answers never say whether an email is already in use.
// ===============================
const env = require("../config/env");
const AppError = require("../utils/AppError");
const { withTransaction, query } = require("../config/db");
const { ROLES } = require("../const");
const { generateToken, hashToken } = require("../utils/tokens");
const { hashPassword } = require("../utils/password");
const userRepo = require("../repositories/userRepo");
const verifyRepo = require("../repositories/verificationRepo");
const regRepo = require("../repositories/registrationRepo");
const audit = require("../repositories/auditRepo");
const email = require("./emailService");
const comsAgents = require("./comsAgentService");

const BAD_LINK = "This confirmation link is not valid or has expired. Please register again to get a new one.";
const fullName = (u) => `${u.first_name} ${u.last_name}`.trim();
const linkFor = (token) => `${env.frontendUrl}/register/agent/verify/${token}`;
const activeAdmins = async () =>
  (await query(`SELECT first_name, email FROM users WHERE role='admin' AND status='active'`)).rows;

async function sendVerification(client, user) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + env.verifyTtlHours * 3600 * 1000);
  await verifyRepo.issue(client, user.id, hashToken(token), expiresAt);
  return () =>
    email.sendAgentVerification({ to: user.email, firstName: user.first_name, link: linkFor(token), ttlHours: env.verifyTtlHours });
}

// Always resolves the same way, so the form cannot be used to find out who has an account.
async function registerAgent(body, ctx) {
  const passwordHash = await hashPassword(body.password); // same work whether or not the email is new
  const existing = await userRepo.findByEmail(body.email);

  if (existing) {
    // Never overwrite someone's pending registration (that could hand the account to a stranger).
    if (existing.status === "unverified" && existing.role === ROLES.AGENT) {
      const send = await withTransaction((client) => sendVerification(client, existing));
      await audit.log({ actorId: existing.id, action: "agent.registration_resent", ...ctx });
      send();
    } else {
      await audit.log({ actorId: existing.id, action: "agent.registration_duplicate", ...ctx });
      email.sendRegistrationExists({ to: existing.email, firstName: existing.first_name, signInUrl: `${env.frontendUrl}/signin` });
    }
    return;
  }

  try {
    const send = await withTransaction(async (client) => {
      const user = await userRepo.create(client, {
        email: body.email, passwordHash, firstName: body.first_name, lastName: body.last_name,
        phone: body.phone, role: ROLES.AGENT, consentAt: new Date(), status: "unverified",
      });
      await client.query(
        `INSERT INTO agent_profiles (user_id, agency_name, business_number, country, registered_via)
         VALUES ($1,$2,$3,$4,'website')`,
        [user.id, body.agency_name, body.business_number, body.country],
      );
      await comsAgents.linkNewPortalUser(
        client,
        { user, agencyName: body.agency_name, businessNumber: body.business_number, country: body.country, via: "website" },
        null,
      );
      await audit.log({ actorId: user.id, action: "agent.registered", metadata: { via: "website" }, ...ctx }, client);
      return sendVerification(client, user);
    });
    send();
  } catch (err) {
    if (err.code !== "23505") throw err; // two submissions at once: the other one wins quietly
  }
}

// The agent opens the link from the email.
async function verifyAgent(token, ctx) {
  let agentId = null;
  const info = await withTransaction(async (client) => {
    const row = await verifyRepo.findValidByHash(client, hashToken(token));
    if (!row || row.status !== "unverified") throw new AppError(400, BAD_LINK);
    await verifyRepo.markUsed(client, row.id);
    await client.query(`UPDATE users SET status='pending_approval', updated_at=now() WHERE id=$1`, [row.user_id]);
    await client.query(`UPDATE agent_profiles SET email_verified_at=now() WHERE user_id=$1`, [row.user_id]);
    agentId = await comsAgents.markApplicationReceived(client, row.user_id);
    await audit.log({ actorId: row.user_id, action: "agent.email_verified", ...ctx }, client);
    const profile = (await client.query(`SELECT agency_name, country FROM agent_profiles WHERE user_id=$1`, [row.user_id])).rows[0];
    return { ...row, ...profile };
  });

  if (agentId) await comsAgents.acknowledge(agentId).catch((e) => console.error("acknowledgement failed:", e.message));
  else email.sendAgentPending({ to: info.email, firstName: info.first_name });
  for (const admin of await activeAdmins()) {
    email.sendAgentRegistrationToAdmin({
      to: admin.email, firstName: admin.first_name, agentName: fullName(info),
      agencyName: info.agency_name, country: info.country, link: `${env.frontendUrl}/admin/registrations`,
    });
  }
}

// ---------- admin ----------
const list = async ({ status, page, limit }) => {
  const { rows, total } = await regRepo.list({ status, limit, offset: (page - 1) * limit });
  return { rows, total, page, limit };
};

async function decide(actor, id, approve, reason, ctx) {
  const target = await userRepo.findById(id);
  if (!target || target.role !== ROLES.AGENT) throw new AppError(404, "Registration not found.");

  await withTransaction(async (client) => {
    const row = (await client.query(`SELECT status FROM users WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!row || row.status !== "pending_approval") {
      throw new AppError(409, "This registration is not waiting for a decision.");
    }
    await client.query(`UPDATE users SET status=$2, updated_at=now() WHERE id=$1`, [id, approve ? "active" : "rejected"]);
    await client.query(
      `UPDATE agent_profiles SET decided_by=$2, decided_at=now(), rejection_reason=$3 WHERE user_id=$1`,
      [id, actor.id, approve ? null : reason || null],
    );
    await comsAgents.syncDecision(client, id, approve, actor.id, reason);
    await audit.log({ actorId: actor.id, action: approve ? "agent.approved" : "agent.rejected", entityType: "user", entityId: id, ...ctx }, client);
  });

  if (approve) email.sendAgentApproved({ to: target.email, firstName: target.first_name, signInUrl: `${env.frontendUrl}/signin` });
  else email.sendAgentRejected({ to: target.email, firstName: target.first_name, reason });
}

const approve = (actor, id, ctx) => decide(actor, id, true, null, ctx);
const reject = (actor, id, reason, ctx) => decide(actor, id, false, reason, ctx);
const counts = () => regRepo.counts();

module.exports = { registerAgent, verifyAgent, list, approve, reject, counts };
