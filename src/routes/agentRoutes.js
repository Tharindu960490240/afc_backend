const router = require("express").Router();
const ctrl = require("../controllers/agreementController");
const validate = require("../middlewares/validate");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

// Agent list with each agent's agreement status (admin only)
router.get("/", authenticate, requireRole("admin"), validate(s.agentsQuery, "query"), ctrl.agents);

// Everything about one agent (admin only)
router.get("/:id", authenticate, requireRole("admin"), validate(s.idParam, "params"), ctrl.agentDetail);

module.exports = router;
