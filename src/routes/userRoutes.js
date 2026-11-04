const router = require("express").Router();
const ctrl = require("../controllers/userController");
const validate = require("../middlewares/validate");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.use(authenticate, requireRole("admin"));
router.get("/", validate(s.listQuery, "query"), ctrl.list);
router.patch("/:id/status", validate(s.idParam, "params"), validate(s.userStatus), ctrl.setStatus);

module.exports = router;
