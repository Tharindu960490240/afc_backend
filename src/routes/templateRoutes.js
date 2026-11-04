const router = require("express").Router();
const ctrl = require("../controllers/templateController");
const validate = require("../middlewares/validate");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.use(authenticate, requireRole("admin"));
router.get("/", ctrl.get);
router.put("/", validate(s.saveTemplate), ctrl.save);
router.post("/preview", validate(s.previewTemplate), ctrl.preview);

module.exports = router;
