const router = require("express").Router();
const ctrl = require("../controllers/agreementController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.use(authenticate);

// admin and agent (agents only ever see their own)
router.get("/", validate(s.agreementListQuery, "query"), ctrl.list);
router.get("/:id", validate(s.idParam, "params"), ctrl.get);
router.get("/:id/pdf", limits.sensitive, validate(s.idParam, "params"), ctrl.pdf);
router.get("/:id/files/:fileId/download", limits.sensitive, validate(s.agreementFileParams, "params"), ctrl.download);

// agent signs in the portal
router.post("/:id/sign", requireRole("agent"), limits.sensitive, validate(s.idParam, "params"), validate(s.signAgreement), ctrl.sign);

// admin only
router.post("/", requireRole("admin"), limits.sensitive, validate(s.sendAgreement), ctrl.send);
router.post("/:id/approve", requireRole("admin"), limits.sensitive, validate(s.idParam, "params"), validate(s.approveAgreement), ctrl.approve);
router.post("/:id/reject", requireRole("admin"), validate(s.idParam, "params"), validate(s.rejectAgreement), ctrl.reject);
router.post("/:id/cancel", requireRole("admin"), validate(s.idParam, "params"), validate(s.cancelAgreement), ctrl.cancel);

module.exports = router;
