// Settings screen: administrators only.
const router = require("express").Router();
const ctrl = require("../controllers/settingsController");
const validate = require("../middlewares/validate");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/settingsSchemas");

router.use(authenticate, requireRole("admin"));
router.get("/", ctrl.get);
router.put("/reference-questions", validate(s.saveQuestions), ctrl.questions);
router.put("/document-types", validate(s.saveDocTypes), ctrl.documents);
router.put("/timers", validate(s.saveTimers), ctrl.timers);
router.put("/college", validate(s.saveCollege), ctrl.college);
router.put("/signature", validate(s.saveSignature), ctrl.signature);
router.post("/signature/remove", ctrl.signatureRemove);
router.put("/onboarding-tasks", validate(s.saveTasks), ctrl.tasks);

module.exports = router;
