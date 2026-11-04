// Integration test: COMS Block 1, Part 1 (staff roles, calendar, audit, agent register).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/config/db");
const app = require("../src/app");
const { outbox } = require("../src/services/emailService");
const { hashPassword } = require("../src/utils/password");
const calendar = require("../src/services/calendarService");
const { validAbn, validAcn } = require("../src/utils/abn");

let server, base;
const PW = "Passw0rd@1";
const T = {}; // tokens by role

const json = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json().catch(() => ({})) : await res.text(), headers: res.headers };
};
const login = async (email) => (await json("POST", "/api/auth/login", { body: { email, password: PW } })).body.data?.token;
const mails = (to, re) => outbox.filter((m) => m.to === to && re.test(m.subject));
const get = (p, t) => json("GET", p, { token: T[t] });
const post = (p, t, body) => json("POST", p, { token: T[t], body: body || {} });
const patch = (p, t, body) => json("PATCH", p, { token: T[t], body });
const audits = async (action, entityId) =>
  (await pool.query("SELECT * FROM audit_logs WHERE action=$1 AND ($2::text IS NULL OR entity_id=$2) ORDER BY id", [action, entityId || null])).rows;

let agentId;

before(async () => {
  await pool.query("TRUNCATE agreements, audit_logs, password_resets, invitations, student_profiles, agent_profiles, users RESTART IDENTITY CASCADE");
  const hash = await hashPassword(PW);
  const staff = [
    ["admin", "admin"], ["marketing", "marketing_officer"], ["director", "director"], ["ceo", "ceo"],
    ["coe", "coe_admin"], ["accounts", "accounts"], ["compliance", "compliance"], ["teacher", "teacher"],
  ];
  for (const [name, role] of staff) {
    await pool.query(
      `INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ($1,$2,$3,'Test',$4)`,
      [`${name}@afc.test`, hash, name[0].toUpperCase() + name.slice(1), role],
    );
  }
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const [name] of staff) T[name] = await login(`${name}@afc.test`);
  calendar.clearCache();
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------ calendar and checks
test("working days skip weekends and Tasmanian and Victorian public holidays", async () => {
  // Thu 2 Apr 2026: Good Friday, weekend, Easter Monday are not working days
  assert.equal(await calendar.addBusinessDays("2026-04-02", 1), "2026-04-07");
  // Fri 30 Oct 2026: Mon 2 Nov is Recreation Day (TAS), Tue 3 Nov is Melbourne Cup (VIC)
  assert.equal(await calendar.addBusinessDays("2026-10-30", 1), "2026-11-04");
  assert.equal(await calendar.addBusinessDays("2026-10-30", 0), "2026-10-30");
  assert.equal(await calendar.addBusinessDays("2026-03-02", 10), "2026-03-17"); // Labour/Eight Hours Day 9 Mar skipped
  assert.equal(await calendar.businessDaysBetween("2026-04-02", "2026-04-07"), 1);
  assert.equal(await calendar.businessDaysBetween("2026-04-07", "2026-04-02"), -1);
  assert.equal(await calendar.isBusinessDay("2026-11-03"), false);
  assert.equal(await calendar.isBusinessDay("2026-11-05"), true);
});

test("ABN and ACN checksums", () => {
  assert.equal(validAbn("51 824 753 556"), true);
  assert.equal(validAbn("51 824 753 557"), false);
  assert.equal(validAcn("004 085 616"), true);
  assert.equal(validAcn("004 085 617"), false);
});

test("holiday calendar: everyone on staff can read it, only admins change it", async () => {
  const list = await get("/api/coms/holidays", "marketing");
  assert.equal(list.status, 200);
  assert.ok(list.body.coveredYears.includes(2026) && list.body.coveredYears.includes(2027));
  const body = { date: "2027-10-21", name: "Launceston Show Day", jurisdiction: "TAS" };
  assert.equal((await post("/api/coms/holidays", "marketing", body)).status, 403);
  assert.equal((await post("/api/coms/holidays", "admin", { ...body, date: "2027-13-40" })).status, 400);
  const added = await post("/api/coms/holidays", "admin", body);
  assert.equal(added.status, 201);
  assert.equal((await post("/api/coms/holidays", "admin", body)).status, 409);
  assert.equal(await calendar.isBusinessDay("2027-10-21"), false); // cache refreshed
  assert.equal((await json("DELETE", `/api/coms/holidays/${added.body.data.id}`, { token: T.admin })).status, 200);
  assert.equal(await calendar.isBusinessDay("2027-10-21"), true);
  assert.equal((await audits("holiday.added")).length, 1);
});

// ------------------------------------------------------------------ staff roles
test("an administrator can invite a staff member, who signs up with that role", async () => {
  outbox.length = 0;
  const inv = await json("POST", "/api/invitations", { token: T.admin, body: { email: "new.officer@afc.test", role: "marketing_officer" } });
  assert.equal(inv.status, 201);
  const mail = mails("new.officer@afc.test", /invitation/i)[0];
  assert.match(mail.text, /Sales & Marketing Officer/);
  const token = /signup\/([a-f0-9]{64})/.exec(mail.text)[1];
  const done = await json("POST", `/api/invitations/${token}/accept`, {
    body: { first_name: "Nina", last_name: "Officer", phone: "+61 400 111 222", password: PW, consent: true },
  });
  assert.equal(done.status, 201);
  const r = await json("POST", "/api/auth/login", { body: { email: "new.officer@afc.test", password: PW } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.role, "marketing_officer");
  // a marketing officer may invite agents but not other staff
  const t = r.body.data.token;
  assert.equal((await json("POST", "/api/invitations", { token: t, body: { email: "x@y.com", role: "director" } })).status, 403);
});

test("only college staff can open the agent register", async () => {
  assert.equal((await json("GET", "/api/coms/agents")).status, 401);
  assert.equal((await get("/api/coms/agents", "teacher")).status, 403);
  for (const r of ["admin", "marketing", "director", "ceo", "coe", "accounts", "compliance"]) {
    assert.equal((await get("/api/coms/agents", r)).status, 200, r);
  }
});

// ------------------------------------------------------------------ expression of interest
test("a marketing officer records an expression of interest and the application link is emailed", async () => {
  outbox.length = 0;
  assert.equal((await post("/api/coms/agents", "accounts", { legal_name: "Xylo Ltd", email: "xylo@x.com", country: "India" })).status, 403);
  assert.equal((await post("/api/coms/agents", "marketing", { legal_name: "A", email: "bad", country: "India" })).status, 400);
  assert.equal((await post("/api/coms/agents", "marketing", { legal_name: "Bright Path Education", email: "x@x.com", country: "India", status: "active" })).status, 400);

  const r = await post("/api/coms/agents", "marketing", {
    legal_name: "Bright Path Education", email: "owner@brightpath.in", country: "India", contact_name: "Ravi Menon", phone: "+91 98765 43210",
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.linkSent, true);
  agentId = r.body.data.id;
  assert.equal(r.body.data.status, "prospect");
  assert.equal(r.body.data.persons.length, 1);
  assert.equal(r.body.data.persons[0].is_primary_contact, true);
  assert.ok(r.body.data.prisms_missing.length > 0);
  const mail = mails("owner@brightpath.in", /invitation/i)[0];
  assert.ok(mail, "invitation email");
  assert.equal((await audits("agent.created", agentId)).length, 1);
  assert.equal((await audits("agent.application_link_sent")).length, 1);

  // duplicates
  assert.equal((await post("/api/coms/agents", "marketing", { legal_name: "Other", email: "OWNER@brightpath.in", country: "India" })).status, 409);
  assert.equal((await post("/api/coms/agents", "marketing", { legal_name: "Other", email: "marketing@afc.test", country: "India" })).status, 409);
});

test("when the agent accepts the link the application starts: status, SLA dates and acknowledgement", async () => {
  const mail = mails("owner@brightpath.in", /invitation/i)[0];
  const token = /signup\/([a-f0-9]{64})/.exec(mail.text)[1];
  outbox.length = 0;
  const done = await json("POST", `/api/invitations/${token}/accept`, {
    body: { first_name: "Ravi", last_name: "Menon", phone: "+91 98765 43210", password: PW, consent: true,
            agency_name: "Bright Path Education", business_number: "GST 998877", country: "India" },
  });
  assert.equal(done.status, 201);

  const d = (await get(`/api/coms/agents/${agentId}`, "marketing")).body.data;
  assert.equal(d.status, "applied");
  assert.equal(d.persons.length, 1, "login attached to the existing contact");
  assert.ok(d.persons[0].portal_user_id);
  assert.equal(d.abn_acn, "GST 998877");
  assert.ok(d.application_received_at && d.ack_due_date && d.decision_due_date);
  assert.ok(d.ack_sent_at);
  assert.equal(d.sla.decision.state, "ok");
  assert.equal(d.sla.acknowledgement.state, "done");
  const ack = mails("owner@brightpath.in", /received your agent application/i)[0];
  assert.ok(ack, "acknowledgement email");
  assert.match(ack.text, /Principal place of business address/);
  assert.deepEqual(d.history.map((h) => h.to_status), ["applied", "prospect"]);
  // decision is due 10 working days after receipt
  const due = await calendar.addBusinessDays(calendar.localDate(d.application_received_at), 10);
  assert.equal(d.decision_due_date, due);
});

test("the decision timer turns amber at working day 7 and red at day 10", async () => {
  const setAge = async (days) => {
    await pool.query(`UPDATE agents SET application_received_at = now() - ($2 || ' days')::interval WHERE id=$1`, [agentId, String(days)]);
    return (await get(`/api/coms/agents/${agentId}`, "director")).body.data.sla.decision.state;
  };
  assert.equal(await setAge(1), "ok");
  assert.equal(await setAge(13), "amber"); // about 9 calendar days = 7+ working days
  assert.equal(await setAge(25), "red");
  await pool.query(`UPDATE agents SET application_received_at = now() WHERE id=$1`, [agentId]);
});

// ------------------------------------------------------------------ editing and audit
test("staff edit the PRISMS fields; the audit log keeps before and after values", async () => {
  const bad = await patch(`/api/coms/agents/${agentId}`, "marketing", { country: "Australia", abn_acn: "12 345 678 901" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.abn_acn);
  assert.equal((await patch(`/api/coms/agents/${agentId}`, "marketing", { website: "not a url" })).status, 400);
  assert.equal((await patch(`/api/coms/agents/${agentId}`, "marketing", { status: "active" })).status, 400);
  assert.equal((await patch(`/api/coms/agents/${agentId}`, "accounts", { phone: "+91 98765 00000" })).status, 403);

  const r = await patch(`/api/coms/agents/${agentId}`, "marketing", {
    principal_address: "12 MG Road, Kochi, Kerala", trading_names: ["Bright Path", "BP Study Abroad"], marn: "1234567",
    abn_acn: "GST 998877", phone: "+91 98765 11111", website: "https://brightpath.in",
  });
  assert.equal(r.status, 200);
  const a = (await audits("agent.updated", agentId)).pop();
  assert.equal(a.before.phone, "+91 98765 43210");
  assert.equal(a.after.phone, "+91 98765 11111");
  assert.deepEqual(a.after.trading_names, ["Bright Path", "BP Study Abroad"]);
  assert.equal("abn_acn" in a.after, false, "unchanged values are not logged");
  assert.deepEqual(r.body.data.prisms_missing.map((m) => m.key), []);

  // a body corporate also needs a registered office and a director
  const bc = await patch(`/api/coms/agents/${agentId}`, "marketing", { is_body_corporate: true });
  assert.deepEqual(bc.body.data.prisms_missing.map((m) => m.key).sort(), ["directors", "registered_office_address"]);
});

test("people: directors count towards the PRISMS check, removal needs a reason", async () => {
  assert.equal((await post(`/api/coms/agents/${agentId}/persons`, "accounts", { name: "Dev", email: "dev@brightpath.in" })).status, 403);
  const add = await post(`/api/coms/agents/${agentId}/persons`, "marketing", { name: "Meera Menon", email: "meera@brightpath.in", role: "director", involved_in_enrolments: true });
  assert.equal(add.status, 201);
  const staffer = await post(`/api/coms/agents/${agentId}/persons`, "marketing", { name: "Anil Kumar", email: "anil@brightpath.in", marn: "7654321", involved_in_enrolments: true });
  const anil = staffer.body.data.find((p) => p.name === "Anil Kumar");
  await patch(`/api/coms/agents/${agentId}`, "marketing", { registered_office_address: "12 MG Road, Kochi" });
  const d = (await get(`/api/coms/agents/${agentId}`, "marketing")).body.data;
  assert.deepEqual(d.prisms_missing, []);
  assert.equal(d.persons.length, 3);

  assert.equal((await post(`/api/coms/agents/${agentId}/persons/${anil.id}/delete`, "marketing", { reason: "" })).status, 400);
  const gone = await post(`/api/coms/agents/${agentId}/persons/${anil.id}/delete`, "marketing", { reason: "Left the company" });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.data.length, 2);
  const row = (await pool.query("SELECT deleted_at, delete_reason FROM agent_persons WHERE id=$1", [anil.id])).rows[0];
  assert.ok(row.deleted_at, "soft delete only");
  assert.equal(row.delete_reason, "Left the company");
  // the person who holds the portal login cannot be removed
  const owner = d.persons.find((p) => p.portal_user_id);
  assert.equal((await post(`/api/coms/agents/${agentId}/persons/${owner.id}/delete`, "marketing", { reason: "Mistake" })).status, 409);
});

test("portfolio fields (account manager, tier, risk, cadence) are for the Director, CEO and administrators", async () => {
  const dir = (await pool.query("SELECT id FROM users WHERE email='director@afc.test'")).rows[0].id;
  assert.equal((await patch(`/api/coms/agents/${agentId}`, "marketing", { tier: "growth" })).status, 403);
  assert.equal((await patch(`/api/coms/agents/${agentId}`, "director", { risk_rating: "low" })).status, 400); // needs a reason
  const teacherId = (await pool.query("SELECT id FROM users WHERE email='teacher@afc.test'")).rows[0].id;
  assert.equal((await patch(`/api/coms/agents/${agentId}`, "director", { account_manager_id: teacherId })).status, 400);
  const r = await patch(`/api/coms/agents/${agentId}`, "director", {
    account_manager_id: dir, tier: "growth", risk_rating: "low", risk_override_reason: "Clean history", contact_cadence_days: 14,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.account_manager_name, "Director Test");
  assert.equal(r.body.data.contact_cadence_days, 14);
  const list = await get("/api/coms/agents?manager=" + dir, "ceo");
  assert.equal(list.body.data.length, 1);
  const un = await get("/api/coms/agents?manager=unassigned", "ceo");
  assert.equal(un.body.data.length, 0);
});

test("the audit viewer is for Compliance, the CEO and administrators", async () => {
  assert.equal((await get("/api/coms/audit", "marketing")).status, 403);
  const r = await get(`/api/coms/audit?entity_type=agent&entity_id=${agentId}`, "compliance");
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 4);
  assert.ok(r.body.data.some((x) => x.action === "agent.updated" && x.before && x.after));
  assert.equal((await get("/api/coms/audit?action=agent.", "ceo")).status, 200);
});

test("audit rows cannot be edited or deleted", async () => {
  await assert.rejects(pool.query("UPDATE audit_logs SET action='x'"), /cannot be changed/);
  await assert.rejects(pool.query("DELETE FROM audit_logs"), /kept for 7 years/);
});

// ------------------------------------------------------------------ status, hard stops
test("status moves follow the rules: roles, reasons, and no approving before due diligence", async () => {
  const st = (to, t, reason) => post(`/api/coms/agents/${agentId}/status`, t, { status: to, ...(reason ? { reason } : {}) });
  assert.equal((await st("due_diligence", "accounts")).status, 403);
  assert.equal((await st("active", "marketing")).status, 409); // not a legal move
  assert.equal((await st("due_diligence", "marketing")).status, 200);
  const approve = await st("approved", "director");
  assert.equal(approve.status, 409);
  assert.match(approve.body.message, /due diligence/i);
  const hist = (await get(`/api/coms/agents/${agentId}`, "director")).body.data.history;
  assert.equal(hist[0].to_status, "due_diligence");
});

test("BR-01 and BR-02: no Active status without a signed agreement, PRISMS entry and induction", async () => {
  const st = (to, t, reason) => post(`/api/coms/agents/${agentId}/status`, t, { status: to, ...(reason ? { reason } : {}) });
  await pool.query("UPDATE agents SET status='onboarding' WHERE id=$1", [agentId]); // Part 2 will do this on countersign

  const blocked = await st("active", "marketing");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.blockers.length, 3);

  // PRISMS is recorded by the CoE administrator, induction by marketing
  assert.equal((await post(`/api/coms/agents/${agentId}/milestones`, "marketing", { type: "prisms" })).status, 403);
  assert.equal((await post(`/api/coms/agents/${agentId}/milestones`, "coe", { type: "prisms" })).status, 200);
  assert.equal((await post(`/api/coms/agents/${agentId}/milestones`, "coe", { type: "induction" })).status, 403);
  assert.equal((await post(`/api/coms/agents/${agentId}/milestones`, "marketing", { type: "induction", date: "2026-11-02" })).status, 200);
  assert.equal((await st("active", "marketing")).body.blockers.length, 1, "agreement still missing");

  // a countersigned agreement with both dates
  const uid = (await pool.query("SELECT id FROM users WHERE email='owner@brightpath.in'")).rows[0].id;
  await pool.query(
    `INSERT INTO agreements (agent_id, status, effective_date, expires_at, sent_by) VALUES ($1,'active', current_date, current_date + 365, 1)`, [uid],
  );
  const ok = await st("active", "marketing");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, "active");
  assert.equal(ok.body.data.has_signed_agreement, true);
  assert.equal(ok.body.data.agreements.length, 1);
  assert.ok(ok.body.data.agreement_end);
  assert.equal((await audits("agent.status_changed", agentId)).pop().after.status, "active");
});

test("suspension needs a reason and a senior role; terminating is for the CEO", async () => {
  const st = (to, t, reason) => post(`/api/coms/agents/${agentId}/status`, t, { status: to, ...(reason ? { reason } : {}) });
  assert.equal((await st("suspended", "marketing", "Complaint")).status, 403);
  assert.equal((await st("suspended", "director")).status, 400);
  assert.equal((await st("suspended", "director", "Investigating a complaint")).status, 200);
  assert.equal((await st("terminated", "director", "x1y")).status, 403);
  // a suspended agent comes back to active only if the rules are still met
  assert.equal((await st("active", "director", "Cleared")).status, 200);
});

test("suspending the login from the Users screen suspends the agent record, and back", async () => {
  const uid = (await pool.query("SELECT id FROM users WHERE email='owner@brightpath.in'")).rows[0].id;
  assert.equal((await json("PATCH", `/api/users/${uid}/status`, { token: T.admin, body: { status: "suspended" } })).status, 200);
  assert.equal((await get(`/api/coms/agents/${agentId}`, "admin")).body.data.status, "suspended");
  assert.equal((await json("PATCH", `/api/users/${uid}/status`, { token: T.admin, body: { status: "active" } })).status, 200);
  assert.equal((await get(`/api/coms/agents/${agentId}`, "admin")).body.data.status, "active");
});

// ------------------------------------------------------------------ website registrations feed the register
test("a website registration appears as Prospect, becomes Applied when the email is confirmed, and Approved when the college approves", async () => {
  outbox.length = 0;
  const reg = await json("POST", "/api/auth/register-agent", {
    body: { first_name: "Priya", last_name: "Nair", email: "priya@nair.in", phone: "+91 98765 43210", password: PW,
            agency_name: "Nair Education", business_number: "GST 12345", country: "India", consent: true },
  });
  assert.equal(reg.status, 202);
  const find = async () => (await get("/api/coms/agents?search=Nair", "director")).body.data[0];
  assert.equal((await find()).status, "prospect");
  assert.equal((await find()).source, "website");

  const token = /verify\/([a-f0-9]{64})/.exec(mails("priya@nair.in", /confirm your email/i)[0].text)[1];
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token } })).status, 200);
  const applied = await find();
  assert.equal(applied.status, "applied");
  assert.ok(applied.decision_due_date);
  assert.ok(mails("priya@nair.in", /received your agent application/i)[0]);

  const uid = (await pool.query("SELECT id FROM users WHERE email='priya@nair.in'")).rows[0].id;
  assert.equal((await json("POST", `/api/registrations/${uid}/approve`, { token: T.admin })).status, 200);
  assert.equal((await find()).status, "approved");
});

