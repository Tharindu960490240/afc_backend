const AppError = require("../utils/AppError");
const userRepo = require("../repositories/userRepo");
const audit = require("../repositories/auditRepo");
const { toPublicUser } = require("./authService");
const comsAgents = require("./comsAgentService");

async function list({ page, limit, role, status, search }) {
  const { rows, total } = await userRepo.list({ role, status, search, limit, offset: (page - 1) * limit });
  return { rows, total, page, limit };
}

async function setStatus(actor, id, status, ctx) {
  if (id === actor.id) throw new AppError(400, "You cannot change your own status.");
  const target = await userRepo.findById(id);
  if (!target) throw new AppError(404, "User not found.");
  if (!["active", "suspended"].includes(target.status)) {
    throw new AppError(409, "This registration has not been approved yet. Approve it from the agent record.");
  }
  if (target.role === "admin" && status === "suspended" && (await userRepo.countActiveAdmins()) <= 1) {
    throw new AppError(400, "You cannot suspend the last active administrator.");
  }
  if (target.role === "agent" && status === "active" && (await comsAgents.isTerminatedLogin(id))) {
    throw new AppError(409, "This agent has been terminated, so their access cannot be switched back on.");
  }
  const updated = await userRepo.setStatus(id, status); // also invalidates their tokens
  if (target.role === "agent") await comsAgents.syncUserStatus(id, status, actor.id);
  await audit.log({ actorId: actor.id, action: "user.status_changed", entityType: "user", entityId: id, metadata: { status }, ...ctx });
  return updated;
}

// the "Authorised staff" flag: CEO or administrator only, and only for staff accounts
async function setAuthorised(actor, id, authorised, ctx) {
  const target = await userRepo.findById(id);
  if (!target) throw new AppError(404, "User not found.");
  if (!require("../const").STAFF_ROLES.includes(target.role) && target.role !== "admin") throw new AppError(409, "Only staff accounts can be marked as authorised staff.");
  const updated = await userRepo.setAuthorised(id, authorised);
  await audit.log({ actorId: actor.id, action: "user.authorised_staff_changed", entityType: "user", entityId: id, before: { authorised: !!target.is_authorised_staff }, after: { authorised }, ...ctx });
  return updated;
}

async function updateOwnProfile(user, body) {
  const updated = await userRepo.updateProfile(user.id, { firstName: body.first_name, lastName: body.last_name, phone: body.phone });
  return toPublicUser(updated);
}

module.exports = { list, setStatus, setAuthorised, updateOwnProfile };
