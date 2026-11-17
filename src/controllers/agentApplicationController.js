const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/comsAgentService");

const show = asyncHandler(async (req, res) => res.json({ success: true, data: await svc.myApplication(req.user) }));
const submit = asyncHandler(async (req, res) => {
  const data = await svc.submitApplication(req.user, req.body, clientInfo(req));
  res.json({ success: true, message: "Thank you. Your application has been submitted.", data });
});
const induction = asyncHandler(async (req, res) => res.json({ success: true, data: await require("../services/inductionService").mine(req.user) }));
module.exports = { show, submit, induction };
