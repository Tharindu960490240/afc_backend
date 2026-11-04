// Small helpers for building audit context from an Express request.
const clientInfo = (req) => ({
  ip: req.ip,
  userAgent: (req.get("user-agent") || "").slice(0, 300),
});
const normalizeEmail = (email) => String(email).trim().toLowerCase();
module.exports = { clientInfo, normalizeEmail };
