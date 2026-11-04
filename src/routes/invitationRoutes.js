const router = require("express").Router();
const { z } = require("zod");
const ctrl = require("../controllers/invitationController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

const tokenParam = z.object({ token: s.token });

// public: the sign-up page (the token is the credential)
router.get("/:token", limits.tokenLookup, validate(tokenParam, "params"), ctrl.getPublic);
router.post("/:token/accept", limits.sensitive, validate(tokenParam, "params"), ctrl.accept);

// staff: admins manage everything, agents manage only their own student invitations
router.use(authenticate, requireRole("admin", "agent"));
router.get("/", validate(s.listQuery, "query"), ctrl.list);
router.post("/", validate(s.createInvitation), ctrl.create);
router.post("/:id/resend", validate(s.idParam, "params"), ctrl.resend);
router.delete("/:id", validate(s.idParam, "params"), ctrl.revoke);

module.exports = router;
