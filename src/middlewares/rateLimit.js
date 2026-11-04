const rateLimit = require("express-rate-limit");
const env = require("../config/env");

const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => env.nodeEnv === "test", // automated tests only; never active in dev/production
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const MIN = 60 * 1000;
module.exports = {
  global: make(15 * MIN, 600, "Too many requests. Please try again later."),
  login: make(15 * MIN, 20, "Too many sign-in attempts. Please try again in a few minutes."),
  forgotPassword: make(60 * MIN, 6, "Too many reset requests. Please try again later."),
  tokenLookup: make(15 * MIN, 60, "Too many attempts. Please try again later."),
  register: make(60 * MIN, 8, "Too many registration attempts. Please try again later."),
  sensitive: make(15 * MIN, 30, "Too many attempts. Please try again later."),
};