test("rejecting a website registration records the reason on the agent", async () => {
  await json("POST", "/api/auth/register-agent", {
    body: { first_name: "Sam", last_name: "Lee", email: "sam@lee.sg", phone: "+65 9123 4567", password: PW,
            agency_name: "Lee Study", business_number: "", country: "Singapore", consent: true },
  });
  const token = /verify\/([a-f0-9]{64})/.exec(mails("sam@lee.sg", /confirm your email/i)[0].text)[1];
  await json("POST", "/api/auth/verify-agent", { body: { token } });
  const uid = (await pool.query("SELECT id FROM users WHERE email='sam@lee.sg'")).rows[0].id;
  assert.equal((await json("POST", `/api/registrations/${uid}/reject`, { token: T.admin, body: { reason: "Not a registered business" } })).status, 200);
  const r = (await get("/api/coms/agents?status=rejected", "director")).body.data[0];
  assert.equal(r.legal_name, "Lee Study");
  assert.equal(r.rejection_reason, "Not a registered business");
});

// ------------------------------------------------------------------ list, export, delete
test("the register can be filtered, searched and sorted", async () => {
  const all = await get("/api/coms/agents?limit=50&sort=legal_name&dir=asc", "ceo");
  assert.deepEqual(all.body.data.map((a) => a.legal_name), ["Bright Path Education", "Lee Study", "Nair Education"]);
  assert.equal(all.body.pagination.total, 3);
  assert.equal((await get("/api/coms/agents?status=active,approved", "ceo")).body.data.length, 2);
  assert.equal((await get("/api/coms/agents?search=singapore", "ceo")).body.data.length, 0); // search is on names, email and ABN
  assert.equal((await get("/api/coms/agents?search=lee.sg", "ceo")).body.data.length, 1);
  assert.equal((await get("/api/coms/agents?country=india", "ceo")).body.data.length, 2);
  assert.equal((await get("/api/coms/agents?sort=nonsense", "ceo")).status, 400);
  const row = all.body.data[0];
  assert.equal(row.password_hash, undefined);
  const open = (await get("/api/coms/agents?status=applied", "ceo")).body.data;
  assert.equal(open.length, 0); // Nair and Lee were decided above
  await pool.query("UPDATE agents SET status='applied', application_received_at=now() WHERE legal_name='Lee Study'");
  const timer = (await get("/api/coms/agents?status=applied", "ceo")).body.data[0];
  assert.equal(timer.decision_state, "ok");
  assert.ok(timer.working_days_left <= 10);
  await pool.query("UPDATE agents SET status='rejected' WHERE legal_name='Lee Study'");
});

