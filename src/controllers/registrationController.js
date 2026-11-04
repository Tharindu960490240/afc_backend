const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/registrationService");

const list = asyncHandler(async (req, res) => {
  const r = await svc.list(req.query);
  res.json({ success: true, data: r.rows, pagination: { total: r.total, page: r.page, limit: r.limit } });
});
const counts = asyncHandler(async (req, res) => res.json({ success: true, data: await svc.counts() }));
const approve = asyncHandler(async (req, res) => {
  await svc.approve(req.user, req.params.id, clientInfo(req));
  res.json({ success: true, message: "Agent approved. They have been emailed." });
});
const reject = asyncHandler(async (req, res) => {
  await svc.reject(req.user, req.params.id, req.body.reason, clientInfo(req));
  res.json({ success: true, message: "Registration rejected." });
});

module.exports = { list, counts, approve, reject };
