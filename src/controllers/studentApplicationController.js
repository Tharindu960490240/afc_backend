const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/studentApplicationService");
const review = require("../services/studentReviewService");
const letters = require("../services/studentLetterService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const send = (res, f) => {
  res.set({ "Content-Type": f.mime, "Content-Length": f.size, "Content-Disposition": `attachment; filename="${encodeURIComponent(f.name)}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  f.stream.pipe(res);
};

const config = asyncHandler(async (req, res) => ok(res, await svc.formConfig(req.user)));
const listMine = asyncHandler(async (req, res) => ok(res, await svc.listMine(req.user)));
const create = asyncHandler(async (req, res) => ok(res, await svc.createDraft(req.user, clientInfo(req)), 201));
const getMine = asyncHandler(async (req, res) => ok(res, await svc.getMine(req.user, req.params.id)));
const save = asyncHandler(async (req, res) => ok(res, await svc.saveDraft(req.user, req.params.id, req.body, clientInfo(req))));
const discard = asyncHandler(async (req, res) => ok(res, await svc.discard(req.user, req.params.id, clientInfo(req))));
const addDoc = asyncHandler(async (req, res) => ok(res, await svc.addDocument(req.user, req.params.id, req.body, clientInfo(req)), 201));
const removeDoc = asyncHandler(async (req, res) => ok(res, await svc.removeDocument(req.user, req.params.id, req.params.docId, clientInfo(req))));
const docDownload = asyncHandler(async (req, res) => send(res, await svc.openDocument(req.user, req.params.id, req.params.docId, clientInfo(req))));
const submit = asyncHandler(async (req, res) => ok(res, await svc.submit(req.user, req.params.id, clientInfo(req))));
const formDownload = asyncHandler(async (req, res) => send(res, await svc.openForm(req.user, req.params.formId, clientInfo(req))));

const adminGet = asyncHandler(async (req, res) => ok(res, await svc.adminGet(req.user)));
const adminSettings = asyncHandler(async (req, res) => ok(res, await svc.adminSaveSettings(req.user, req.body, clientInfo(req))));
const adminDocTypes = asyncHandler(async (req, res) => ok(res, await svc.adminSaveDocTypes(req.user, req.body, clientInfo(req))));
const adminUploadForm = asyncHandler(async (req, res) => ok(res, await svc.adminUploadForm(req.user, req.body, clientInfo(req)), 201));
const adminToggleForm = asyncHandler(async (req, res) => ok(res, await svc.adminToggleForm(req.user, req.params.formId, req.body, clientInfo(req))));

// staff
const queue = asyncHandler(async (req, res) => ok(res, await review.queue(req.user, req.query)));
const detail = asyncHandler(async (req, res) => ok(res, await review.detail(req.user, req.params.id)));
const startReview = asyncHandler(async (req, res) => ok(res, await review.startReview(req.user, req.params.id, clientInfo(req))));
const reviewDoc = asyncHandler(async (req, res) => ok(res, await review.reviewDocument(req.user, req.params.id, req.params.docId, req.body, clientInfo(req))));
const requestInfo = asyncHandler(async (req, res) => ok(res, await review.requestInfo(req.user, req.params.id, req.body, clientInfo(req))));
const decide = asyncHandler(async (req, res) => ok(res, await review.decide(req.user, req.params.id, req.body, clientInfo(req))));
const withdraw = asyncHandler(async (req, res) => ok(res, await review.withdraw(req.user, req.params.id, req.body, clientInfo(req))));

// after the decision: letter, payment, CoE, VoE (each returns the refreshed detail)
const then = (fn) => asyncHandler(async (req, res) => { await fn(req); ok(res, await review.detail(req.user, req.params.id)); });
const prepareLetter = then((req) => letters.prepareLetter(req.user, req.params.id, clientInfo(req)));
const saveLetter = then((req) => letters.saveLetter(req.user, req.params.id, req.body, clientInfo(req)));
const issueLetter = then((req) => letters.issueLetter(req.user, req.params.id, clientInfo(req)));
const reviseLetter = then((req) => letters.reviseLetter(req.user, req.params.id, clientInfo(req)));
const confirmPayment = then((req) => letters.confirmPayment(req.user, req.params.id, req.body, clientInfo(req)));
const recordCoe = then((req) => letters.recordCoe(req.user, req.params.id, req.body, clientInfo(req)));
const issueVoe = then((req) => letters.issueVoe(req.user, req.params.id, clientInfo(req)));
const outputDownload = asyncHandler(async (req, res) => send(res, await letters.openOutput(req.user, req.params.id, req.params.kind, clientInfo(req))));

module.exports = {
  prepareLetter, saveLetter, issueLetter, reviseLetter, confirmPayment, recordCoe, issueVoe, outputDownload,
  queue, detail, startReview, reviewDoc, requestInfo, decide, withdraw, config, listMine, create, getMine, save, discard, addDoc, removeDoc, docDownload, submit, formDownload, adminGet, adminSettings, adminDocTypes, adminUploadForm, adminToggleForm };
