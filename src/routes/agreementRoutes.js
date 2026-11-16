const router = require("express").Router();
const ctrl = require("../controllers/agreementController");
const exp = require("../controllers/exportController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.use(authenticate);

// admin and agent (agents only ever see their own)
router.get("/", validate(s.agreementListQuery, "query"), ctrl.list);
router.get("/export", requireRole("admin"), limits.sensitive, validate(s.agreementListQuery, "query"), exp.agreements);
router.get("/:id", validate(s.idParam, "params"), ctrl.get);
router.get("/:id/pdf", limits.sensitive, validate(s.idParam, "params"), ctrl.pdf);
router.get("/:id/files/:fileId/download", limits.sensitive, validate(s.agreementFileParams, "params"), ctrl.download);

// agent signs in the portal
router.post("/:id/sign", requireRole("agent"), limits.sensitive, validate(s.idParam, "params"), validate(s.signAgreement), ctrl.sign);

// admin only to send from this list (staff send from the agent record); the CEO countersigns
router.post("/", requireRole("admin"), limits.sensitive, validate(s.sendAgreement), ctrl.send);
router.post("/:id/approve", requireRole("admin", "ceo"), limits.sensitive, validate(s.idParam, "params"), validate(s.approveAgreement), ctrl.approve);
router.post("/:id/reject", requireRole("admin", "ceo"), validate(s.idParam, "params"), validate(s.rejectAgreement), ctrl.reject);
router.post("/:id/cancel", requireRole("admin", "ceo", "director"), validate(s.idParam, "params"), validate(s.cancelAgreement), ctrl.cancel);

module.exports = router;
