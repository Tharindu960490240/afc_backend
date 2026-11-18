const router = require("express").Router();
router.get("/health", (req, res) => res.json({ success: true, status: "ok" }));
router.use("/auth", require("./authRoutes"));
router.use("/invitations", require("./invitationRoutes"));
router.use("/users", require("./userRoutes"));
router.use("/agents", require("./agentRoutes"));
router.use("/registrations", require("./registrationRoutes"));
router.use("/agreement-template", require("./templateRoutes"));
router.use("/agreements", require("./agreementRoutes"));
router.use("/agent-application", require("./agentApplicationRoutes"));
router.use("/coms", require("./comsRoutes"));
router.use("/reference", require("./referenceRoutes"));
router.use("/settings", require("./settingsRoutes"));
router.use("/jobs", require("./jobsRoutes"));
// received email, posted by the mail service with a shared secret (INBOUND_EMAIL_SECRET), is logged against the agent
router.post("/inbound/email", require("../middlewares/rateLimit").sensitive, require("../middlewares/validate")(require("../validators/schemas").inboundEmail), require("../controllers/crmController").inboundEmail);
module.exports = router;
