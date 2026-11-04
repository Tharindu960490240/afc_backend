const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const userService = require("../services/userService");

const list = asyncHandler(async (req, res) => {
  const r = await userService.list(req.query);
  res.json({ success: true, data: r.rows, pagination: { total: r.total, page: r.page, limit: r.limit } });
});

const setStatus = asyncHandler(async (req, res) => {
  const user = await userService.setStatus(req.user, req.params.id, req.body.status, clientInfo(req));
  res.json({ success: true, data: user });
});

module.exports = { list, setStatus };
