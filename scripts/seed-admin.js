// Creates the first administrator from ADMIN_* variables. Safe to run again (skips if the email exists).
require("dotenv").config();
const { pool, withTransaction } = require("../src/config/db");
const { hashPassword } = require("../src/utils/password");
const { PASSWORD_REGEX } = require("../src/const");
const userRepo = require("../src/repositories/userRepo");
const audit = require("../src/repositories/auditRepo");

async function main() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const first = (process.env.ADMIN_FIRST_NAME || "").trim();
  const last = (process.env.ADMIN_LAST_NAME || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!email || !first || !last) throw new Error("Set ADMIN_EMAIL, ADMIN_FIRST_NAME, ADMIN_LAST_NAME and ADMIN_PASSWORD in .env");
  if (!PASSWORD_REGEX.test(password)) throw new Error("ADMIN_PASSWORD must be 8-72 chars with upper, lower, number and one of @$!%*?&");

  if (await userRepo.emailExists(email)) {
    console.log(`Admin ${email} already exists, nothing to do.`);
    return;
  }
  const passwordHash = await hashPassword(password);
  const user = await withTransaction(async (client) => {
    const u = await userRepo.create(client, { email, passwordHash, firstName: first, lastName: last, role: "admin", consentAt: new Date() });
    await audit.log({ actorId: u.id, action: "admin.seeded", entityType: "user", entityId: u.id }, client);
    return u;
  });
  console.log(`Created admin ${user.email}. Remove ADMIN_PASSWORD from .env now and change the password after first sign-in.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
