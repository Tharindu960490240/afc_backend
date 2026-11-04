const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const authService = require("../services/authService");
const userService = require("../services/userService");
const agentRepo = require("../repositories/agentRepo");
const registrationService = require("../services/registrationService");

const login = asyncHandler(async (req, res) => {
  const { token, user } = await authService.login(req.body.email, req.body.password, clientInfo(req));
  res.json({ success: true, data: { token, user } });
});

const forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body.email, clientInfo(req));
  res.json({ success: true, message: "If an account exists for that email, a reset link has been sent." });
});

const validateResetToken = asyncHandler(async (req, res) => {
  const data = await authService.checkResetToken(req.body.token);
  res.json({ success: true, data });
});

const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password, clientInfo(req));
  res.json({ success: true, message: "Your password has been updated. You can now sign in." });
});

const registerAgent = asyncHandler(async (req, res) => {
  await registrationService.registerAgent(req.body, clientInfo(req));
  res.status(202).json({
    success: true,
    message: "Thank you. If this email can be registered, we have sent a link to confirm it. Please check your inbox.",
  });
});

const verifyAgent = asyncHandler(async (req, res) => {
  await registrationService.verifyAgent(req.body.token, clientInfo(req));
  res.json({ success: true, message: "Your email is confirmed. The college will review your registration and email you." });
});

const me = (req, res) => res.json({ success: true, user: authService.toPublicUser(req.user) });

// Everything the signed-in user may see about themselves (agents also get their agency details).
const myProfile = asyncHandler(async (req, res) => {
  const agent = req.user.role === "agent" ? await agentRepo.findOwn(req.user.id) : null;
  res.json({ success: true, data: { user: { ...authService.toPublicUser(req.user), created_at: req.user.created_at, last_login_at: req.user.last_login_at }, agent } });
});

const updateMe = asyncHandler(async (req, res) => {
  const user = await userService.updateOwnProfile(req.user, req.body);
  res.json({ success: true, user });
});

const changePassword = asyncHandler(async (req, res) => {
  const { token } = await authService.changePassword(req.user, req.body.currentPassword, req.body.newPassword, clientInfo(req));
  res.json({ success: true, message: "Password updated.", data: { token } });
});

module.exports = { registerAgent, verifyAgent, login, forgotPassword, validateResetToken, resetPassword, me, myProfile, updateMe, changePassword };
