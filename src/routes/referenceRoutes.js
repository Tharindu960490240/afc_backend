// The referee's own page: no sign-in, one single-use link per request.
const router = require("express").Router();
const d = require("../controllers/comsDueDiligenceController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const s = require("../validators/schemas");

router.get("/:token", limits.tokenLookup, validate(s.publicToken, "params"), d.refForm);
router.post("/:token", limits.tokenLookup, validate(s.publicToken, "params"), validate(s.referenceAnswers), d.refSubmit);
module.exports = router;
