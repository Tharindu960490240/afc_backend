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

// ---- Phase 3: online induction content, policies and marketing materials ----
const oi = require("../controllers/onlineInductionController");
router.get("/induction/modules", oi.modules);
router.patch("/induction/modules/:id", validate(s.idOnly, "params"), validate(s.inductionModuleBody), oi.updateModule);
router.get("/induction/policies", oi.policies);
router.post("/induction/policies", validate(s.policyBody), oi.publishPolicy);
router.get("/induction/materials", oi.materials);
router.post("/induction/materials", limits.sensitive, validate(s.materialBody), oi.createMaterial);
router.post("/induction/materials/:id/approve", validate(s.idOnly, "params"), oi.approveMaterial);
router.post("/induction/materials/:id/retire", validate(s.idOnly, "params"), oi.retireMaterial);
router.get("/induction/materials/:id/download", limits.sensitive, validate(s.idOnly, "params"), oi.materialDownload);
router.get("/agents/:id/online-induction", validate(s.uuidParam, "params"), oi.status);

// ---- Phase 3: induction ----
router.get("/agents/:id/inductions", validate(s.uuidParam, "params"), agents.inductions);
router.post("/agents/:id/inductions", validate(s.uuidParam, "params"), validate(s.inductionBody), agents.recordInduction);
router.post("/agents/:id/inductions/:inductionId/complete", validate(s.inductionParams, "params"), validate(s.inductionComplete), agents.completeInduction);
router.post("/agents/:id/inductions/:inductionId/reschedule", validate(s.inductionParams, "params"), validate(s.inductionReschedule), agents.rescheduleInduction);
router.post("/agents/:id/inductions/:inductionId/cancel", validate(s.inductionParams, "params"), validate(s.agentDelete), agents.cancelInduction);

router.patch("/agents/:id/inductions/:inductionId", validate(s.inductionParams, "params"), validate(s.inductionEdit), agents.editInduction);
router.post("/agents/:id/inductions/:inductionId/undo", validate(s.inductionParams, "params"), validate(s.agentDelete), agents.undoInduction);
router.post("/agents/:id/inductions/:inductionId/missed", validate(s.inductionParams, "params"), validate(s.agentDelete), agents.missedInduction);

// ---- Phase 4: agent CRM ----
const crm = require("../controllers/crmController");
const ids = validate(s.uuidParam, "params");
router.get("/agents/:id/communications", ids, crm.comms);
router.post("/agents/:id/communications", ids, validate(s.commBody), crm.logComm);
router.patch("/agents/:id/communications/:commId", validate(s.commParams, "params"), validate(s.commBody), crm.editComm);
router.get("/agents/:id/leads", ids, crm.leads);
router.get("/agents/:id/training", ids, crm.training);
router.post("/agents/:id/training", ids, validate(s.trainingBody), crm.addTraining);
router.get("/agents/:id/monitoring", ids, crm.monitoring);
router.post("/agents/:id/monitoring", ids, validate(s.monitoringBody), crm.createReview);
router.post("/agents/:id/corrective-actions", ids, validate(s.correctiveBody), crm.createCorrective);
router.patch("/agents/:id/corrective-actions/:actionId", validate(s.correctiveParams, "params"), validate(s.correctiveBody), crm.updateCorrective);
router.post("/agents/:id/corrective-actions/:actionId/redraft", validate(s.correctiveParams, "params"), crm.redraftCorrective);
router.post("/agents/:id/corrective-actions/:actionId/send", validate(s.correctiveParams, "params"), crm.sendCorrective);
router.post("/agents/:id/corrective-actions/:actionId/implemented", validate(s.correctiveParams, "params"), validate(s.correctiveResolve), crm.implemented);
router.post("/agents/:id/corrective-actions/:actionId/not-implemented", validate(s.correctiveParams, "params"), validate(s.correctiveResolve), crm.notImplemented);
router.post("/agents/:id/corrective-actions/:actionId/cancel", validate(s.correctiveParams, "params"), validate(s.agentDelete), crm.cancelCorrective);
router.get("/broadcasts", crm.broadcasts);
router.post("/broadcasts", validate(s.broadcastBody), crm.createBroadcast);
router.get("/broadcasts/:id", validate(s.idOnly, "params"), crm.broadcast);
router.patch("/broadcasts/:id", validate(s.idOnly, "params"), validate(s.broadcastBody), crm.updateBroadcast);
router.post("/broadcasts/:id/approve", validate(s.idOnly, "params"), crm.approveBroadcast);
router.post("/broadcasts/:id/cancel", validate(s.idOnly, "params"), crm.cancelBroadcast);

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
router.get("/agents/:id/certificate", idp, limits.sensitive, docsCtrl.certificate);
router.post("/agents/:id/certificate/send", idp, limits.sensitive, docsCtrl.certificateSend);
router.get("/agents/:id/documents/:docId/download", limits.sensitive, validate(s.documentParams, "params"), docsCtrl.download);
router.post("/agents/:id/request-information", limits.sensitive, idp, validate(s.infoRequest), docsCtrl.requestInfo);
router.get("/agents/:id/application.pdf", limits.sensitive, idp, docsCtrl.applicationPdf);
router.post("/agents/:id/terms", idp, validate(s.agentTerms), docsCtrl.terms);
router.get("/agents/:id/terms/draft", idp, docsCtrl.termsDraft);
router.post("/agents/:id/terms/send", idp, validate(s.agentTermsSend), docsCtrl.termsSend);
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
