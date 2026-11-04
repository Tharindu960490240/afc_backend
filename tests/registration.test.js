// Integration test: agents registering themselves from the college website.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/config/db");
const app = require("../src/app");
const { outbox } = require("../src/services/emailService");
const { hashPassword } = require("../src/utils/password");
const cleanup = require("../src/jobs/cleanup");

let server, base, adminT;
const PW = "Passw0rd@1";
const NEW_PW = "Another@Pass9";

const json = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const form = (over = {}) => ({
  first_name: "Priya", last_name: "Nair", email: "priya@agency.in", phone: "+91 98765 43210",
  password: PW, agency_name: "Nair Education", business_number: "GST 12345", country: "India", consent: true, ...over,
});
const register = (over) => json("POST", "/api/auth/register-agent", { body: form(over) });
const mails = (to, re) => outbox.filter((m) => m.to === to && re.test(m.subject));
const tokenFrom = (mail) => /register\/agent\/verify\/([a-f0-9]{64})/.exec(mail.text)[1];
const login = (email, password = PW) => json("POST", "/api/auth/login", { body: { email, password } });
let firstToken;
const status = async (email) => (await pool.query("SELECT status FROM users WHERE lower(email)=lower($1)", [email])).rows[0]?.status;

before(async () => {
  await pool.query("TRUNCATE agreements, audit_logs, password_resets, invitations, student_profiles, agent_profiles, users RESTART IDENTITY CASCADE");
  const hash = await hashPassword(PW);
  await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ('admin@afc.test',$1,'Ada','Test','admin')`, [hash]);
  await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ('old@agent.com',$1,'Old','Agent','agent')`, [hash]);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  adminT = (await login("admin@afc.test")).body.data.token;
});
after(async () => { server.close(); await pool.end(); });

test("the form checks its input and ignores nothing it should not accept", async () => {
  assert.equal((await register({ password: "weak" })).status, 400);
  assert.equal((await register({ consent: false })).status, 400);
  assert.equal((await register({ email: "not-an-email" })).status, 400);
  assert.equal((await register({ agency_name: "" })).status, 400);
  assert.equal((await register({ role: "admin" })).status, 400); // strict: no role from the browser
  assert.equal((await register({ status: "active" })).status, 400);
  assert.equal(await status("priya@agency.in"), undefined);
});

test("registering creates an unconfirmed account and emails a link", async () => {
  outbox.length = 0;
  const r = await register();
  assert.equal(r.status, 202);
  assert.equal(await status("priya@agency.in"), "unverified");
  const mail = mails("priya@agency.in", /confirm your email/i)[0];
  assert.ok(mail);
  assert.match(mail.text, /register\/agent\/verify\/[a-f0-9]{64}/);
  firstToken = tokenFrom(mail);
  const profile = (await pool.query("SELECT registered_via, agency_name FROM agent_profiles ap JOIN users u ON u.id=ap.user_id WHERE u.email='priya@agency.in'")).rows[0];
  assert.deepEqual(profile, { registered_via: "website", agency_name: "Nair Education" });
  // cannot sign in yet
  const l = await login("priya@agency.in");
  assert.equal(l.status, 403);
  assert.match(l.body.message, /confirm your email/i);
  // the password is stored hashed
  assert.equal((await pool.query("SELECT password_hash FROM users WHERE email='priya@agency.in'")).rows[0].password_hash.includes(PW), false);
});

test("answers do not reveal whether an email is already registered", async () => {
  outbox.length = 0;
  const fresh = await register({ email: "someone.new@x.com" });
  const taken = await register({ email: "old@agent.com" });
  assert.equal(taken.status, fresh.status);
  assert.equal(taken.body.message, fresh.body.message);
  // the existing person is told by email, and nothing changes for them
  assert.ok(mails("old@agent.com", /already have/i)[0]);
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM users WHERE email='old@agent.com'")).rows[0].c, 1);
  assert.equal((await login("old@agent.com")).status, 200);
});

