const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/courseService");

const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, ...(message ? { message } : {}), data });
const list = asyncHandler(async (req, res) => ok(res, await svc.list(req.user)));
const create = asyncHandler(async (req, res) => ok(res, await svc.create(req.user, req.body, clientInfo(req)), "Course added.", 201));
const update = asyncHandler(async (req, res) => ok(res, await svc.update(req.user, req.params.id, req.body, clientInfo(req)), "Course saved."));

module.exports = { list, create, update };
