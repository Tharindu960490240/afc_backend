const router = require("express").Router();
const agents = require("../controllers/comsAgentController");
const d = require("../controllers/comsDueDiligenceController");
const misc = require("../controllers/comsMiscController");
const docsCtrl = require("../controllers/comsDocumentsController");
const exp = require("../controllers/exportController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");
const { STAFF_ROLES } = require("../const");

router.use(authenticate, requireRole(...STAFF_ROLES)); // every COMS screen is for college staff; each action checks its own permission

// ---- agent register ----
router.get("/agents/meta", agents.meta);
router.get("/agents/export", limits.sensitive, validate(s.comsAgentsQuery, "query"), agents.exportCsv);
router.get("/agents", validate(s.comsAgentsQuery, "query"), agents.list);
router.post("/agents", limits.sensitive, validate(s.createAgentEoi), agents.create);
router.get("/agents/:id", validate(s.uuidParam, "params"), agents.detail);
router.patch("/agents/:id", validate(s.uuidParam, "params"), validate(s.updateAgent), agents.update);
router.post("/agents/:id/status", validate(s.uuidParam, "params"), validate(s.agentStatusChange), agents.status);
router.post("/agents/:id/application-link", limits.sensitive, validate(s.uuidParam, "params"), agents.sendLink);
router.post("/agents/:id/milestones", validate(s.uuidParam, "params"), validate(s.milestone), agents.milestone);
router.post("/agents/:id/delete", validate(s.uuidParam, "params"), validate(s.agentDelete), agents.remove);
router.post("/agents/:id/restore", validate(s.uuidParam, "params"), agents.restore);
router.post("/agents/:id/persons", validate(s.uuidParam, "params"), validate(s.createPerson), agents.addPerson);
router.patch("/agents/:id/persons/:personId", validate(s.personParams, "params"), validate(s.updatePerson), agents.updatePerson);
router.post("/agents/:id/persons/:personId/delete", validate(s.personParams, "params"), validate(s.agentDelete), agents.removePerson);

// ---- Part 2: due diligence, referees, decision, agreement ----
const idp = validate(s.uuidParam, "params");
router.get("/agents/:id/due-diligence", idp, d.get);
router.post("/agents/:id/referees", idp, validate(s.createReferee), d.addReferee);
router.patch("/agents/:id/referees/:refereeId", validate(s.refereeParams, "params"), validate(s.updateReferee), d.updateReferee);
router.post("/agents/:id/referees/:refereeId/delete", validate(s.refereeParams, "params"), validate(s.agentDelete), d.removeReferee);
router.post("/agents/:id/referees/:refereeId/request", limits.sensitive, validate(s.refereeParams, "params"), d.request);
router.post("/agents/:id/referees/:refereeId/phone-check", validate(s.refereeParams, "params"), validate(s.phoneCheck), d.phone);
router.post("/agents/:id/reference-checks/:checkId/remind", limits.sensitive, validate(s.checkParams, "params"), d.remind);
router.post("/agents/:id/reference-checks/:checkId/outcome", validate(s.checkParams, "params"), validate(s.referenceOutcome), d.outcome);
router.post("/agents/:id/due-diligence/checks", idp, validate(s.dueDiligenceCheck), d.check);
router.post("/agents/:id/due-diligence/declarations", idp, validate(s.declarations), d.declarations);
router.post("/agents/:id/rejection-draft", idp, validate(s.agentDelete), d.draft);
router.post("/agents/:id/decision", limits.sensitive, idp, validate(s.decision), d.decide);
router.post("/agents/:id/agreement", limits.sensitive, idp, validate(s.sendAgentAgreement), d.sendAgreement);
// ---- Part 2b: the agent folder, requests for information, commission and bonus ----
router.get("/agents/:id/documents", idp, docsCtrl.list);
router.post("/agents/:id/documents", limits.sensitive, idp, validate(s.agentDocument), docsCtrl.upload);
router.post("/agents/:id/documents/:docId/review", validate(s.documentParams, "params"), validate(s.documentReview), docsCtrl.review);
router.post("/agents/:id/documents/:docId/delete", validate(s.documentParams, "params"), validate(s.agentDelete), docsCtrl.remove);
router.get("/agents/:id/documents/:docId/download", limits.sensitive, validate(s.documentParams, "params"), docsCtrl.download);
router.post("/agents/:id/request-information", limits.sensitive, idp, validate(s.infoRequest), docsCtrl.requestInfo);
router.get("/agents/:id/application.pdf", limits.sensitive, idp, docsCtrl.applicationPdf);
router.post("/agents/:id/terms", idp, validate(s.agentTerms), docsCtrl.terms);
router.get("/files/:fileId/download", limits.sensitive, validate(s.fileParams, "params"), d.download);

// ---- Part 2: task engine and regulatory task board ----
router.get("/tasks/meta", d.taskMeta);
router.get("/tasks/export", limits.sensitive, validate(s.tasksQuery, "query"), d.taskExport);
router.get("/tasks", validate(s.tasksQuery, "query"), d.taskList);
router.post("/tasks", validate(s.taskCreate), d.taskCreate);
router.post("/tasks/:id/complete", limits.sensitive, idp, validate(s.taskComplete), d.taskComplete);
router.post("/tasks/:id/assign", idp, validate(s.taskAssign), d.taskAssign);
router.post("/tasks/:id/cancel", idp, validate(s.cancelTask), d.taskCancel);
router.get("/tasks/:id/evidence", limits.sensitive, idp, d.taskEvidence);

// ---- public-holiday calendar ----
router.get("/holidays/export", limits.sensitive, exp.holidays);
router.get("/holidays", misc.holidays);
router.post("/holidays", requireRole("admin"), validate(s.holidayBody), misc.addHoliday);
router.delete("/holidays/:id", requireRole("admin"), validate(s.idParam, "params"), misc.removeHoliday);

// ---- audit viewer: Compliance, CEO and administrators ----
router.get("/audit/export", requireRole("admin", "compliance", "ceo"), limits.sensitive, validate(s.auditQuery, "query"), exp.auditLog);
router.get("/audit", requireRole("admin", "compliance", "ceo"), validate(s.auditQuery, "query"), misc.auditList);

module.exports = router;
