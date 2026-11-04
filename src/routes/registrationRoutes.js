const router = require("express").Router();
const ctrl = require("../controllers/registrationController");
const validate = require("../middlewares/validate");
const { authenticate, requireRole } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

// admin only: agents who registered themselves from the website
router.use(authenticate, requireRole("admin"));
router.get("/", validate(s.registrationListQuery, "query"), ctrl.list);
router.get("/counts", ctrl.counts);
router.post("/:id/approve", validate(s.idParam, "params"), ctrl.approve);
router.post("/:id/reject", validate(s.idParam, "params"), validate(s.rejectRegistration), ctrl.reject);

module.exports = router;