test("registering again with a pending email sends a new link and never replaces the password", async () => {
  const first = firstToken;
  outbox.length = 0;
  assert.equal((await register({ password: NEW_PW, agency_name: "Takeover Ltd" })).status, 202);
  const second = tokenFrom(mails("priya@agency.in", /confirm your email/i)[0]);
  assert.notEqual(first, second);
  // the first link no longer works; the stored details are the original ones
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token: first } })).status, 400);
  assert.equal((await pool.query("SELECT agency_name FROM agent_profiles ap JOIN users u ON u.id=ap.user_id WHERE u.email='priya@agency.in'")).rows[0].agency_name, "Nair Education");
});

test("confirming the email moves the registration to the college", async () => {
  const token = tokenFrom(mails("priya@agency.in", /confirm your email/i).pop());
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token: "abc" } })).status, 400);
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token: "a".repeat(64) } })).status, 400);
  outbox.length = 0;
  const ok = await json("POST", "/api/auth/verify-agent", { body: { token } });
  assert.equal(ok.status, 200);
  assert.equal(await status("priya@agency.in"), "pending_approval");
  assert.ok(mails("admin@afc.test", /new agent registration/i)[0]);
  assert.ok(mails("priya@agency.in", /received your (registration|agent application)/i)[0]);
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token } })).status, 400); // single use
  const l = await login("priya@agency.in");
  assert.equal(l.status, 403);
  assert.match(l.body.message, /waiting for approval/i);
  assert.equal((await login("priya@agency.in", NEW_PW)).status, 401); // the stranger's password never worked
});

test("only admins see and decide registrations", async () => {
  const anon = await json("GET", "/api/registrations");
  assert.equal(anon.status, 401);
  const agentT = (await login("old@agent.com")).body.data.token;
  assert.equal((await json("GET", "/api/registrations", { token: agentT })).status, 403);
  const list = await json("GET", "/api/registrations", { token: adminT });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  const r = list.body.data[0];
  assert.equal(r.email, "priya@agency.in");
  assert.equal(r.agency_name, "Nair Education");
  assert.equal(JSON.stringify(list.body).includes("password"), false);
  assert.deepEqual((await json("GET", "/api/registrations/counts", { token: adminT })).body.data, { pending_approval: 1, unverified: 1 });
  // a pending agent is not offered in the agreements list and cannot be toggled as a normal user
  const agents = (await json("GET", "/api/agents", { token: adminT })).body.data.map((a) => a.email);
  assert.equal(agents.includes("priya@agency.in"), false);
  assert.equal((await json("PATCH", `/api/users/${r.id}/status`, { token: adminT, body: { status: "active" } })).status, 409);
  assert.equal((await json("POST", `/api/registrations/${r.id}/approve`, { token: agentT })).status, 403);
});

test("approving lets the agent sign in; the decision is final and audited", async () => {
  const id = (await pool.query("SELECT id FROM users WHERE email='priya@agency.in'")).rows[0].id;
  outbox.length = 0;
  assert.equal((await json("POST", `/api/registrations/${id}/approve`, { token: adminT })).status, 200);
  assert.ok(mails("priya@agency.in", /approved/i)[0]);
  const l = await login("priya@agency.in");
  assert.equal(l.status, 200);
  assert.equal(l.body.data.user.role, "agent");
  assert.equal((await json("POST", `/api/registrations/${id}/approve`, { token: adminT })).status, 409);
  assert.equal((await json("POST", `/api/registrations/${id}/reject`, { token: adminT, body: {} })).status, 409);
  const agents = (await json("GET", "/api/agents", { token: adminT })).body.data.map((a) => a.email);
  assert.ok(agents.includes("priya@agency.in")); // now available for an agreement
  const n = (await pool.query("SELECT count(*)::int AS c FROM audit_logs WHERE action IN ('agent.email_verified','agent.approved')")).rows[0].c;
  assert.equal(n, 2);
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action='agent.registered'")).rowCount >= 1);
});

