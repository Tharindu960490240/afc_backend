// Integration test: needs a migrated, empty-ish database (DATABASE_URL in .env, NODE_ENV=test).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/config/db");
const app = require("../src/app");
const { outbox } = require("../src/services/emailService");
const { hashPassword } = require("../src/utils/password");
const { hashToken } = require("../src/utils/tokens");

let server, base;
const ADMIN = { email: "admin@afc.test", password: "Adm1n@pass" };

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const lastLink = (re) => {
  const m = [...outbox].reverse().map((e) => e.text.match(re)).find(Boolean);
  return m && m[1];
};
const signIn = async (email, password) => (await call("POST", "/api/auth/login", { body: { email, password } }));

before(async () => {
  await pool.query("TRUNCATE audit_logs, password_resets, invitations, student_profiles, agent_profiles, users RESTART IDENTITY CASCADE");
  await pool.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES ($1,$2,'Ada','Admin','admin')`,
    [ADMIN.email, await hashPassword(ADMIN.password)],
  );
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

let adminToken, agentToken;

test("login: wrong password and unknown email look identical", async () => {
  const a = await signIn(ADMIN.email, "Wrong@pass1");
  const b = await signIn("nobody@afc.test", "Wrong@pass1");
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.message, b.body.message);
});

test("login: success returns {success,data:{token}} and never the hash", async () => {
  const r = await signIn("ADMIN@afc.test", ADMIN.password); // case-insensitive
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token);
  assert.equal(JSON.stringify(r.body).includes("password"), false);
  adminToken = r.body.data.token;
  const me = await call("GET", "/api/auth/me", { token: adminToken });
  assert.equal(me.body.user.role, "admin");
  assert.equal(me.body.user.password_hash, undefined);
});

test("protected routes reject missing / forged tokens", async () => {
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
  assert.equal((await call("GET", "/api/users", { token: "abc.def.ghi" })).status, 401);
});

test("lockout after repeated failures", async () => {
  await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ('lock@afc.test',$1,'L','K','teacher')", [await hashPassword("Lock@pass1")]);
  for (let i = 0; i < 3; i++) assert.equal((await signIn("lock@afc.test", "Bad@pass11")).status, 401);
  const locked = await signIn("lock@afc.test", "Lock@pass1"); // correct password, still locked
  assert.equal(locked.status, 429);
});

test("invite: only staff can invite, agents only invite students", async () => {
  const noAuth = await call("POST", "/api/invitations", { body: { email: "x@a.com", role: "agent" } });
  assert.equal(noAuth.status, 401);
  const bad = await call("POST", "/api/invitations", { token: adminToken, body: { email: "bad", role: "agent" } });
  assert.equal(bad.status, 400);
  const badRole = await call("POST", "/api/invitations", { token: adminToken, body: { email: "x@a.com", role: "superuser" } });
  assert.equal(badRole.status, 400);
});

test("invite -> validate -> accept (agent)", async () => {
  const inv = await call("POST", "/api/invitations", { token: adminToken, body: { email: "Agent@Agency.com", role: "agent", first_name: "Sam" } });
  assert.equal(inv.status, 201);
  assert.equal(JSON.stringify(inv.body).includes("token"), false); // token only goes by email
  const token = lastLink(/\/signup\/([a-f0-9]{64})/);
  assert.ok(token);

  // DB stores only the hash
  const row = (await pool.query("SELECT token_hash FROM invitations WHERE lower(email)='agent@agency.com'")).rows[0];
  assert.equal(row.token_hash, hashToken(token));
  assert.notEqual(row.token_hash, token);

  const pub = await call("GET", `/api/invitations/${token}`);
  assert.deepEqual(Object.keys(pub.body.data).sort(), ["email", "expires_at", "first_name", "role"]);
  assert.equal(pub.body.data.role, "agent");

  const payload = { first_name: "Sam", last_name: "Smith", phone: "+61 400 111 222", password: "Agent@pass1", consent: true,
    agency_name: "Smith Education", business_number: "ABN 1234567", country: "India" };

  // browser cannot choose role/email
  const sneaky = await call("POST", `/api/invitations/${token}/accept`, { body: { ...payload, role: "admin", email: "evil@x.com" } });
  assert.equal(sneaky.status, 400);
  // missing consent
  assert.equal((await call("POST", `/api/invitations/${token}/accept`, { body: { ...payload, consent: false } })).status, 400);
  // weak password
  assert.equal((await call("POST", `/api/invitations/${token}/accept`, { body: { ...payload, password: "weak" } })).status, 400);

  const ok = await call("POST", `/api/invitations/${token}/accept`, { body: payload });
  assert.equal(ok.status, 201);
  const user = (await pool.query("SELECT role,email FROM users WHERE email='agent@agency.com'")).rows[0];
  assert.equal(user.role, "agent");

  // single use
  assert.equal((await call("POST", `/api/invitations/${token}/accept`, { body: payload })).status, 404);
  assert.equal((await call("GET", `/api/invitations/${token}`)).status, 404);

  const login = await signIn("agent@agency.com", "Agent@pass1");
  assert.equal(login.status, 200);
  agentToken = login.body.data.token;
});

test("duplicate user / duplicate open invitation handling", async () => {
  const dup = await call("POST", "/api/invitations", { token: adminToken, body: { email: "agent@agency.com", role: "agent" } });
  assert.equal(dup.status, 409);
  await call("POST", "/api/invitations", { token: adminToken, body: { email: "t@school.com", role: "teacher" } });
  const first = lastLink(/\/signup\/([a-f0-9]{64})/);
  await call("POST", "/api/invitations", { token: adminToken, body: { email: "t@school.com", role: "teacher" } });
  const second = lastLink(/\/signup\/([a-f0-9]{64})/);
  assert.notEqual(first, second);
  assert.equal((await call("GET", `/api/invitations/${first}`)).status, 404); // old link voided
  assert.equal((await call("GET", `/api/invitations/${second}`)).status, 200);
});

test("agent permissions: students only, own invitations only, no admin routes", async () => {
  assert.equal((await call("POST", "/api/invitations", { token: agentToken, body: { email: "a2@x.com", role: "agent" } })).status, 403);
  assert.equal((await call("GET", "/api/users", { token: agentToken })).status, 403);
  const st = await call("POST", "/api/invitations", { token: agentToken, body: { email: "kid@x.com", role: "student" } });
  assert.equal(st.status, 201);
  const list = await call("GET", "/api/invitations", { token: agentToken });
  assert.deepEqual(list.body.data.map((i) => i.email), ["kid@x.com"]);
  const adminList = await call("GET", "/api/invitations", { token: adminToken });
  assert.ok(adminList.body.data.length >= 3);

  // student sign-up links the student to the agent
  const token = lastLink(/\/signup\/([a-f0-9]{64})/);
  const acc = await call("POST", `/api/invitations/${token}/accept`, { body: {
    first_name: "Kid", last_name: "Lee", phone: "0400111222", password: "Stud3nt@pass", consent: true, date_of_birth: "2004-05-06", country: "Nepal" } });
  assert.equal(acc.status, 201);
  const sp = (await pool.query("SELECT agent_id FROM student_profiles")).rows[0];
  const agentId = (await pool.query("SELECT id FROM users WHERE email='agent@agency.com'")).rows[0].id;
  assert.equal(String(sp.agent_id), String(agentId));
});

test("revoke makes link dead", async () => {
  await call("POST", "/api/invitations", { token: adminToken, body: { email: "rev@x.com", role: "teacher" } });
  const token = lastLink(/\/signup\/([a-f0-9]{64})/);
  const id = (await pool.query("SELECT id FROM invitations WHERE email='rev@x.com'")).rows[0].id;
  assert.equal((await call("DELETE", `/api/invitations/${id}`, { token: adminToken })).status, 200);
  assert.equal((await call("GET", `/api/invitations/${token}`)).status, 404);
});

test("expired invitation is rejected", async () => {
  await call("POST", "/api/invitations", { token: adminToken, body: { email: "old@x.com", role: "teacher" } });
  const token = lastLink(/\/signup\/([a-f0-9]{64})/);
  await pool.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE email='old@x.com'");
  assert.equal((await call("GET", `/api/invitations/${token}`)).status, 404);
});

test("forgot password is generic; reset link works once and kills old sessions", async () => {
  outbox.length = 0;
  const unknown = await call("POST", "/api/auth/forgot-password", { body: { email: "ghost@afc.test" } });
  const known = await call("POST", "/api/auth/forgot-password", { body: { email: "agent@agency.com" } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body);
  assert.equal(outbox.length, 1); // only the real account got an email

  const token = lastLink(/reset-password\?token=([a-f0-9]{64})/);
  assert.ok(token);
  assert.equal((await call("POST", "/api/auth/reset-password/validate", { body: { token } })).body.data.email, "agent@agency.com");

  // a reset token is useless as a login token
  assert.equal((await call("GET", "/api/auth/me", { token })).status, 401);

  assert.equal((await call("POST", "/api/auth/reset-password", { body: { token, password: "short" } })).status, 400);
  const ok = await call("POST", "/api/auth/reset-password", { body: { token, password: "N3w@password" } });
  assert.equal(ok.status, 200);
  assert.equal((await call("POST", "/api/auth/reset-password", { body: { token, password: "An0ther@pass" } })).status, 400); // single use

  assert.equal((await call("GET", "/api/auth/me", { token: agentToken })).status, 401); // old session dead
  assert.equal((await signIn("agent@agency.com", "Agent@pass1")).status, 401);
  assert.equal((await signIn("agent@agency.com", "N3w@password")).status, 200);
});

test("newer reset link voids the older one; expired link rejected", async () => {
  outbox.length = 0;
  await call("POST", "/api/auth/forgot-password", { body: { email: "agent@agency.com" } });
  const t1 = lastLink(/token=([a-f0-9]{64})/);
  await call("POST", "/api/auth/forgot-password", { body: { email: "agent@agency.com" } });
  const t2 = lastLink(/token=([a-f0-9]{64})/);
  assert.equal((await call("POST", "/api/auth/reset-password/validate", { body: { token: t1 } })).status, 400);
  await pool.query("UPDATE password_resets SET expires_at = now() - interval '1 second'");
  assert.equal((await call("POST", "/api/auth/reset-password/validate", { body: { token: t2 } })).status, 400);
});

test("change password returns a fresh token and kills the old one", async () => {
  const login = await signIn("agent@agency.com", "N3w@password");
  const old = login.body.data.token;
  assert.equal((await call("PUT", "/api/auth/me/password", { token: old, body: { currentPassword: "wrong", newPassword: "Br@ndnew1" } })).status, 400);
  const r = await call("PUT", "/api/auth/me/password", { token: old, body: { currentPassword: "N3w@password", newPassword: "Br@ndnew1" } });
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/auth/me", { token: old })).status, 401);
  assert.equal((await call("GET", "/api/auth/me", { token: r.body.data.token })).status, 200);
});

test("admin can suspend; suspended users are cut off; last admin protected", async () => {
  const id = (await pool.query("SELECT id FROM users WHERE email='agent@agency.com'")).rows[0].id;
  const tok = (await signIn("agent@agency.com", "Br@ndnew1")).body.data.token;
  assert.equal((await call("PATCH", `/api/users/${id}/status`, { token: adminToken, body: { status: "suspended" } })).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { token: tok })).status, 401);
  const blocked = await signIn("agent@agency.com", "Br@ndnew1");
  assert.equal(blocked.status, 403);
  assert.equal((await signIn("agent@agency.com", "Wrong@pass1")).status, 401); // wrong pw never reveals state

  const adminId = (await pool.query("SELECT id FROM users WHERE email=$1", [ADMIN.email])).rows[0].id;
  assert.equal((await call("PATCH", `/api/users/${adminId}/status`, { token: adminToken, body: { status: "suspended" } })).status, 400);
  assert.equal((await call("PATCH", `/api/users/${id}/status`, { token: adminToken, body: { status: "banana" } })).status, 400);
});

test("user list never exposes secrets; audit log recorded", async () => {
  const list = await call("GET", "/api/users?limit=50", { token: adminToken });
  assert.equal(list.status, 200);
  const raw = JSON.stringify(list.body);
  assert.equal(/password|token_hash|token_version|locked/.test(raw), false);
  const n = (await pool.query("SELECT count(*) FROM audit_logs WHERE action IN ('auth.login','invitation.created','invitation.accepted','auth.password_reset')")).rows[0].count;
  assert.ok(Number(n) >= 5);
});

test("security headers, CORS and error shape", async () => {
  const res = await fetch(base + "/api/health");
  assert.ok(res.headers.get("x-content-type-options"));
  assert.equal(res.headers.get("x-powered-by"), null);
  const bad = await fetch(base + "/api/auth/me", { headers: { Origin: "http://evil.example" } });
  assert.equal(bad.status, 403);
  const nf = await call("GET", "/api/nope");
  assert.equal(nf.status, 404);
  assert.equal(nf.body.success, false);
});
