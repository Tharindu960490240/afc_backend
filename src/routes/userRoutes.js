const router = require("express").Router();
const ctrl = require("../controllers/userController");
const exp = require("../controllers/exportController");
const limits = require("../middlewares/rateLimit");
const validate = require("../middlewares/validate");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.patch("/:id/authorised", authenticate, requireRole("admin", "ceo"), validate(s.idParam, "params"), validate(s.userAuthorised), ctrl.setAuthorised);
router.use(authenticate, requireRole("admin"));
router.get("/export", limits.sensitive, validate(s.listQuery, "query"), exp.users);
router.get("/", validate(s.listQuery, "query"), ctrl.list);
router.patch("/:id/status", validate(s.idParam, "params"), validate(s.userStatus), ctrl.setStatus);

module.exports = router;
