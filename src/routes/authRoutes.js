const router = require("express").Router();
const ctrl = require("../controllers/authController");
const validate = require("../middlewares/validate");
const limits = require("../middlewares/rateLimit");
const { authenticate } = require("../middlewares/authenticate");
const s = require("../validators/schemas");

// public
router.post("/login", limits.login, validate(s.login), ctrl.login);
router.post("/forgot-password", limits.forgotPassword, validate(s.forgotPassword), ctrl.forgotPassword);
router.post("/reset-password/validate", limits.tokenLookup, validate(s.resetPassword.pick({ token: true })), ctrl.validateResetToken);
router.post("/reset-password", limits.sensitive, validate(s.resetPassword), ctrl.resetPassword);

// agents registering from the college website
router.post("/register-agent", limits.register, validate(s.registerAgent), ctrl.registerAgent);
router.post("/verify-agent", limits.tokenLookup, validate(s.verifyAgent), ctrl.verifyAgent);

// signed-in
router.get("/me", authenticate, ctrl.me);
router.get("/me/profile", authenticate, ctrl.myProfile);
router.put("/me", authenticate, validate(s.updateProfile), ctrl.updateMe);
router.put("/me/password", authenticate, limits.sensitive, validate(s.changePassword), ctrl.changePassword);

module.exports = router;
