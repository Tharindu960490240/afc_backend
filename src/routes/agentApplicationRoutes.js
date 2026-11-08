// The signed-in agent's own application (for agents invited by the college).
const router = require("express").Router();
const ctrl = require("../controllers/agentApplicationController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

router.use(authenticate, requireRole("agent"));
router.get("/", ctrl.show);
router.post("/", limits.sensitive, validate(s.submitApplication), ctrl.submit);
module.exports = router;
