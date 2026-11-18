require("dotenv").config();

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : String(v).toLowerCase() === "true");

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: num(process.env.PORT, 3200),
  frontendUrl: (process.env.FRONTEND_URL || "http://localhost:4200").replace(/\/$/, ""),
  corsOrigins: (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || "http://localhost:4200")
    .split(",").map((s) => s.trim()).filter(Boolean),
  trustProxy: num(process.env.TRUST_PROXY, 0),

  db: {
    url: process.env.DATABASE_URL,
    ssl: bool(process.env.DB_SSL, false),
    rejectUnauthorized: bool(process.env.DB_SSL_REJECT_UNAUTHORIZED, true),
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    issuer: "afc-portal",
    audience: "afc-access",
  },
  timezone: process.env.APP_TIMEZONE || "Australia/Melbourne",
  // whose public holidays stop the working-day clock (Tasmania and Victoria, per the COMS spec)
  holidayJurisdictions: (process.env.HOLIDAY_JURISDICTIONS || "TAS,VIC").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 12),
  invitationTtlHours: num(process.env.INVITATION_TTL_HOURS, 168),
  resetTtlMinutes: num(process.env.PASSWORD_RESET_TTL_MINUTES, 60),
  verifyTtlHours: num(process.env.EMAIL_VERIFY_TTL_HOURS, 24),
  uploadDir: process.env.UPLOAD_DIR || "storage",
  evidenceMaxMb: num(process.env.EVIDENCE_MAX_MB, 3),
  inboundEmailSecret: process.env.INBOUND_EMAIL_SECRET, // lets the mail service post received email to /api/inbound/email so it is logged against the agent
  cronSecret: process.env.CRON_SECRET, // lets a hosting scheduler (Vercel Cron) run the daily jobs
  maxFailedLogins: num(process.env.MAX_FAILED_LOGINS, 5),
  lockoutMinutes: num(process.env.LOCKOUT_MINUTES, 15),

  email: {
    mode: process.env.EMAIL_MODE || "console",
    host: process.env.SMTP_HOST,
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.EMAIL_FROM_NAME || "Australian Federation College",
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    support: process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_USER,
    logoUrl: process.env.LOGO_URL,
    brevoKey: process.env.BREVO_API_KEY, // used when EMAIL_MODE=brevo (sends over HTTPS, for hosts that block SMTP)
  },
};

const problems = [];
if (!env.db.url) problems.push("DATABASE_URL is required");
if (!env.jwt.secret || env.jwt.secret.length < 32) problems.push("JWT_SECRET is required and must be at least 32 characters");
if (env.nodeEnv === "production" && !["smtp", "brevo"].includes(env.email.mode)) problems.push("EMAIL_MODE must be 'smtp' or 'brevo' in production");
if (env.email.mode === "brevo" && (!env.email.brevoKey || !env.email.from)) problems.push("BREVO_API_KEY and EMAIL_FROM are required when EMAIL_MODE=brevo");
if (env.email.mode === "smtp" && (!env.email.host || !env.email.user || !env.email.pass)) problems.push("SMTP_HOST, SMTP_USER and SMTP_PASS are required when EMAIL_MODE=smtp");
if (problems.length) {
  console.error("Invalid configuration:\n - " + problems.join("\n - "));
  process.exit(1);
}

module.exports = env;
