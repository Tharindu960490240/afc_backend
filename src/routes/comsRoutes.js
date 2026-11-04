const router = require("express").Router();
const agents = require("../controllers/comsAgentController");
const misc = require("../controllers/comsMiscController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");
const { STAFF_ROLES } = require("../const");

router.use(authenticate, requireRole(...STAFF_ROLES)); // every COMS screen is for college staff; each action checks its own permission

// ---- agent register ----
router.get("/agents/meta", agents.meta);
router.get("/agents/export", limits.sensitive, validate(s.comsAgentsQuery, "query"), agents.exportCsv);
router.get("/agents", validate(s.comsAgentsQuery, "query"), agents.list);
router.post("/agents", limits.sensitive, validate(s.createAgentEoi), agents.create);
router.get("/agents/:id", validate(s.uuidParam, "params"), agents.detail);
router.patch("/agents/:id", validate(s.uuidParam, "params"), validate(s.updateAgent), agents.update);
router.post("/agents/:id/status", validate(s.uuidParam, "params"), validate(s.agentStatusChange), agents.status);
router.post("/agents/:id/application-link", limits.sensitive, validate(s.uuidParam, "params"), agents.sendLink);
router.post("/agents/:id/milestones", validate(s.uuidParam, "params"), validate(s.milestone), agents.milestone);
router.post("/agents/:id/delete", validate(s.uuidParam, "params"), validate(s.agentDelete), agents.remove);
router.post("/agents/:id/restore", validate(s.uuidParam, "params"), agents.restore);
router.post("/agents/:id/persons", validate(s.uuidParam, "params"), validate(s.createPerson), agents.addPerson);
router.patch("/agents/:id/persons/:personId", validate(s.personParams, "params"), validate(s.updatePerson), agents.updatePerson);
router.post("/agents/:id/persons/:personId/delete", validate(s.personParams, "params"), validate(s.agentDelete), agents.removePerson);

// ---- public-holiday calendar ----
router.get("/holidays", misc.holidays);
router.post("/holidays", requireRole("admin"), validate(s.holidayBody), misc.addHoliday);
router.delete("/holidays/:id", requireRole("admin"), validate(s.idParam, "params"), misc.removeHoliday);

// ---- audit viewer: Compliance, CEO and administrators ----
router.get("/audit", requireRole("admin", "compliance", "ceo"), validate(s.auditQuery, "query"), misc.auditList);

module.exports = router;
