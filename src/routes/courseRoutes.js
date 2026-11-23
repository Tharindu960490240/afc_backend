// Course catalogue: everyone signed in can read it; only administrators change it.
const router = require("express").Router();
const ctrl = require("../controllers/courseController");
const validate = require("../middlewares/validate");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.use(authenticate);
router.get("/", ctrl.list);
router.post("/", requireRole("admin"), validate(s.courseBody), ctrl.create);
router.put("/:id", requireRole("admin"), validate(s.idParam, "params"), validate(s.courseBody), ctrl.update);

module.exports = router;