test("exporting the register is logged and spreadsheet formulas are neutralised", async () => {
  await post("/api/coms/agents", "marketing", { legal_name: "=HYPERLINK(\"http://evil\")", email: "evil@x.com", country: "India", send_link: false });
  const r = await get("/api/coms/agents/export", "accounts");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.body, /Legal name,Trading names/);
  assert.match(r.body, /Bright Path Education/);
  assert.match(r.body, /'=HYPERLINK/);
  assert.equal((await audits("agent.exported")).length, 1);
});

test("deleting is soft, needs a reason, and only an administrator can restore", async () => {
  const evil = (await get("/api/coms/agents?search=evil@x.com", "director")).body.data[0];
  assert.equal((await post(`/api/coms/agents/${evil.id}/delete`, "marketing", { reason: "Test" })).status, 403);
  assert.equal((await post(`/api/coms/agents/${evil.id}/delete`, "director", { reason: "" })).status, 400);
  assert.equal((await post(`/api/coms/agents/${evil.id}/delete`, "director", { reason: "Entered by mistake" })).status, 200);
  assert.equal((await get(`/api/coms/agents/${evil.id}`, "director")).status, 404);
  assert.equal((await get("/api/coms/agents?deleted=true", "director")).status, 403);
  const gone = await get("/api/coms/agents?deleted=true", "admin");
  assert.equal(gone.body.data.length, 1);
  assert.equal(gone.body.data[0].delete_reason, "Entered by mistake");
  assert.equal((await post(`/api/coms/agents/${evil.id}/restore`, "director")).status, 403);
  assert.equal((await post(`/api/coms/agents/${evil.id}/restore`, "admin")).status, 200);
  assert.equal((await get(`/api/coms/agents/${evil.id}`, "director")).status, 200);
  assert.equal((await pool.query("SELECT count(*)::int c FROM agents WHERE id=$1", [evil.id])).rows[0].c, 1, "row never removed");
});

test("agents cannot reach any COMS endpoint", async () => {
  const t = await login("owner@brightpath.in"); // the earlier suspension invalidated the old token
  assert.equal((await json("GET", "/api/coms/agents", { token: t })).status, 403);
  assert.equal((await json("GET", `/api/coms/agents/${agentId}`, { token: t })).status, 403);
  assert.equal((await json("GET", "/api/coms/audit", { token: t })).status, 403);
});
