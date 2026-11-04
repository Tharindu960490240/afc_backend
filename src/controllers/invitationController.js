const asyncHandler = require("../utils/asyncHandler");
const { clientInfo, normalizeEmail } = require("../utils/request");
const svc = require("../services/invitationService");

const create = asyncHandler(async (req, res) => {
  const { invitation } = await svc.create(req.user, { ...req.body, email: normalizeEmail(req.body.email) }, clientInfo(req));
  res.status(201).json({ success: true, message: "Invitation sent.", data: invitation });
});

const resend = asyncHandler(async (req, res) => {
  const { invitation } = await svc.resend(req.user, req.params.id, clientInfo(req));
  res.json({ success: true, message: "Invitation re-sent.", data: invitation });
});

const revoke = asyncHandler(async (req, res) => {
  await svc.revoke(req.user, req.params.id, clientInfo(req));
  res.json({ success: true, message: "Invitation revoked." });
});

const list = asyncHandler(async (req, res) => {
  const result = await svc.list(req.user, req.query);
  res.json({ success: true, data: result.rows, pagination: { total: result.total, page: result.page, limit: result.limit } });
});

const getPublic = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.getPublic(req.params.token) });
});

const accept = asyncHandler(async (req, res) => {
  await svc.accept(req.params.token, req.body, clientInfo(req));
  res.status(201).json({ success: true, message: "Your account has been created. You can now sign in." });
});

module.exports = { create, resend, revoke, list, getPublic, accept };
