const jwt = require("jsonwebtoken");
const env = require("../config/env");

const signAccessToken = (user) =>
  jwt.sign({ role: user.role, tv: user.token_version }, env.jwt.secret, {
    algorithm: "HS256",
    subject: String(user.id),
    expiresIn: env.jwt.expiresIn,
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
  });

const verifyAccessToken = (token) =>
  jwt.verify(token, env.jwt.secret, {
    algorithms: ["HS256"],
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
  });

module.exports = { signAccessToken, verifyAccessToken };