test("rejecting keeps the agent out and tells them", async () => {
  await register({ email: "bad@agency.in", first_name: "Bad" });
  const token = tokenFrom(mails("bad@agency.in", /confirm your email/i)[0]);
  await json("POST", "/api/auth/verify-agent", { body: { token } });
  const id = (await pool.query("SELECT id FROM users WHERE email='bad@agency.in'")).rows[0].id;
  outbox.length = 0;
  assert.equal((await json("POST", `/api/registrations/${id}/reject`, { token: adminT, body: { reason: "We could not verify your business" } })).status, 200);
  const mail = mails("bad@agency.in", /about your agent registration/i)[0];
  assert.match(mail.text, /could not verify your business/);
  const l = await login("bad@agency.in");
  assert.equal(l.status, 403);
  assert.match(l.body.message, /not approved/i);
  // a rejected email cannot simply register again
  outbox.length = 0;
  assert.equal((await register({ email: "bad@agency.in" })).status, 202);
  assert.equal(await status("bad@agency.in"), "rejected");
});

test("registrations nobody confirmed are cleaned up after a week", async () => {
  await register({ email: "ghost@agency.in", first_name: "Ghost" });
  await pool.query("UPDATE users SET created_at = now() - interval '8 days' WHERE email='ghost@agency.in'");
  await register({ email: "recent@agency.in", first_name: "Recent" });
  await cleanup.purgeExpired();
  assert.equal(await status("ghost@agency.in"), undefined);
  assert.equal(await status("recent@agency.in"), "unverified");
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM email_verifications ev LEFT JOIN users u ON u.id=ev.user_id WHERE u.id IS NULL")).rows[0].c, 0);
});

test("admin can open the full details of an agent", async () => {
  const id = (await pool.query("SELECT id FROM users WHERE email='priya@agency.in'")).rows[0].id;
  assert.equal((await json("GET", `/api/agents/${id}`)).status, 401);
  const agentT = (await login("old@agent.com")).body.data.token;
  assert.equal((await json("GET", `/api/agents/${id}`, { token: agentT })).status, 403);
  const adminId = (await pool.query("SELECT id FROM users WHERE email='admin@afc.test'")).rows[0].id;
  assert.equal((await json("GET", `/api/agents/${adminId}`, { token: adminT })).status, 404); // not an agent

  const r = await json("GET", `/api/agents/${id}`, { token: adminT });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.email, "priya@agency.in");
  assert.equal(d.agency_name, "Nair Education");
  assert.equal(d.registered_via, "website");
  assert.equal(d.status, "active");
  assert.ok(d.email_verified_at && d.decided_at);
  assert.equal(d.decided_by_first_name, "Ada");
  assert.equal(d.invitation, null);
  assert.equal(d.students, 0);
  assert.deepEqual(d.agreements, []);
  assert.ok(d.activity.some((a) => a.action === "agent.approved"));
  assert.ok(d.activity.some((a) => a.action === "auth.login"));
  const raw = JSON.stringify(r.body);
  assert.equal(raw.includes("password"), false);
  assert.equal(raw.includes("token_version"), false);
});

test("an agent can read and update their own profile, and nobody else's", async () => {
  const t = (await login("priya@agency.in")).body.data.token;
  assert.equal((await json("GET", "/api/auth/me/profile")).status, 401);
  const r = await json("GET", "/api/auth/me/profile", { token: t });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.email, "priya@agency.in");
  assert.ok(r.body.data.agent.agency_name);
  assert.equal(JSON.stringify(r.body).includes("password"), false);
  const up = await json("PUT", "/api/auth/me", { token: t, body: { phone: "+61 400 111 222" } });
  assert.equal(up.status, 200);
  assert.equal((await json("GET", "/api/auth/me/profile", { token: t })).body.data.user.phone, "+61 400 111 222");
  const bare = (await login("old@agent.com")).body.data.token; // seeded without agency details
  assert.equal((await json("GET", "/api/auth/me/profile", { token: bare })).body.data.agent, null);
  const a = await json("GET", "/api/auth/me/profile", { token: adminT });
  assert.equal(a.body.data.agent, null); // admins have no agency details
});
