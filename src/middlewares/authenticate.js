const AppError = require("../utils/AppError");
const asyncHandler = require("../utils/asyncHandler");
const { verifyAccessToken } = require("../utils/jwt");
const userRepo = require("../repositories/userRepo");

// Requires a valid access token AND a currently active account with a matching token_version.
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw new AppError(401, "Please sign in.");

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new AppError(401, "Your session has expired. Please sign in again.");
  }

  const user = await userRepo.findById(payload.sub);
  if (!user || user.status !== "active" || user.token_version !== payload.tv) {
    throw new AppError(401, "Your session has expired. Please sign in again.");
  }
  req.user = user;
  next();
});

// requireRole("admin") or requireRole("admin","agent")
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : next(new AppError(403, "You do not have permission to do that."));

module.exports = { authenticate, requireRole };
