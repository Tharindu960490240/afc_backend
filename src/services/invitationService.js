const env = require("../config/env");
const AppError = require("../utils/AppError");
const { withTransaction } = require("../config/db");
const { INVITE_PERMISSIONS, ROLES, STAFF_ROLES } = require("../const");
const { generateToken, hashToken } = require("../utils/tokens");
const { hashPassword } = require("../utils/password");
const { acceptSchemas } = require("../validators/schemas");
const userRepo = require("../repositories/userRepo");
const invitationRepo = require("../repositories/invitationRepo");
const audit = require("../repositories/auditRepo");
const email = require("./emailService");
const comsAgents = require("./comsAgentService");

// college staff can see and manage every invitation; agents only their own
const isStaff = (u) => STAFF_ROLES.includes(u.role);

const INVALID = "This invitation is not valid or has expired. Please contact the college for a new one.";
const fullName = (u) => `${u.first_name} ${u.last_name}`.trim();

const linkFor = (token) => `${env.frontendUrl}/signup/${token}`;

// Revokes any open invite for the email, creates a fresh one, emails it.
async function issue(actor, { email: to, role, firstName, agentId }, ctx, action) {
  const allowed = INVITE_PERMISSIONS[actor.role] || [];
  if (!allowed.includes(role)) throw new AppError(403, "You are not allowed to invite that type of user.");
  if (await userRepo.emailExists(to)) {
    throw new AppError(409, "A user with this email already exists.", { errors: { email: "Already registered" } });
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + env.invitationTtlHours * 3600 * 1000);

  const invitation = await withTransaction(async (client) => {
    const open = await invitationRepo.findOpenByEmail(client, to);
    if (open) {
      // Agents may only replace invitations they sent themselves.
      if (!isStaff(actor) && open.invited_by !== actor.id) {
        throw new AppError(409, "An invitation has already been sent to this email.");
      }
      await invitationRepo.revoke(client, open.id);
    }
    const created = await invitationRepo.create(client, {
      email: to, role, firstName, agentId, tokenHash: hashToken(token), invitedBy: actor.id, expiresAt,
    });
    await audit.log({ actorId: actor.id, action, entityType: "invitation", entityId: created.id, metadata: { role, email: to }, ...ctx }, client);
    return created;
  });

  email.sendInvitation({
    to, firstName, role, link: linkFor(token), invitedByName: fullName(actor), expiresAt,
  });
  return { invitation };
}

const create = (actor, body, ctx) =>
  issue(actor, { email: body.email, role: body.role, firstName: body.first_name }, ctx, "invitation.created");

async function loadManageable(actor, id) {
  const inv = await invitationRepo.findById(id);
  if (!inv || (!isStaff(actor) && inv.invited_by !== actor.id)) throw new AppError(404, "Invitation not found.");
  return inv;
}

async function resend(actor, id, ctx) {
  const inv = await loadManageable(actor, id);
  if (inv.accepted_at) throw new AppError(409, "This invitation has already been accepted.");
  return issue(actor, { email: inv.email, role: inv.role, firstName: inv.first_name, agentId: inv.agent_id }, ctx, "invitation.resent");
}

async function revoke(actor, id, ctx) {
  const inv = await loadManageable(actor, id);
  if (inv.accepted_at) throw new AppError(409, "This invitation has already been accepted.");
  await invitationRepo.revoke(null, id);
  await audit.log({ actorId: actor.id, action: "invitation.revoked", entityType: "invitation", entityId: id, ...ctx });
}

async function list(actor, { status, page, limit }) {
  const { rows, total } = await invitationRepo.list({
    status: ["pending", "accepted", "revoked", "expired"].includes(status) ? status : undefined,
    invitedBy: isStaff(actor) ? undefined : actor.id,
    limit, offset: (page - 1) * limit,
  });
  return { rows, total, page, limit };
}

// Public: what the sign-up page needs, nothing more.
async function getPublic(token) {
  const inv = await invitationRepo.findValidByHash(hashToken(token));
  if (!inv) throw new AppError(404, INVALID);
  return { email: inv.email, role: inv.role, first_name: inv.first_name, expires_at: inv.expires_at };
}

async function accept(token, body, ctx) {
  const tokenHash = hashToken(token);
  const preview = await invitationRepo.findValidByHash(tokenHash);
  if (!preview) throw new AppError(404, INVALID);

  // The role (and so the allowed fields) is decided by the invitation, never by the browser.
  const parsed = acceptSchemas[preview.role].safeParse(body);
  if (!parsed.success) {
    const errors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      if (!errors[key]) errors[key] = issue.message;
    }
    throw new AppError(400, "Please check the highlighted fields.", { errors });
  }
  const d = parsed.data;
  const passwordHash = await hashPassword(d.password);

  let applied = null;
  try {
    const result = await withTransaction(async (client) => {
      const inv = await invitationRepo.findValidByHash(tokenHash, client); // row lock: single use even under races
      if (!inv) throw new AppError(404, INVALID);
      if (await userRepo.emailExists(inv.email, client)) throw new AppError(409, "An account with this email already exists.");

      const user = await userRepo.create(client, {
        email: inv.email, passwordHash, firstName: d.first_name, lastName: d.last_name,
        phone: d.phone, role: inv.role, consentAt: new Date(),
      });

      if (inv.role === ROLES.AGENT) {
        await client.query(
          `INSERT INTO agent_profiles (user_id, agency_name, business_number, country) VALUES ($1,$2,$3,$4)`,
          [user.id, d.agency_name, d.business_number, d.country],
        );
        // the college's agent register gets a record for every new agent
        applied = await comsAgents.linkNewPortalUser(
          client,
          { user, agencyName: d.agency_name, businessNumber: d.business_number, country: d.country, via: "invitation" },
          inv.agent_id,
        );
      } else if (inv.role === ROLES.STUDENT) {
        const inviter = inv.invited_by ? await userRepo.findById(inv.invited_by) : null;
        await client.query(
          `INSERT INTO student_profiles (user_id, date_of_birth, country, agent_id) VALUES ($1,$2,$3,$4)`,
          [user.id, d.date_of_birth, d.country, inviter?.role === ROLES.AGENT ? inviter.id : null],
        );
      }

      await invitationRepo.markAccepted(client, inv.id, user.id);
      await audit.log({ actorId: user.id, action: "invitation.accepted", entityType: "invitation", entityId: inv.id, metadata: { role: inv.role }, ...ctx }, client);
      return { id: user.id, role: user.role };
    });
    if (applied?.applied) await comsAgents.acknowledge(applied.agentId).catch((e) => console.error("acknowledgement failed:", e.message));
    return result;
  } catch (err) {
    if (err.code === "23505") throw new AppError(409, "An account with this email already exists.");
    throw err;
  }
}

module.exports = { create, resend, revoke, list, getPublic, accept, issue };
