const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/settingsAdminService");

const ok = (res, data, message) => res.json({ success: true, ...(message ? { message } : {}), data });
const get = asyncHandler(async (req, res) => ok(res, await svc.getAll()));
const questions = asyncHandler(async (req, res) => ok(res, await svc.saveQuestions(req.user, req.body, clientInfo(req)), "Reference questions saved."));
const documents = asyncHandler(async (req, res) => ok(res, await svc.saveDocTypes(req.user, req.body, clientInfo(req)), "Document types saved."));
const timers = asyncHandler(async (req, res) => ok(res, await svc.saveTimers(req.user, req.body, clientInfo(req)), "Timers saved."));
const college = asyncHandler(async (req, res) => ok(res, await svc.saveCollege(req.user, req.body, clientInfo(req)), "College details saved."));
const signature = asyncHandler(async (req, res) => ok(res, await svc.saveSignature(req.user, req.body, clientInfo(req)), "Signature saved."));
const signatureRemove = asyncHandler(async (req, res) => ok(res, await svc.removeSignature(req.user, clientInfo(req)), "Back to the standard signature."));
const tasks = asyncHandler(async (req, res) => ok(res, await svc.saveTasks(req.user, req.body, clientInfo(req)), "Onboarding tasks saved."));

module.exports = { get, questions, documents, timers, college, signature, signatureRemove, tasks };
