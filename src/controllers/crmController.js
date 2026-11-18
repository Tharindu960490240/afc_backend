const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const env = require("../config/env");
const AppError = require("../utils/AppError");
const crypto = require("crypto");
const svc = require("../services/crmService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const w = (fn) => asyncHandler(async (req, res) => fn(req, res));

// ---- agent portal ----
const myLeads = w(async (req, res) => ok(res, await svc.myLeads(req.user)));
const addLead = w(async (req, res) => ok(res, await svc.addLead(req.user, req.body, clientInfo(req)), 201));
const updateLead = w(async (req, res) => ok(res, await svc.updateLead(req.user, req.params.id, req.body, clientInfo(req))));
const myCommunications = w(async (req, res) => ok(res, await svc.myCommunications(req.user)));

// ---- staff: an agent's record ----
const comms = w(async (req, res) => ok(res, await svc.listComms(req.user, req.params.id)));
const logComm = w(async (req, res) => ok(res, await svc.logComm(req.user, req.params.id, req.body, clientInfo(req)), 201));
const editComm = w(async (req, res) => ok(res, await svc.editComm(req.user, req.params.id, req.params.commId, req.body, clientInfo(req))));
const leads = w(async (req, res) => ok(res, await svc.staffLeads(req.user, req.params.id)));
const training = w(async (req, res) => ok(res, await svc.listTraining(req.user, req.params.id)));
const addTraining = w(async (req, res) => ok(res, await svc.addTraining(req.user, req.params.id, req.body, clientInfo(req)), 201));
const monitoring = w(async (req, res) => ok(res, await svc.monitoring(req.user, req.params.id)));
const createReview = w(async (req, res) => ok(res, await svc.createReview(req.user, req.params.id, req.body, clientInfo(req)), 201));
const createCorrective = w(async (req, res) => ok(res, await svc.createCorrective(req.user, req.params.id, req.body, clientInfo(req)), 201));
const updateCorrective = w(async (req, res) => ok(res, await svc.updateCorrective(req.user, req.params.id, req.params.actionId, req.body, clientInfo(req))));
const redraftCorrective = w(async (req, res) => ok(res, await svc.redraftCorrective(req.user, req.params.id, req.params.actionId)));
const sendCorrective = w(async (req, res) => ok(res, await svc.sendCorrective(req.user, req.params.id, req.params.actionId, clientInfo(req))));
const implemented = w(async (req, res) => ok(res, await svc.resolveCorrective(req.user, req.params.id, req.params.actionId, "implemented", req.body.note, clientInfo(req))));
const notImplemented = w(async (req, res) => ok(res, await svc.resolveCorrective(req.user, req.params.id, req.params.actionId, "not_implemented", req.body.note, clientInfo(req))));
const cancelCorrective = w(async (req, res) => ok(res, await svc.cancelCorrective(req.user, req.params.id, req.params.actionId, req.body.reason, clientInfo(req))));

// ---- staff: broadcasts ----
const broadcasts = w(async (req, res) => ok(res, await svc.listBroadcasts(req.user)));
const broadcast = w(async (req, res) => ok(res, await svc.getBroadcast(req.user, req.params.id)));
const createBroadcast = w(async (req, res) => ok(res, await svc.createBroadcast(req.user, req.body, clientInfo(req)), 201));
const updateBroadcast = w(async (req, res) => ok(res, await svc.updateBroadcast(req.user, req.params.id, req.body, clientInfo(req))));
const approveBroadcast = w(async (req, res) => ok(res, await svc.approveBroadcast(req.user, req.params.id, clientInfo(req))));
const cancelBroadcast = w(async (req, res) => ok(res, await svc.cancelBroadcast(req.user, req.params.id, clientInfo(req))));

// ---- inbound email (called by the mail service, not a person): protected by a shared secret ----
const inboundEmail = asyncHandler(async (req, res) => {
  const secret = env.inboundEmailSecret;
  if (!secret) throw new AppError(404, "Not found.");
  const given = Buffer.from(String(req.get("x-inbound-secret") || ""));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new AppError(401, "Not authorised.");
  const r = await svc.logEmail(req.body);
  res.status(r.matched ? 201 : 202).json({ success: true, data: r });
});

module.exports = {
  myLeads, addLead, updateLead, myCommunications,
  comms, logComm, editComm, leads, training, addTraining, monitoring, createReview,
  createCorrective, updateCorrective, redraftCorrective, sendCorrective, implemented, notImplemented, cancelCorrective,
  broadcasts, broadcast, createBroadcast, updateBroadcast, approveBroadcast, cancelBroadcast, inboundEmail,
};
