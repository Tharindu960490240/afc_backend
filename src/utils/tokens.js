const crypto = require("crypto");

// Random URL-safe token (sent to the user) and its SHA-256 (stored in the DB).
const generateToken = () => crypto.randomBytes(32).toString("hex");
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

module.exports = { generateToken, hashToken };
