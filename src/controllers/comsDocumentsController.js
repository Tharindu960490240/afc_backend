const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const docs = require("../services/agentDocumentService");
const agents = require("../services/comsAgentService");
const pdfService = require("../services/applicationPdf");
const agentRepo = require("../repositories/comsAgentRepo");
const audit = require("../repositories/auditRepo");
const AppError = require("../utils/AppError");
const { AGENT_PERMS } = require("../const");

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const ctx = clientInfo;
const send = (res, f) => {
  res.set({ "Content-Type": f.mime, "Content-Length": f.size, "Content-Disposition": `attachment; filename="${encodeURIComponent(f.name)}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  f.stream.pipe(res);
};

// ---- staff ----
const list = asyncHandler(async (req, res) => ok(res, await docs.list(req.user, req.params.id)));
const upload = asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await docs.upload(req.user, req.params.id, req.body, ctx(req)) }));
const review = asyncHandler(async (req, res) => ok(res, await docs.review(req.user, req.params.id, req.params.docId, req.body, ctx(req))));
const remove = asyncHandler(async (req, res) => ok(res, await docs.remove(req.user, req.params.id, req.params.docId, req.body.reason, ctx(req))));
const download = asyncHandler(async (req, res) => send(res, await docs.open(req.user, req.params.id, req.params.docId, ctx(req))));
const requestInfo = asyncHandler(async (req, res) => ok(res, await docs.requestInfo(req.user, req.params.id, req.body, ctx(req))));
const terms = asyncHandler(async (req, res) => ok(res, await agents.recordTerms(req.user, req.params.id, req.body, ctx(req))));

// the completed application form (AFC-EAAF V2.0) as a PDF, for the agent folder
const applicationPdf = asyncHandler(async (req, res) => {
  if (!AGENT_PERMS.read.includes(req.user.role)) throw new AppError(403, "You do not have permission to do that.");
  const agent = await agentRepo.findById(req.params.id);
  if (!agent || agent.deleted_at) throw new AppError(404, "Agent not found.");
  if (!agent.application_submitted_at) throw new AppError(409, "This agent has not submitted the application form yet.");
  const [persons, referees, d] = await Promise.all([agentRepo.persons(agent.id), agentRepo.referees(agent.id), require("../repositories/agentDocRepo").list(agent.id)]);
  const buffer = await pdfService.render({ agent, persons, referees, documents: d });
  await audit.log({ actorId: req.user.id, action: "agent.application_pdf_downloaded", entityType: "agent", entityId: agent.id, ...ctx(req) });
  const name = `${agent.legal_name} - Education Agent Application Form.pdf`.replace(/[\\/:*?"<>|\r\n]/g, " ");
  res.set({ "Content-Type": "application/pdf", "Content-Length": buffer.length, "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`, "Cache-Control": "no-store" });
  res.end(buffer);
});

// ---- the agent's own documents ----
const mine = asyncHandler(async (req, res) => ok(res, await docs.mine(req.user)));
const mineUpload = asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await docs.uploadMine(req.user, req.body, ctx(req)) }));
const mineRemove = asyncHandler(async (req, res) => ok(res, await docs.removeMine(req.user, req.params.docId, ctx(req))));
const mineDownload = asyncHandler(async (req, res) => send(res, await docs.openMine(req.user, req.params.docId, ctx(req))));

// ---- certificate of appointment ----
const cert = require("../services/certificateService");
const certificate = asyncHandler(async (req, res) => {
  if (!cert.canSee(req.user.role)) throw new AppError(403, "You do not have permission to do that.");
  send(res, await cert.open(req.params.id, req.user.id, ctx(req)));
});
const certificateSend = asyncHandler(async (req, res) => {
  if (!AGENT_PERMS.sendAgreement.includes(req.user.role)) throw new AppError(403, "You do not have permission to do that.");
  ok(res, await cert.sendToAgent(req.params.id, req.user.id, ctx(req)));
});
const mineCertificate = asyncHandler(async (req, res) => {
  const found = await agentRepo.findByPortalUser(req.user.id);
  if (!found) throw new AppError(404, "We could not find your application.");
  send(res, await cert.open(found.id, req.user.id, ctx(req), { agentSelf: true }));
});
const mineCertificateStatus = asyncHandler(async (req, res) => {
  const found = await agentRepo.findByPortalUser(req.user.id);
  if (!found) throw new AppError(404, "We could not find your application.");
  ok(res, await cert.statusFor(found.id));
});

module.exports = { certificate, certificateSend, mineCertificate, mineCertificateStatus, list, upload, review, remove, download, requestInfo, terms, applicationPdf, mine, mineUpload, mineRemove, mineDownload };
