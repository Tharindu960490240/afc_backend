const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/templateService");

const get = asyncHandler(async (req, res) => res.json({ success: true, data: await svc.getActive() }));
const save = asyncHandler(async (req, res) =>
  res.json({ success: true, message: "Template saved. New agreements will use it.", data: await svc.save(req.user, req.body, clientInfo(req)) }));
const preview = asyncHandler(async (req, res) => res.json({ success: true, data: svc.preview(req.body.body) }));

module.exports = { get, save, preview };
