// Student applications. Agents work on their own; administrators set the wording and the document list.
const router = require("express").Router();
const ctrl = require("../controllers/studentApplicationController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const v = require("../validators/studentApplication");
const { STAFF_ROLES } = require("../const");

router.use(authenticate);

// administrators
router.get("/settings", requireRole("admin"), ctrl.adminGet);
router.put("/settings", requireRole("admin"), validate(v.settingsBody), ctrl.adminSettings);
router.put("/settings/document-types", requireRole("admin"), validate(v.docTypesBody), ctrl.adminDocTypes);
router.post("/settings/forms", requireRole("admin"), limits.sensitive, validate(v.formUploadBody), ctrl.adminUploadForm);
router.post("/settings/forms/:formId", requireRole("admin"), validate(v.formParams, "params"), validate(v.formToggleBody), ctrl.adminToggleForm);

// a downloadable form (agents and staff)
router.get("/forms/:formId/download", limits.sensitive, validate(v.formParams, "params"), ctrl.formDownload);

// staff (every staff role can read; the controller checks who may assess)
const staff = requireRole(...STAFF_ROLES);
router.get("/staff", staff, validate(v.reviewQuery, "query"), ctrl.queue);
router.get("/staff/:id", staff, validate(v.idParam, "params"), ctrl.detail);
router.post("/staff/:id/start-review", staff, validate(v.idParam, "params"), ctrl.startReview);
router.post("/staff/:id/documents/:docId/review", staff, validate(v.docParams, "params"), validate(v.docReviewBody), ctrl.reviewDoc);
router.post("/staff/:id/request-info", staff, validate(v.idParam, "params"), validate(v.infoBody), ctrl.requestInfo);
router.post("/staff/:id/decision", staff, validate(v.idParam, "params"), validate(v.decisionBody), ctrl.decide);
router.post("/staff/:id/withdraw", staff, validate(v.idParam, "params"), validate(v.withdrawBody), ctrl.withdraw);

router.post("/staff/:id/letter", staff, validate(v.idParam, "params"), ctrl.prepareLetter);
router.put("/staff/:id/letter", staff, validate(v.idParam, "params"), validate(v.letterBody), ctrl.saveLetter);
router.post("/staff/:id/letter/issue", staff, limits.sensitive, validate(v.idParam, "params"), ctrl.issueLetter);
router.post("/staff/:id/letter/revise", staff, validate(v.idParam, "params"), ctrl.reviseLetter);
router.post("/staff/:id/payment", staff, validate(v.idParam, "params"), validate(v.paymentBody), ctrl.confirmPayment);
router.post("/staff/:id/coe", staff, limits.sensitive, validate(v.idParam, "params"), validate(v.coeBody), ctrl.recordCoe);
router.post("/staff/:id/voe", staff, limits.sensitive, validate(v.idParam, "params"), ctrl.issueVoe);
router.get("/:id/files/:kind", limits.sensitive, validate(v.fileKind, "params"), ctrl.outputDownload);

// agents
router.get("/config", requireRole("agent"), ctrl.config);
router.get("/", requireRole("agent"), ctrl.listMine);
router.post("/", requireRole("agent"), ctrl.create);
router.get("/:id", requireRole("agent"), validate(v.idParam, "params"), ctrl.getMine);
router.put("/:id", requireRole("agent"), validate(v.idParam, "params"), validate(v.draftSchema), ctrl.save);
router.post("/:id/discard", requireRole("agent"), validate(v.idParam, "params"), ctrl.discard);
router.post("/:id/documents", requireRole("agent"), limits.sensitive, validate(v.idParam, "params"), validate(v.docBody), ctrl.addDoc);
router.post("/:id/documents/:docId/delete", requireRole("agent"), validate(v.docParams, "params"), ctrl.removeDoc);
router.get("/:id/documents/:docId/download", limits.sensitive, validate(v.docParams, "params"), ctrl.docDownload);
router.post("/:id/submit", requireRole("agent"), limits.sensitive, validate(v.idParam, "params"), ctrl.submit);

module.exports = router;
