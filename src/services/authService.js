const env = require("../config/env");
const AppError = require("../utils/AppError");
const { withTransaction } = require("../config/db");
const { hashPassword, comparePassword, DUMMY_HASH } = require("../utils/password");
const { signAccessToken } = require("../utils/jwt");
const { generateToken, hashToken } = require("../utils/tokens");
const userRepo = require("../repositories/userRepo");
const resetRepo = require("../repositories/resetRepo");
const audit = require("../repositories/auditRepo");
const email = require("./emailService");

const BAD_LOGIN = "Invalid email or password.";
const NOT_ACTIVE = {
  suspended: "This account is disabled. Please contact the college.",
  unverified: "Please confirm your email first. Open the link we emailed you, or register again to get a new link.",
  pending_approval: "Your registration is waiting for approval by the college. We will email you when it is approved.",
  rejected: "Your registration was not approved. Please contact the college.",
};
const BAD_RESET = "This reset link is not valid or has expired. Please request a new one.";

const toPublicUser = (u) => ({
  id: u.id,
  email: u.email,
  first_name: u.first_name,
  last_name: u.last_name,
  phone: u.phone,
  role: u.role,
  status: u.status,
  profile_image: u.profile_image || null,
});

async function login(emailAddress, password, ctx) {
  const user = await userRepo.findByEmail(emailAddress);

  if (!user) {
    await comparePassword(password, DUMMY_HASH); // keep timing similar
    await audit.log({ action: "auth.login_failed", metadata: { reason: "unknown_email" }, ...ctx });
    throw new AppError(401, BAD_LOGIN);
  }

  if (user.locked_until && user.locked_until > new Date()) {
    const mins = Math.ceil((user.locked_until - new Date()) / 60000);
    await audit.log({ actorId: user.id, action: "auth.login_blocked", ...ctx });
    throw new AppError(429, `Too many failed attempts. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }

  const ok = await comparePassword(password, user.password_hash);
  if (!ok) {
    const state = await userRepo.registerFailedLogin(user.id, env.maxFailedLogins, env.lockoutMinutes);
    await audit.log({
      actorId: user.id, action: "auth.login_failed",
      metadata: { reason: "bad_password", locked: Boolean(state?.locked_until && state.locked_until > new Date()) }, ...ctx,
    });
    throw new AppError(401, BAD_LOGIN);
  }

  // Password is right, so it is safe to tell this person about the account state.
  if (user.status !== "active") {
    await audit.log({ actorId: user.id, action: "auth.login_blocked", metadata: { reason: user.status }, ...ctx });
    throw new AppError(403, NOT_ACTIVE[user.status] || NOT_ACTIVE.suspended);
  }

  await userRepo.registerSuccessfulLogin(user.id);
  await audit.log({ actorId: user.id, action: "auth.login", ...ctx });
  return { token: signAccessToken(user), user: toPublicUser(user) };
}

// Always resolves the same way, whether or not the email exists (no account enumeration).
async function forgotPassword(emailAddress, ctx) {
  const user = await userRepo.findByEmail(emailAddress);
  if (!user || user.status !== "active") {
    await audit.log({ action: "auth.reset_requested", metadata: { matched: false }, ...ctx });
    return;
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + env.resetTtlMinutes * 60 * 1000);
  await withTransaction((client) => resetRepo.issue(client, user.id, hashToken(token), expiresAt));
  await audit.log({ actorId: user.id, action: "auth.reset_requested", metadata: { matched: true }, ...ctx });

  email.sendPasswordReset({
    to: user.email,
    firstName: user.first_name,
    link: `${env.frontendUrl}/reset-password?token=${token}`,
    ttlMinutes: env.resetTtlMinutes,
  });
}

// Lets the reset page show which account it is for, and fail early on a dead link.
async function checkResetToken(token) {
  const row = await resetRepo.findValidByHash(hashToken(token));
  if (!row || row.status !== "active") throw new AppError(400, BAD_RESET);
  return { email: row.email };
}

async function resetPassword(token, newPassword, ctx) {
  const passwordHash = await hashPassword(newPassword);
  const user = await withTransaction(async (client) => {
    const row = await resetRepo.findValidByHash(hashToken(token), client);
    if (!row || row.status !== "active") throw new AppError(400, BAD_RESET);

    await userRepo.setPassword(client, row.user_id, passwordHash); // also kills existing sessions
    await resetRepo.markUsed(client, row.id);
    await client.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [row.user_id]);
    await audit.log({ actorId: row.user_id, action: "auth.password_reset", ...ctx }, client);
    return { id: row.user_id, email: row.email };
  });
  const full = await userRepo.findById(user.id);
  email.sendPasswordChanged({ to: full.email, firstName: full.first_name });
}

async function changePassword(user, currentPassword, newPassword, ctx) {
  if (!(await comparePassword(currentPassword, user.password_hash))) {
    throw new AppError(400, "Your current password is incorrect.", { errors: { currentPassword: "Incorrect password" } });
  }
  if (await comparePassword(newPassword, user.password_hash)) {
    throw new AppError(400, "Choose a password you have not used before.", { errors: { newPassword: "Must be different" } });
  }
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await userRepo.setPassword(client, user.id, passwordHash);
    await audit.log({ actorId: user.id, action: "auth.password_changed", ...ctx }, client);
  });
  const updated = await userRepo.findById(user.id); // read after commit so token_version is the new one
  email.sendPasswordChanged({ to: user.email, firstName: user.first_name });
  return { token: signAccessToken(updated) }; // old tokens are now invalid, hand back a fresh one
}

module.exports = { login, forgotPassword, checkResetToken, resetPassword, changePassword, toPublicUser };
