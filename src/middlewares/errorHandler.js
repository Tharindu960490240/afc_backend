const env = require("../config/env");

const notFound = (req, res) => res.status(404).json({ success: false, message: "Not found." });

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ success: false, message: "Invalid JSON." });
  if (err.type === "entity.too.large") return res.status(413).json({ success: false, message: "Request too large." });
  if (err.message === "Not allowed by CORS") return res.status(403).json({ success: false, message: "Origin not allowed." });

  if (err.status && err.expose) {
    const body = { success: false, message: err.message };
    if (err.errors) body.errors = err.errors;
    if (err.blockers) body.blockers = err.blockers;
    return res.status(err.status).json(body);
  }

  console.error("Unhandled error:", env.nodeEnv === "production" ? err.message : err);
  res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
};

module.exports = { notFound, errorHandler };
