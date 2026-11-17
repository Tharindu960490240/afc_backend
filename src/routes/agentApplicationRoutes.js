// The signed-in agent's own application (for agents invited by the college).
const router = require("express").Router();
const ctrl = require("../controllers/agentApplicationController");
const docs = require("../controllers/comsDocumentsController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.use(authenticate, requireRole("agent"));
router.get("/", ctrl.show);
router.post("/", limits.sensitive, validate(s.submitApplication), ctrl.submit);
router.get("/documents", docs.mine);
router.post("/documents", limits.sensitive, validate(s.agentDocument), docs.mineUpload);
router.post("/documents/:docId/delete", validate(s.documentParams.omit({ id: true }), "params"), docs.mineRemove);
router.get("/documents/:docId/download", limits.sensitive, validate(s.documentParams.omit({ id: true }), "params"), docs.mineDownload);
module.exports = router;
