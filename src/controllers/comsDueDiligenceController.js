const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const dd = require("../services/dueDiligenceService");
const agents = require("../services/comsAgentService");
const tasks = require("../services/taskService");
const { sendCsv } = require("../utils/csv");

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const ctx = clientInfo;

// ---- due diligence ----
const get = asyncHandler(async (req, res) => ok(res, await dd.get(req.user, req.params.id)));
const addReferee = asyncHandler(async (req, res) => {
  const r = await dd.addReferee(req.user, req.params.id, req.body, ctx(req));
  res.status(201).json({ success: true, data: r.referees });
});
const updateReferee = asyncHandler(async (req, res) => ok(res, await dd.updateReferee(req.user, req.params.id, req.params.refereeId, req.body, ctx(req))));
const removeReferee = asyncHandler(async (req, res) => ok(res, await dd.removeReferee(req.user, req.params.id, req.params.refereeId, req.body.reason, ctx(req))));
const request = asyncHandler(async (req, res) => ok(res, await dd.sendReferenceRequest(req.user, req.params.id, req.params.refereeId, ctx(req))));
const phone = asyncHandler(async (req, res) => ok(res, await dd.recordPhoneCheck(req.user, req.params.id, req.params.refereeId, req.body, ctx(req))));
const remind = asyncHandler(async (req, res) => ok(res, await dd.sendReminder(req.user, req.params.id, req.params.checkId, ctx(req))));
const outcome = asyncHandler(async (req, res) => ok(res, await dd.setOutcome(req.user, req.params.id, req.params.checkId, req.body, ctx(req))));
const check = asyncHandler(async (req, res) => ok(res, await dd.recordCheck(req.user, req.params.id, req.body, ctx(req))));
const declarations = asyncHandler(async (req, res) => ok(res, await dd.recordDeclarations(req.user, req.params.id, req.body, ctx(req))));
const draft = asyncHandler(async (req, res) => ok(res, await dd.rejectionDraft(req.user, req.params.id, req.body.reason)));
const decide = asyncHandler(async (req, res) => ok(res, await dd.decide(req.user, req.params.id, req.body, ctx(req))));
const sendAgreement = asyncHandler(async (req, res) => ok(res, await agents.sendAgreement(req.user, req.params.id, req.body, ctx(req))));

const download = asyncHandler(async (req, res) => {
  const f = await dd.openFile(req.user, req.params.fileId, ctx(req));
  res.set({ "Content-Type": f.mime, "Content-Length": f.size, "Content-Disposition": `attachment; filename="${encodeURIComponent(f.name)}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  f.stream.pipe(res);
});

// ---- tasks ----
const taskMeta = asyncHandler(async (req, res) => ok(res, await tasks.meta()));
const taskList = asyncHandler(async (req, res) => {
  const r = await tasks.list(req.user, req.query);
  ok(res, r.rows, { pagination: { total: r.total, page: r.page, limit: r.limit } });
});
const taskCreate = asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await tasks.create(req.user, req.body, ctx(req)) }));
const taskComplete = asyncHandler(async (req, res) => ok(res, await tasks.complete(req.user, req.params.id, req.body, ctx(req))));
const taskAssign = asyncHandler(async (req, res) => ok(res, await tasks.assign(req.user, req.params.id, req.body.owner_id, ctx(req))));
const taskCancel = asyncHandler(async (req, res) => ok(res, await tasks.cancel(req.user, req.params.id, req.body.reason, ctx(req))));
const taskExport = asyncHandler(async (req, res) => sendCsv(res, "tasks", await tasks.exportCsv(req.user, req.query, ctx(req))));
const taskEvidence = asyncHandler(async (req, res) => {
  const f = await tasks.openEvidence(req.user, req.params.id, ctx(req));
  res.set({ "Content-Type": f.mime, "Content-Length": f.size, "Content-Disposition": `attachment; filename="${encodeURIComponent(f.name)}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  f.stream.pipe(res);
});

// ---- the referee's public page ----
const refForm = asyncHandler(async (req, res) => ok(res, await dd.referenceForm(req.params.token)));
const refSubmit = asyncHandler(async (req, res) => ok(res, await dd.submitReference(req.params.token, req.body.answers, ctx(req))));

module.exports = {
  get, addReferee, updateReferee, removeReferee, request, phone, remind, outcome, check, declarations, draft, decide, sendAgreement, download,
  taskMeta, taskList, taskCreate, taskComplete, taskAssign, taskCancel, taskExport, taskEvidence, refForm, refSubmit,
};
