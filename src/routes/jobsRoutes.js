// Lets a hosting scheduler (for example Vercel Cron) run the daily jobs, because serverless functions cannot keep a timer.
// Protected by CRON_SECRET: the scheduler sends "Authorization: Bearer <CRON_SECRET>".
const router = require("express").Router();
const crypto = require("crypto");
const env = require("../config/env");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

router.get("/daily", asyncHandler(async (req, res) => {
  const [scheme, token] = (req.get("authorization") || "").split(" ");
  if (!env.cronSecret || scheme !== "Bearer" || !token || !same(token, env.cronSecret)) throw new AppError(401, "Not allowed.");
  const reminders = await require("../jobs/agreementReminders").run();
  const coms = await require("../jobs/comsDaily").run();
  res.json({ success: true, reminders, coms });
}));
module.exports = router;
