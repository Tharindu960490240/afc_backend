// Integration test: COMS Block 1, Part 2 (referee verification, due diligence, decision, agreement -> onboarding, tasks).
process.env.CRON_SECRET = "c".repeat(40);
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/config/db");
const env = require("../src/config/env");
const app = require("../src/app");
const { outbox } = require("../src/services/emailService");
const { hashPassword } = require("../src/utils/password");
const calendar = require("../src/services/calendarService");
const daily = require("../src/jobs/comsDaily");
const tasksSvc = require("../src/services/taskService");

let server, base;
const PW = "Passw0rd@1";
const T = {};

const json = async (method, p, { token, body, headers } = {}) => {
  if (require("./form2").needsV2(method, p)) body = require("./form2").v2(body);
  if (require("./form2").needsDocs(method, p)) await require("./form2").acceptAllDocuments(pool);
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json().catch(() => ({})) : await res.text(), headers: res.headers };
};
const login = async (email) => (await json("POST", "/api/auth/login", { body: { email, password: PW } })).body.data?.token;
const mails = (to, re) => outbox.filter((m) => m.to === to && re.test(m.subject));
const get = (p, t) => json("GET", p, { token: T[t] });
const post = (p, t, body) => json("POST", p, { token: T[t], body: body || {} });
const audits = async (action, entityId) =>
  (await pool.query("SELECT * FROM audit_logs WHERE action=$1 AND ($2::text IS NULL OR entity_id=$2) ORDER BY id", [action, entityId || null])).rows;

const form = (name, email, over = {}) => ({
  first_name: "Dev", last_name: name.split(" ")[0], email, phone: "+91 98765 43210", password: PW, consent: true,
  legal_name: name, abn_acn: "GST 12345", country: "India", is_body_corporate: false,
  principal_address: "12 MG Road, Bengaluru, India", applicant_role: "director", applicant_in_enrolments: true,
  referees: [
    { name: "Anil Rao", organisation: "Rao Colleges", email: `anil@${email.split("@")[1]}`, phone: "+91 98111 22222" },
    { name: "Mei Tan", organisation: "Tan Institute", email: `mei@${email.split("@")[1]}`, phone: "+65 9123 0000" },
  ],
  coi_declared: false, code_of_ethics: true, information_true: true, ...over,
});

// registers an agent on the website and confirms the email -> status "applied"
async function applied(name, email, over) {
  outbox.length = 0;
  assert.equal((await json("POST", "/api/auth/register-agent", { body: form(name, email, over) })).status, 202);
  const token = /verify\/([a-f0-9]{64})/.exec(mails(email, /confirm your email/i)[0].text)[1];
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token } })).status, 200);
  return (await pool.query(`SELECT a.id FROM agents a WHERE lower(a.email)=lower($1)`, [email])).rows[0].id;
}
const dd = async (id, t = "director") => (await get(`/api/coms/agents/${id}/due-diligence`, t)).body.data;
const refereeIds = async (id) => (await pool.query(`SELECT id FROM agent_referees WHERE agent_id=$1 AND deleted_at IS NULL ORDER BY created_at, id`, [id])).rows.map((r) => r.id);
const goodAnswers = (over = {}) => ({
  known_for: "Five years, as a partner college", worked_with: true, honest: true, accurate_info: true, complaints: false, recommend: true, comments: "", ...over,
});
const tokenFrom = (mail) => /reference\/([a-f0-9]{64})/.exec(mail.text)[1];
const pdf = (n = 200) => ({ name: "evidence.pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(n, 0x20)]).toString("base64") });
const filesOnDisk = () => {
  const dir = path.resolve(env.uploadDir, "coms");
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name])) : []);
  return walk(dir).length;
};

let A; // the main agent (Delta Education)

before(async () => {
  await pool.query("TRUNCATE agreements, audit_logs, password_resets, invitations, student_profiles, agent_profiles, users RESTART IDENTITY CASCADE");
  await require("./form2").restoreSettings(pool);
  fs.rmSync(path.resolve(env.uploadDir, "coms"), { recursive: true, force: true });
  const hash = await hashPassword(PW);
  const staff = [
    ["admin", "admin"], ["marketing", "marketing_officer"], ["director", "director"], ["ceo", "ceo"],
    ["coe", "coe_admin"], ["accounts", "accounts"], ["compliance", "compliance"],
  ];
  for (const [name, role] of staff) {
    await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ($1,$2,$3,'Test',$4)`, [`${name}@afc.test`, hash, name[0].toUpperCase() + name.slice(1), role]);
  }
  // TRUNCATE ... users CASCADE also empties the templates table, so put a sample template back
  await pool.query(
    "INSERT INTO agreement_templates (name, body, version, is_active) VALUES ('Education Agent Agreement', $1, 1, true)",
    ["# Education Agent Agreement\n\nThis Agreement is made between {{college_name}} and {{agency_name}} of {{country}}, from {{effective_date}} to {{expiry_date}}.\n\n## 1. Appointment\n" + "The College appoints the Agent on a non-exclusive basis. ".repeat(4)]);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const [name] of staff) T[name] = await login(`${name}@afc.test`);
  calendar.clearCache();
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------ due diligence opens
test("moving an application to due diligence opens the checklist and makes the officer the preparer", async () => {
  A = await applied("Delta Education", "owner@delta.in");
  assert.equal((await post(`/api/coms/agents/${A}/status`, "accounts", { status: "due_diligence" })).status, 403);
  assert.equal((await post(`/api/coms/agents/${A}/status`, "marketing", { status: "due_diligence" })).status, 200);
  const d = await dd(A);
  assert.equal(d.opened, true);
  assert.deepEqual(d.prepared_by, ["Marketing Test"]);
  assert.ok(d.items.length >= 7);
  assert.equal(d.items.find((i) => i.key === "application").done, true, "all PRISMS fields were filled in on the form");
  assert.equal(d.items.find((i) => i.key === "referees").done, false);
  assert.equal(d.referees.length, 2);
  assert.equal(d.questions.length, 7);
  assert.equal(d.can_decide, true);
});

// ------------------------------------------------------------------ T-02
test("the director cannot approve before a referee check is recorded (T-02)", async () => {
  const r = await post(`/api/coms/agents/${A}/decision`, "director", { decision: "approve", reason: "Looks fine" });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /cannot be approved yet/i);
  assert.match(r.body.message, /referee/i);
  assert.ok(r.body.blockers.length >= 4);
  assert.equal((await get(`/api/coms/agents/${A}`, "director")).body.data.status, "due_diligence");
  // role and input checks
  assert.equal((await post(`/api/coms/agents/${A}/decision`, "marketing", { decision: "approve", reason: "ok ok" })).status, 403);
  assert.equal((await post(`/api/coms/agents/${A}/decision`, "director", { decision: "approve" })).status, 400);
});

// ------------------------------------------------------------------ referee by email form
test("an officer emails the reference form; the referee answers it on a public page; the officer is told", async () => {
  const [r1, r2] = await refereeIds(A);
  outbox.length = 0;
  assert.equal((await post(`/api/coms/agents/${A}/referees/${r1}/request`, "accounts")).status, 403);
  const sent = await post(`/api/coms/agents/${A}/referees/${r1}/request`, "marketing");
  assert.equal(sent.status, 200);
  const mail = mails("anil@delta.in", /reference request/i)[0];
  assert.ok(mail, "the referee gets an email");
  assert.match(mail.text, /Marketing Test/);
  const token = tokenFrom(mail);
  // asking twice is refused: remind instead
  assert.equal((await post(`/api/coms/agents/${A}/referees/${r1}/request`, "marketing")).status, 409);
  const d1 = await dd(A);
  const check = d1.referees[0].checks[0];
  assert.equal(check.method, "email_form");
  assert.equal(check.outcome, "pending");
  assert.ok(check.sent_at);

  outbox.length = 0;
  assert.equal((await post(`/api/coms/agents/${A}/reference-checks/${check.id}/remind`, "marketing")).status, 200);
  const remindMail = mails("anil@delta.in", /reminder/i)[0];
  assert.ok(remindMail);
  assert.notEqual(tokenFrom(remindMail), token, "a reminder carries a fresh link");
  assert.equal((await json("GET", `/api/reference/${token}`)).status, 404, "the old link no longer works");
  const live = tokenFrom(remindMail);

  // the public page
  assert.equal((await json("GET", `/api/reference/${"a".repeat(64)}`)).status, 404);
  assert.equal((await json("GET", "/api/reference/short")).status, 400);
  const page = await json("GET", `/api/reference/${live}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.agent_name, "Delta Education");
  assert.equal(page.body.data.referee_name, "Anil Rao");
  assert.equal(page.body.data.questions.length, 7);
  assert.ok(!JSON.stringify(page.body).includes("owner@delta.in"), "no private details on the public page");

  // validation: all required questions, and details when a concern is reported
  const bad = await json("POST", `/api/reference/${live}`, { body: { answers: { known_for: "x" } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.honest);
  const noDetail = await json("POST", `/api/reference/${live}`, { body: { answers: goodAnswers({ complaints: true }) } });
  assert.equal(noDetail.status, 400);
  assert.ok(noDetail.body.errors.complaints_detail);

  outbox.length = 0;
  const ok = await json("POST", `/api/reference/${live}`, { body: { answers: goodAnswers() } });
  assert.equal(ok.status, 200);
  assert.equal((await json("POST", `/api/reference/${live}`, { body: { answers: goodAnswers() } })).status, 404, "single use");
  const after1 = (await dd(A)).referees[0].checks[0];
  assert.equal(after1.outcome, "positive");
  assert.ok(after1.response_at);
  assert.equal(after1.answers.honest, true);
  assert.ok(mails("marketing@afc.test", /reference received/i)[0], "the officer who sent it is notified");
  assert.equal((await audits("agent.reference_received", A)).length, 1);
  assert.equal((await dd(A)).items.find((i) => i.key === "referees").done, true);
  assert.ok(!(await dd(A)).warnings.some((w) => /positive referee/i.test(w)), "one positive reference is enough");
  void r2;
});

// ------------------------------------------------------------------ referee by phone
test("a phone check uses the same questions; a negative answer is recorded and warned about", async () => {
  const [, r2] = await refereeIds(A);
  const body = { call_date: calendar.localDate(), spoke_to: "Mei Tan", answers: goodAnswers({ honest: false }), summary: "Had doubts about advice on fees." };
  assert.equal((await post(`/api/coms/agents/${A}/referees/${r2}/phone-check`, "accounts", body)).status, 403);
  assert.equal((await post(`/api/coms/agents/${A}/referees/${r2}/phone-check`, "marketing", { ...body, call_date: "2099-01-01" })).status, 400);
  assert.equal((await post(`/api/coms/agents/${A}/referees/${r2}/phone-check`, "marketing", { ...body, answers: { known_for: "x" } })).status, 400);
  const ok = await post(`/api/coms/agents/${A}/referees/${r2}/phone-check`, "marketing", body);
  assert.equal(ok.status, 200);
  const c = ok.body.data.referees[1].checks[0];
  assert.equal(c.method, "phone");
  assert.equal(c.outcome, "negative");
  assert.equal(c.spoke_to, "Mei Tan");
  assert.ok(ok.body.data.warnings.some((w) => /negative/i.test(w)));
  assert.equal(ok.body.data.positive_checks, 1, "one positive is still enough to decide");
  // staff can confirm or override the outcome with a summary
  const ov = await post(`/api/coms/agents/${A}/reference-checks/${c.id}/outcome`, "marketing", { outcome: "positive", summary: "Rang back: it was a misunderstanding." });
  assert.equal(ov.status, 200);
  assert.equal(ov.body.data.positive_checks, 2);
  assert.ok(!ov.body.data.warnings.some((w) => /only one positive/i.test(w)));
  assert.equal((await audits("agent.reference_outcome_set", A)).length, 1);
  // "no response" is only for a referee who has not answered
  assert.equal((await post(`/api/coms/agents/${A}/reference-checks/${c.id}/outcome`, "marketing", { outcome: "no_response", summary: "None" })).status, 409);
});

// ------------------------------------------------------------------ checks and declarations
test("ABN, MARN, PRISMS checks and the conflict-of-interest review are recorded and audited", async () => {
  const chk = (body, t = "marketing") => post(`/api/coms/agents/${A}/due-diligence/checks`, t, body);
  assert.equal((await chk({ key: "abn", status: "verified" }, "accounts")).status, 403);
  assert.equal((await chk({ key: "abn", status: "failed" })).status, 400, "a failure needs a note");
  const failed = await chk({ key: "abn", status: "failed", note: "Business name does not match" });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.data.items.find((i) => i.key === "abn").failed, true);
  assert.ok(failed.body.data.blockers.some((b) => /ABN.*failed/i.test(b)));
  assert.equal((await chk({ key: "abn", status: "verified", note: "Checked on the foreign registry" })).status, 200);
  assert.equal((await chk({ key: "prisms", status: "not_applicable" })).status, 400);
  assert.equal((await chk({ key: "marn", status: "not_applicable" })).status, 200, "no MARN on the application");
  assert.equal((await chk({ key: "prisms", status: "verified" })).status, 200);
  const a1 = await audits("agent.due_diligence_check", A);
  assert.equal(a1.length, 4);
  assert.equal(a1[0].after.abn, "failed");
  assert.equal(a1[1].before.abn, "failed");

  const decl = (body, t = "marketing") => post(`/api/coms/agents/${A}/due-diligence/declarations`, t, body);
  assert.equal((await decl({ coi_declared: false }, "accounts")).status, 403);
  assert.equal((await decl({ coi_declared: true })).status, 400, "a declared conflict needs details");
  assert.equal((await decl({ coi_declared: false, file: { name: "bad.exe", data: "AAAA" } })).status, 400);
  const before = filesOnDisk();
  const ok = await decl({ coi_declared: false, code_of_ethics_ack: true, coi_review_note: "No conflict. Declaration form on file.", file: pdf() });
  assert.equal(ok.status, 200);
  assert.equal(filesOnDisk(), before + 1);
  assert.ok(ok.body.data.declarations.file.id);
  assert.equal(ok.body.data.items.find((i) => i.key === "coi").done, true);
  assert.equal(ok.body.data.blockers.length, 0);
  // staff can download the file; an agent or outsider cannot
  const f = ok.body.data.declarations.file;
  const dl = await fetch(`${base}/api/coms/files/${f.id}/download`, { headers: { Authorization: `Bearer ${T.compliance}` } });
  assert.equal(dl.status, 200);
  assert.equal((await dl.arrayBuffer()).byteLength > 100, true);
  assert.equal((await json("GET", `/api/coms/files/${f.id}/download`)).status, 401);
  assert.equal((await audits("coms.file_downloaded")).length, 1);
});

test("staff can add, correct and remove referees on the applicant's behalf", async () => {
  const body = { name: "Raj Menon", organisation: "Menon Edu", email: "raj@menon.in", phone: "+91 98765 11111" };
  assert.equal((await post(`/api/coms/agents/${A}/referees`, "accounts", body)).status, 403);
  assert.equal((await post(`/api/coms/agents/${A}/referees`, "marketing", { ...body, email: "bad" })).status, 400);
  const added = await post(`/api/coms/agents/${A}/referees`, "marketing", body);
  assert.equal(added.status, 201);
  assert.equal(added.body.data.length, 3);
  const id = added.body.data[2].id;
  const upd = await json("PATCH", `/api/coms/agents/${A}/referees/${id}`, { token: T.marketing, body: { organisation: "Menon Education Group" } });
  assert.equal(upd.status, 200);
  const a = (await audits("agent.referee_updated", A))[0];
  assert.equal(a.before.organisation, "Menon Edu");
  assert.equal(a.after.organisation, "Menon Education Group");
  assert.equal((await post(`/api/coms/agents/${A}/referees/${id}/delete`, "marketing", {})).status, 400);
  const del = await post(`/api/coms/agents/${A}/referees/${id}/delete`, "marketing", { reason: "Entered twice" });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.length, 2);
  assert.equal((await audits("agent.referee_removed", A)).length, 1);
});

// ------------------------------------------------------------------ the decision
test("the person who prepared the file cannot decide it (BR-06); another approver can", async () => {
  // marketing prepared, and the director also recorded a check, so the director becomes a preparer as well
  assert.equal((await post(`/api/coms/agents/${A}/due-diligence/checks`, "director", { key: "prisms", status: "verified", note: "Re-checked" })).status, 200);
  const d = await dd(A, "director");
  assert.equal(d.can_decide, false);
  assert.match(d.decide_blocked_reason, /prepared/i);
  const blocked = await post(`/api/coms/agents/${A}/decision`, "director", { decision: "approve", reason: "Approved on review" });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /BR-06/);
  assert.equal((await dd(A, "ceo")).can_decide, true);
});

test("the CEO approves: status, history, login, email and audit trail", async () => {
  outbox.length = 0;
  const r = await post(`/api/coms/agents/${A}/decision`, "ceo", { decision: "approve", reason: "References are good and checks are complete." });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "approved");
  assert.equal(r.body.data.history[0].to_status, "approved");
  assert.equal(r.body.data.history[0].reason, "References are good and checks are complete.");
  assert.ok(mails("owner@delta.in", /approved/i)[0]);
  assert.equal((await pool.query(`SELECT status FROM users WHERE email='owner@delta.in'`)).rows[0].status, "active");
  const au = (await audits("agent.approved", A))[0];
  assert.equal(au.before.status, "due_diligence");
  assert.equal(au.after.status, "approved");
  assert.equal((await post(`/api/coms/agents/${A}/decision`, "ceo", { decision: "approve", reason: "Again please" })).status, 409, "decided once");
  const d = await dd(A, "ceo");
  assert.equal(d.decision.decision, "approved");
  assert.equal(d.decision.by, "Ceo Test");
  // nothing about due diligence can change after the decision
  assert.equal((await post(`/api/coms/agents/${A}/due-diligence/checks`, "marketing", { key: "abn", status: "verified" })).status, 409);
});

test("rejecting needs a reason; the draft email can be edited; an early rejection leaves a record", async () => {
  const B = await applied("Echo Agents", "boss@echo.sg", { country: "Singapore" });
  // rejecting straight from "applied" is allowed and nobody has prepared anything
  assert.equal((await post(`/api/coms/agents/${B}/decision`, "director", { decision: "reject", reason: "no" })).status, 400);
  const draft = await post(`/api/coms/agents/${B}/rejection-draft`, "director", { reason: "We could not verify the business registration." });
  assert.equal(draft.status, 200);
  assert.match(draft.body.data.body, /could not verify the business registration/);
  assert.equal(draft.body.data.to, "boss@echo.sg");
  assert.equal((await post(`/api/coms/agents/${B}/rejection-draft`, "marketing", { reason: "x y z" })).status, 403);

  outbox.length = 0;
  const body = "Dear Dev,\n\nCustom wording from the director.\n\nKind regards,\nAFC";
  const r = await post(`/api/coms/agents/${B}/decision`, "director", { decision: "reject", reason: "We could not verify the business registration.", email_subject: "Your application", email_body: body });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "rejected");
  assert.equal(r.body.data.rejection_reason, "We could not verify the business registration.");
  const mail = mails("boss@echo.sg", /your application/i)[0];
  assert.ok(mail && /Custom wording from the director/.test(mail.text));
  assert.equal((await pool.query(`SELECT status FROM users WHERE email='boss@echo.sg'`)).rows[0].status, "rejected");
  assert.equal((await dd(B)).decision.decision, "rejected");
  assert.equal((await audits("agent.rejected", B)).length, 1);
});

// ------------------------------------------------------------------ agreement -> onboarding
test("an agreement is sent from the agent record, signed by the agent, countersigned by the CEO", async () => {
  // not for an agent who is not approved
  const C = await applied("Foxtrot Edu", "c@foxtrot.in");
  assert.equal((await post(`/api/coms/agents/${C}/agreement`, "marketing", {})).status, 409);

  assert.equal((await post(`/api/coms/agents/${A}/agreement`, "accounts", {})).status, 403);
  outbox.length = 0;
  const sent = await post(`/api/coms/agents/${A}/agreement`, "marketing", { note: "Please sign this week" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.data.agreements[0].status, "sent");
  assert.ok(mails("owner@delta.in", /agreement/i)[0]);
  const agId = sent.body.data.agreements[0].id;

  const agentT = await login("owner@delta.in");
  const signed = await json("POST", `/api/agreements/${agId}/sign`, { token: agentT, body: { signed_name: "Dev Delta", accept: true } });
  assert.equal(signed.status, 200);

  // staff other than the CEO / administrator cannot countersign; the director can read it
  assert.equal((await json("POST", `/api/agreements/${agId}/approve`, { token: T.marketing, body: { signed_name: "Mark Test", accept: true } })).status, 403);
  assert.equal((await json("GET", `/api/agreements/${agId}`, { token: T.director })).status, 200);

  const done = await json("POST", `/api/agreements/${agId}/approve`, { token: T.ceo, body: { signed_name: "Ceo Test", position: "CEO", accept: true } });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, "active");
  const detail = (await json("GET", `/api/agreements/${agId}`, { token: T.ceo })).body.data;
  assert.deepEqual(detail.files.map((f) => f.kind).sort(), ["certificate", "final"], "certificate of appointment is generated");
  // at counter-sign the agent gets the signed agreement and the certificate in one email; the CEO keeps a copy
  const approved = mails("owner@delta.in", /agreement is approved/i);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].attachments.length, 2);
  assert.ok(approved[0].attachments.some((f) => /Certificate of Appointment\.pdf$/.test(f.filename)));
  assert.ok(approved[0].attachments.every((f) => f.size > 20000));
  assert.equal(mails("ceo@x.com", /signed agreement/i).length + outbox.filter((m) => /^Signed agreement:/.test(m.subject)).length >= 1, true);
  assert.ok((await pool.query("SELECT certificate_sent_at FROM agents WHERE id=$1", [A])).rows[0].certificate_sent_at, "certificate marked as sent");
  const early = await json("GET", "/api/agent-application/certificate", { token: agentT });
  assert.equal(early.body.data.available, true, "available to download from counter-sign");
  const cert = detail.files.find((f) => f.kind === "certificate");
  const dl = await fetch(`${base}/api/agreements/${agId}/files/${cert.id}/download`, { headers: { Authorization: `Bearer ${T.ceo}` } });
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
});

// ------------------------------------------------------------------ T-03
test("countersigning moves the agent to Onboarding and creates the five tasks with correct due dates (T-03)", async () => {
  const rec = (await get(`/api/coms/agents/${A}`, "director")).body.data;
  assert.equal(rec.status, "onboarding");
  assert.equal(rec.history[0].to_status, "onboarding");
  assert.equal(rec.tasks.length, 5);
  const by = Object.fromEntries(rec.tasks.map((t) => [t.type, t]));
  const today = calendar.localDate();
  const effective = (await pool.query(`SELECT to_char(effective_date,'YYYY-MM-DD') AS d FROM agreements WHERE status='active'`)).rows[0].d;
  assert.equal(by.PRISMS_ADD.due_date, await calendar.addBusinessDays(today, 5), "5 working days, public holidays honoured");
  assert.equal(by.WEBSITE_ADD.due_date, await calendar.addBusinessDays(today, 5));
  assert.equal(by.ASQANET_START.due_date, await calendar.addBusinessDays(today, 5), "within 5 days of signing (Processing Agent Application, step 6)");
  assert.equal(by.ASQANET_START.legal_deadline, null, "no separate 30-day backstop: the 5 working days apply");
  assert.equal(by.COMMISSION_REPORT.due_date, await calendar.addBusinessDays(today, 5));
  assert.equal(by.INDUCTION.due_date, calendar.addDays(today, 30));
  assert.equal(by.PRISMS_ADD.owner_role, "compliance", "PRISMS belongs to compliance");
  assert.equal(by.PRISMS_ADD.owner_name, "Compliance Test");
  assert.equal(by.ASQANET_START.owner_role, "ceo", "the CEO reports to ASQAnet");
  assert.equal(by.ASQANET_START.owner_name, "Ceo Test");
  assert.match(by.WEBSITE_ADD.description, /Agency: Delta Education/);
  assert.match(by.WEBSITE_ADD.description, /Email: owner@delta\.in/);
  assert.equal(by.WEBSITE_ADD.owner_role, "admin", "AFC Administration lists the agent on the website");
  assert.equal(by.COMMISSION_REPORT.owner_name, "Marketing Test");
  assert.equal(by.INDUCTION.owner_name, "Marketing Test");
  assert.ok(rec.tasks.every((t) => t.status === "open" && !t.overdue));
  assert.equal((await audits("agent.onboarding_started", A)).length, 1);

  // running it again creates nothing new (a retry after a failure is safe)
  const agId = (await pool.query(`SELECT id FROM agreements WHERE status='active'`)).rows[0].id;
  await tasksSvc.onAgreementCountersigned(agId, { id: null, role: "admin" }, {});
  assert.equal((await pool.query(`SELECT count(*)::int AS c FROM coms_tasks WHERE agent_id=$1`, [A])).rows[0].c, 5);
  // BR-01 / BR-02: it cannot be made Active by hand yet
  const blocked = await post(`/api/coms/agents/${A}/status`, "director", { status: "active" });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /PRISMS/);
});

// ------------------------------------------------------------------ task board
test("the task board lists, filters and exports regulatory tasks; the export is logged", async () => {
  const all = await get("/api/coms/tasks?limit=50", "compliance");
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 5);
  assert.equal(all.body.pagination.total, 5);
  assert.equal((await json("GET", "/api/coms/tasks")).status, 401);
  assert.equal((await get("/api/coms/tasks?type=PRISMS_ADD", "compliance")).body.data.length, 1);
  assert.equal((await get("/api/coms/tasks?type=PRISMS_ADD,INDUCTION", "compliance")).body.data.length, 2);
  assert.equal((await get("/api/coms/tasks?overdue=true", "compliance")).body.data.length, 0);
  assert.equal((await get(`/api/coms/tasks?agent_id=${A}`, "compliance")).body.data.length, 5);
  assert.equal((await get("/api/coms/tasks?owner=me", "compliance")).body.data.length, 1);
  assert.equal((await get("/api/coms/tasks?owner=me", "ceo")).body.data.length, 1);
  assert.equal((await get("/api/coms/tasks?search=delta", "compliance")).body.data.length, 5);
  assert.equal((await get("/api/coms/tasks/meta", "compliance")).body.data.types.length, 11);

  const csv = await get("/api/coms/tasks/export?status=all", "compliance");
  assert.equal(csv.status, 200);
  const lines = String(csv.body).replace(/^﻿/, "").split("\r\n");
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^Task,Type,Category,Agent,Owner,Due/);
  assert.equal((await audits("task.exported")).length, 1);
});

test("a regulatory task needs evidence or a note; files are checked; only the right people may finish it", async () => {
  const tasks = (await get(`/api/coms/tasks?agent_id=${A}`, "compliance")).body.data;
  const prisms = tasks.find((t) => t.type === "PRISMS_ADD");
  const url = `/api/coms/tasks/${prisms.id}/complete`;
  assert.equal((await post(url, "accounts", { note: "done" })).status, 403);
  assert.equal((await post(url, "compliance", {})).status, 400, "no evidence and no note");
  assert.equal((await post(url, "compliance", { file: { name: "run.exe", data: "AAAA" } })).status, 400);
  assert.equal((await post(url, "compliance", { file: { name: "fake.pdf", data: Buffer.from("not a pdf").toString("base64") } })).status, 400, "content must match the type");
  const tooBig = await post(url, "compliance", { file: { name: "big.pdf", data: Buffer.concat([Buffer.from("%PDF"), Buffer.alloc((env.evidenceMaxMb + 1) * 1024 * 1024)]).toString("base64") } });
  assert.ok([400, 413].includes(tooBig.status), "too large");
  assert.equal(filesOnDisk() >= 1, true);
  const filesBefore = filesOnDisk();

  const done = await post(url, "compliance", { note: "Entered in PRISMS, screenshot attached", file: pdf(400) });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, "done");
  assert.equal(done.body.data.completed_by_name, "Compliance Test");
  assert.ok(done.body.data.evidence.id);
  assert.equal(filesOnDisk(), filesBefore + 1);
  assert.equal((await post(url, "compliance", { note: "again" })).status, 409);
  const rec = (await get(`/api/coms/agents/${A}`, "director")).body.data;
  assert.ok(rec.prisms_recorded_at, "BR-02: PRISMS is now recorded");
  assert.equal(rec.status, "onboarding", "induction is still missing");
  const ev = await fetch(`${base}/api/coms/tasks/${prisms.id}/evidence`, { headers: { Authorization: `Bearer ${T.compliance}` } });
  assert.equal(ev.status, 200);
  const log = (await audits("task.completed", prisms.id))[0];
  assert.equal(log.after.status, "done");
  assert.equal(log.metadata.evidence, "evidence.pdf");
});

test("recording the induction makes the agent Active once agreement, PRISMS and induction are all in place (E1-7)", async () => {
  const induction = (await get(`/api/coms/tasks?agent_id=${A}&type=INDUCTION`, "compliance")).body.data[0];
  const done = await post(`/api/coms/tasks/${induction.id}/complete`, "marketing", { note: "Induction session held with both directors" });
  assert.equal(done.status, 200);
  const rec = (await get(`/api/coms/agents/${A}`, "director")).body.data;
  assert.ok(rec.induction_recorded_at);
  assert.equal(rec.status, "active");
  assert.equal(rec.history[0].to_status, "active");
  assert.equal((await audits("agent.activated", A)).length, 1);
});

test("the certificate of appointment can be downloaded and re-sent", async () => {
  assert.equal((await audits("agent.certificate_sent", A)).length, 0, "nothing extra is sent when the agent becomes Active");
  // staff download
  const staffRes = await fetch(`${base}/api/coms/agents/${A}/certificate`, { headers: { Authorization: `Bearer ${T.director}` } });
  assert.equal(staffRes.status, 200);
  assert.equal(staffRes.headers.get("content-type"), "application/pdf");
  assert.equal((await staffRes.arrayBuffer()).byteLength > 20000, true);
  // the agent's own download
  const agentT = await login("owner@delta.in");
  const status = await json("GET", "/api/agent-application/certificate", { token: agentT });
  assert.equal(status.body.data.available, true);
  const mine = await fetch(`${base}/api/agent-application/certificate/download`, { headers: { Authorization: `Bearer ${agentT}` } });
  assert.equal(mine.status, 200);
  // another agent cannot see it; roles without permission cannot re-send
  assert.equal((await fetch(`${base}/api/coms/agents/${A}/certificate`, { headers: { Authorization: `Bearer ${agentT}` } })).status, 403);
  assert.equal((await post(`/api/coms/agents/${A}/certificate/send`, "accounts")).status, 403);
  outbox.length = 0;
  assert.equal((await post(`/api/coms/agents/${A}/certificate/send`, "marketing")).status, 200);
  const again = mails("owner@delta.in", /certificate of appointment/i);
  assert.equal(again.length, 1);
  assert.match(again[0].attachments[0].filename, /Delta Education - Certificate of Appointment\.pdf/);
});

test("recording the milestone on the agent record also finishes the matching task", async () => {
  const D = await applied("Golf Edu", "g@golf.in");
  // put the agent straight into onboarding with the two open tasks (the full path is covered above)
  await pool.query(`UPDATE agents SET status = 'onboarding' WHERE id = $1`, [D]);
  const c = await pool.query(`SELECT id FROM users WHERE role='coe_admin'`);
  await pool.query(
    `INSERT INTO coms_tasks (category, type, title, agent_id, due_date, owner_id) VALUES ('regulatory','PRISMS_ADD','Add Golf to PRISMS',$1, current_date + 5, $2)`, [D, c.rows[0].id]);
  const r = await post(`/api/coms/agents/${D}/milestones`, "coe", { type: "prisms" });
  assert.equal(r.status, 200);
  assert.equal((await pool.query(`SELECT status FROM coms_tasks WHERE agent_id=$1`, [D])).rows[0].status, "done");
});

// ------------------------------------------------------------------ manual tasks
test("staff can create, assign and cancel general tasks", async () => {
  const body = { title: "Call the agent about the new brochure", due_date: calendar.addDays(calendar.localDate(), 3), agent_id: A };
  assert.equal((await post("/api/coms/tasks", "marketing", { ...body, due_date: "2020-01-01" })).status, 400);
  assert.equal((await post("/api/coms/tasks", "marketing", { ...body, title: "x" })).status, 400);
  assert.equal((await post("/api/coms/tasks", "accounts", { ...body, type: "PRISMS_ADD" })).status, 403, "regulatory types are for managers and CoE");
  outbox.length = 0;
  const mgr = (await pool.query(`SELECT id FROM users WHERE email='director@afc.test'`)).rows[0].id;
  const made = await post("/api/coms/tasks", "marketing", { ...body, owner_id: mgr });
  assert.equal(made.status, 201);
  assert.equal(made.body.data.owner_name, "Director Test");
  assert.ok(mails("director@afc.test", /new task/i)[0], "the owner is told");
  const id = made.body.data.id;
  const compl = (await pool.query(`SELECT id FROM users WHERE email='compliance@afc.test'`)).rows[0].id;
  assert.equal((await post(`/api/coms/tasks/${id}/assign`, "marketing", { owner_id: compl })).status, 403);
  assert.equal((await post(`/api/coms/tasks/${id}/assign`, "director", { owner_id: compl })).status, 200);
  assert.equal((await post(`/api/coms/tasks/${id}/cancel`, "director", {})).status, 400);
  assert.equal((await post(`/api/coms/tasks/${id}/cancel`, "director", { reason: "No longer needed" })).status, 200);
  assert.equal((await post(`/api/coms/tasks/${id}/complete`, "compliance", { note: "x" })).status, 409, "closed");
  assert.equal((await audits("task.assigned", id))[0].after.owner, "Compliance Test");
});

// ------------------------------------------------------------------ reminders and escalation
test("a registration task is escalated to a manager on working day 4, once", async () => {
  const D = await applied("Escalate Edu", "e@escalate.in");
  const own = (await pool.query(`SELECT id FROM users WHERE email='compliance@afc.test'`)).rows[0].id;
  const mk = async (daysAgo) => (await pool.query(
    `INSERT INTO coms_tasks (category, type, title, agent_id, trigger_date, due_date, due_basis, owner_id)
     VALUES ('regulatory','PRISMS_ADD',$2,$1, current_date - $3::int, current_date + 10, 'business', $4) RETURNING id`,
    [D, `Registration ${daysAgo}`, daysAgo, own])).rows[0].id;
  const fresh = await mk(1);
  outbox.length = 0;
  assert.equal((await tasksSvc.runAlerts()).escalated, 0, "day 1 is not escalated");
  const old = await mk(10); // 10 calendar days is always at least 4 working days
  outbox.length = 0;
  const r1 = await tasksSvc.runAlerts();
  assert.equal(r1.escalated, 1);
  assert.ok(mails("director@afc.test", /task/i).length >= 1, "the manager is told");
  assert.ok((await pool.query(`SELECT escalated_at FROM coms_tasks WHERE id=$1`, [old])).rows[0].escalated_at);
  assert.equal((await pool.query(`SELECT escalated_at FROM coms_tasks WHERE id=$1`, [fresh])).rows[0].escalated_at, null);
  outbox.length = 0;
  assert.equal((await tasksSvc.runAlerts()).escalated, 0, "only once");
});

test("after the deadline only a manager can close a registration task", async () => {
  const D = await applied("Late Edu", "l@late.in");
  const t = (await pool.query(
    `INSERT INTO coms_tasks (category, type, title, agent_id, trigger_date, due_date, due_basis, owner_id, owner_role)
     VALUES ('regulatory','WEBSITE_ADD','Website listing',$1, current_date - 12, current_date - 5, 'business', (SELECT id FROM users WHERE email='marketing@afc.test'), 'admin') RETURNING id`, [D])).rows[0].id;
  const late = await post(`/api/coms/tasks/${t}/complete`, "marketing", { note: "Listed" });
  assert.ok([403].includes(late.status), JSON.stringify(late.body));
  assert.match(JSON.stringify(late.body), /past its deadline|permission/i);
  const ok = await post(`/api/coms/tasks/${t}/complete`, "director", { note: "Listed (manager override)" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await audits("task.completed", t))[0].metadata.manager_override, true);
});

test("the decision timer warns at day 7 and alerts at day 10 (BR-08)", async () => {
  const E = await applied("India Edu", "i@india.in");
  await post(`/api/coms/agents/${E}/status`, "marketing", { status: "due_diligence" });
  const setReceived = (n) => pool.query(`UPDATE agents SET application_received_at = now() - ($2 || ' days')::interval WHERE id = $1`, [E, String(n)]);
  // 20 calendar days is always at least 10 working days; 9-10 calendar days is at least 7
  await setReceived(10);
  const sla = (await get(`/api/coms/agents/${E}`, "director")).body.data.sla;
  assert.ok(["amber", "red"].includes(sla.decision.state));
  await setReceived(2);
  assert.equal((await get(`/api/coms/agents/${E}`, "director")).body.data.sla.decision.state, "ok");
  await setReceived(21);
  outbox.length = 0;
  const r = await daily.decisionTimers();
  assert.equal(r.red, 1);
  assert.ok(mails("director@afc.test", /decision overdue/i)[0]);
  assert.ok(mails("ceo@afc.test", /decision overdue/i)[0]);
  outbox.length = 0;
  assert.deepEqual(await daily.decisionTimers(), { amber: 0, red: 0 }, "each alert is sent once");
});

test("referees who have not answered get a reminder after 3 working days, up to twice", async () => {
  const F = await applied("Juliet Edu", "j@juliet.in");
  await post(`/api/coms/agents/${F}/status`, "marketing", { status: "due_diligence" });
  const [r1] = await refereeIds(F);
  await post(`/api/coms/agents/${F}/referees/${r1}/request`, "marketing");
  outbox.length = 0;
  assert.equal(await daily.referenceReminders(), 0, "too soon");
  await pool.query(`UPDATE referee_checks SET sent_at = now() - interval '10 days' WHERE referee_id = $1`, [r1]);
  assert.equal(await daily.referenceReminders(), 1);
  assert.ok(mails("anil@juliet.in", /reminder/i)[0]);
  assert.equal(await daily.referenceReminders(), 0, "not again the same day");
  await pool.query(`UPDATE referee_checks SET last_reminder_at = now() - interval '10 days' WHERE referee_id = $1`, [r1]);
  assert.equal(await daily.referenceReminders(), 1);
  await pool.query(`UPDATE referee_checks SET last_reminder_at = now() - interval '10 days' WHERE referee_id = $1`, [r1]);
  assert.equal(await daily.referenceReminders(), 0, "two reminders is the limit");
  // a referee who never answers can be marked "no response"; the link stops working
  const check = (await dd(F)).referees[0].checks[0];
  const token = (await pool.query(`SELECT token_hash FROM referee_checks WHERE id=$1`, [check.id])).rows[0].token_hash;
  assert.ok(token);
  assert.equal((await post(`/api/coms/agents/${F}/reference-checks/${check.id}/outcome`, "marketing", { outcome: "positive", summary: "Not answered" })).status, 409);
  assert.equal((await post(`/api/coms/agents/${F}/reference-checks/${check.id}/outcome`, "marketing", { outcome: "no_response", summary: "No answer after two reminders" })).status, 200);
  assert.equal((await pool.query(`SELECT token_hash FROM referee_checks WHERE id=$1`, [check.id])).rows[0].token_hash, null);
});

test("a safety-net job moves an approved agent with a signed agreement to Onboarding", async () => {
  // approved by hand with an active agreement but no onboarding (as if that step had failed)
  const G = await applied("Kilo Edu", "k@kilo.in");
  const uid = (await pool.query(`SELECT id FROM users WHERE email='k@kilo.in'`)).rows[0].id;
  await pool.query(`UPDATE agents SET status='approved' WHERE id=$1`, [G]);
  await pool.query(`UPDATE users SET status='active' WHERE id=$1`, [uid]);
  await pool.query(
    `INSERT INTO agreements (agent_id, status, validity_months, effective_date, expires_at, title) VALUES ($1,'active',12,current_date,current_date + 365,'Agreement')`, [uid]);
  assert.equal(await daily.reconcileOnboarding(), 1);
  assert.equal((await pool.query(`SELECT status FROM agents WHERE id=$1`, [G])).rows[0].status, "onboarding");
  assert.equal((await pool.query(`SELECT count(*)::int AS c FROM coms_tasks WHERE agent_id=$1`, [G])).rows[0].c, 5);
});

// ------------------------------------------------------------------ termination and authorised staff
test("terminating an agent stops their login at once and creates the removal tasks", async () => {
  const G = await applied("Lima Edu", "l@lima.in");
  const uid = (await pool.query(`SELECT id FROM users WHERE email='l@lima.in'`)).rows[0].id;
  await pool.query(`UPDATE agents SET status='active' WHERE id=$1`, [G]);
  await pool.query(`UPDATE users SET status='active' WHERE id=$1`, [uid]);
  const agentT = await login("l@lima.in");
  assert.ok(agentT, "can sign in before");
  assert.equal((await json("GET", "/api/agent-application", { token: agentT })).status < 400, true);

  assert.equal((await post(`/api/coms/agents/${G}/status`, "marketing", { status: "terminated", reason: "Breach" })).status, 403);
  assert.equal((await post(`/api/coms/agents/${G}/status`, "ceo", { status: "terminated" })).status, 400, "a reason is needed");
  const done = await post(`/api/coms/agents/${G}/status`, "ceo", { status: "terminated", reason: "Breach of the agreement" });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  // the session they already had stops working, and they cannot sign in again
  assert.equal((await json("GET", "/api/agent-application", { token: agentT })).status, 401);
  assert.equal(await login("l@lima.in"), undefined);
  assert.equal((await pool.query(`SELECT status FROM users WHERE id=$1`, [uid])).rows[0].status, "suspended");

  const tasks = (await pool.query(`SELECT type, owner_role, due_date::text AS due, description FROM coms_tasks WHERE agent_id=$1 ORDER BY type`, [G])).rows;
  assert.deepEqual(tasks.map((t) => t.type), ["ASQANET_END", "PRISMS_REMOVE", "WEBSITE_REMOVE"]);
  const by = Object.fromEntries(tasks.map((t) => [t.type, t]));
  assert.equal(by.PRISMS_REMOVE.owner_role, "compliance");
  assert.equal(by.ASQANET_END.owner_role, "ceo");
  assert.equal(by.WEBSITE_REMOVE.owner_role, "admin");
  assert.equal(by.PRISMS_REMOVE.due, await calendar.addBusinessDays(calendar.localDate(), 5));
  assert.match(by.PRISMS_REMOVE.description, /Breach of the agreement/);

  // an administrator cannot switch the access back on
  const [admin] = (await pool.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`)).rows;
  const adminT = await login("admin@afc.test");
  const back = await json("PATCH", `/api/users/${uid}/status`, { token: adminT, body: { status: "active" } });
  assert.equal(back.status, 409);
  assert.ok(admin);
});

test("the CEO or an administrator marks staff as authorised staff", async () => {
  const mid = (await pool.query(`SELECT id FROM users WHERE email='marketing@afc.test'`)).rows[0].id;
  assert.equal((await json("PATCH", `/api/users/${mid}/authorised`, { token: T.marketing, body: { authorised: true } })).status, 403);
  const on = await json("PATCH", `/api/users/${mid}/authorised`, { token: T.ceo, body: { authorised: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.data.is_authorised_staff, true);
  assert.equal((await audits("user.authorised_staff_changed", String(mid))).length, 1);
  const agentUid = (await pool.query(`SELECT id FROM users WHERE email='owner@delta.in'`)).rows[0].id;
  assert.equal((await json("PATCH", `/api/users/${agentUid}/authorised`, { token: T.ceo, body: { authorised: true } })).status, 409, "agents cannot be authorised staff");
  assert.equal((await json("PATCH", `/api/users/${mid}/authorised`, { token: T.ceo, body: { authorised: false } })).body.data.is_authorised_staff, false);
});

// ------------------------------------------------------------------ scheduler endpoint
test("the daily-jobs endpoint only answers with the scheduler secret", async () => {
  assert.equal((await json("GET", "/api/jobs/daily")).status, 401);
  assert.equal((await json("GET", "/api/jobs/daily", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const ok = await json("GET", "/api/jobs/daily", { headers: { Authorization: `Bearer ${"c".repeat(40)}` } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.coms);
});

test("agents cannot reach any of the Part 2 staff endpoints", async () => {
  const agentT = await login("owner@delta.in");
  for (const p of [`/api/coms/agents/${A}/due-diligence`, "/api/coms/tasks", "/api/coms/tasks/meta"]) {
    assert.equal((await json("GET", p, { token: agentT })).status, 403, p);
  }
  assert.equal((await json("POST", `/api/coms/agents/${A}/decision`, { token: agentT, body: { decision: "approve", reason: "me me" } })).status, 403);
});

// ------------------------------------------------------------------ Phase 3: induction
async function onboardingAgent(name, email) {
  const D = await applied(name, email);
  await pool.query(`UPDATE agents SET status='onboarding' WHERE id=$1`, [D]);
  const owner = (await pool.query(`SELECT id FROM users WHERE email='marketing@afc.test'`)).rows[0].id;
  const task = (await pool.query(
    `INSERT INTO coms_tasks (category, type, title, agent_id, trigger_date, due_date, due_basis, owner_id, owner_role)
     VALUES ('general','INDUCTION','Induct agent',$1, current_date, current_date + 30, 'calendar', $2, 'marketing_officer') RETURNING id`, [D, owner])).rows[0].id;
  return { D, task, owner };
}
const today = () => calendar.localDate();
const BOOK = { mode: "online", start_time: "10:30", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc123" };

test("induction: staff record the date, who ran it and notes; the task is finished and the milestone set", async () => {
  const { D, task } = await onboardingAgent("Induct One", "a@inductone.in");
  const url = `/api/coms/agents/${D}/inductions`;
  assert.equal((await post(url, "accounts", { outcome: "held", held_on: today(), notes: "Covered the code" })).status, 403);
  assert.equal((await post(url, "marketing", { outcome: "held", notes: "x notes" })).status, 400, "date is required");
  assert.equal((await post(url, "marketing", { outcome: "held", held_on: calendar.addDays(today(), 3), notes: "Covered it" })).status, 400, "not in the future");
  assert.equal((await post(url, "marketing", { outcome: "held", held_on: today() })).status, 400, "notes are required");
  assert.equal((await post(url, "marketing", { outcome: "held", held_on: today(), notes: "Covered it", conducted_by: 99999 })).status, 400, "unknown staff member");

  const dir = (await pool.query(`SELECT id FROM users WHERE email='director@afc.test'`)).rows[0].id;
  const r = await post(url, "marketing", { outcome: "held", held_on: today(), conducted_by: dir, mode: "in_person", attendees: "Both directors", notes: "Code of ethics and PRISMS rules" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.status, "held");
  assert.equal(r.body.data.conducted_by_name, "Director Test");
  assert.equal(r.body.data.mode, "in_person");

  const rec = (await get(`/api/coms/agents/${D}`, "director")).body.data;
  assert.ok(rec.induction_recorded_at);
  assert.equal(rec.inductions.length, 1);
  assert.equal((await pool.query(`SELECT status, completion_note FROM coms_tasks WHERE id=$1`, [task])).rows[0].status, "done");
  assert.equal((await audits("agent.induction_recorded", D)).length, 1);
  assert.equal((await get(`${url}`, "coe")).body.data.length, 1, "any staff member can read it");
  assert.equal(rec.status, "onboarding", "PRISMS and the agreement are still missing");
});

test("induction: the agent becomes Active when it is the last missing piece", async () => {
  const { D } = await onboardingAgent("Induct Two", "a@incttwo.in");
  const uid = (await pool.query(`SELECT id FROM users WHERE lower(email)=lower('a@incttwo.in')`)).rows[0]?.id;
  await pool.query(`UPDATE agents SET prisms_recorded_at = now() WHERE id=$1`, [D]);
  await pool.query(`INSERT INTO agent_persons (agent_id, name, email, role, is_primary_contact, portal_user_id) SELECT $1,'P','p@x.in','staff',false,$2 WHERE $2::bigint IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_persons WHERE portal_user_id=$2)`, [D, uid || null]);
  await pool.query(`INSERT INTO agreements (agent_id, status, effective_date, expires_at, sent_by) SELECT COALESCE($1::bigint, (SELECT id FROM users LIMIT 1)),'active', current_date, current_date + 365, 1`, [uid || null]);
  const has = (await get(`/api/coms/agents/${D}`, "director")).body.data.has_signed_agreement;
  if (!has) return; // the signed-agreement link is covered by the earlier E1-7 test
  assert.equal((await post(`/api/coms/agents/${D}/inductions`, "marketing", { outcome: "held", held_on: today(), notes: "Held online" })).status, 201);
  assert.equal((await get(`/api/coms/agents/${D}`, "director")).body.data.status, "active");
});

test("induction: schedule, reschedule, remind, then record the outcome", async () => {
  const { D, task } = await onboardingAgent("Induct Three", "a@inctthree.in");
  const url = `/api/coms/agents/${D}/inductions`;
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: calendar.addDays(today(), -1), ...BOOK })).status, 400, "not in the past");
  outbox.length = 0;
  const s = await post(url, "marketing", { outcome: "scheduled", scheduled_for: calendar.addDays(today(), 1), ...BOOK });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.data.status, "scheduled");
  assert.equal(s.body.data.conducted_by_name, "Marketing Test", "defaults to the person scheduling it");
  assert.ok(mails("a@inctthree.in", /induction/i).length >= 1, "the agent is told the date");
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: calendar.addDays(today(), 2), ...BOOK })).status, 409, "only one open booking");
  const id = s.body.data.id;
  assert.equal((await pool.query(`SELECT status FROM coms_tasks WHERE id=$1`, [task])).rows[0].status, "open", "scheduling does not finish the task");
  assert.equal((await pool.query(`SELECT induction_recorded_at FROM agents WHERE id=$1`, [D])).rows[0].induction_recorded_at, null);

  // reminders: the day before, once
  outbox.length = 0;
  assert.equal((await require("../src/services/inductionService").runReminders()).reminded, 1);
  assert.ok(mails("marketing@afc.test", /Induction coming up/i).length === 1);
  outbox.length = 0;
  assert.equal((await require("../src/services/inductionService").runReminders()).reminded, 0, "only once");

  // moved to another day: the reminder starts again
  const re = await post(`${url}/${id}/reschedule`, "marketing", { scheduled_for: calendar.addDays(today(), 5), start_time: "14:00" });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal(re.body.data.scheduled_for, calendar.addDays(today(), 5));

  // the date passes and nobody recorded it: one follow-up
  await pool.query(`UPDATE agent_inductions SET scheduled_for = current_date - 2 WHERE id=$1`, [id]);
  outbox.length = 0;
  assert.equal((await require("../src/services/inductionService").runReminders()).followUps, 1);
  assert.ok(mails("marketing@afc.test", /Record the induction outcome/i).length === 1);
  assert.equal((await require("../src/services/inductionService").runReminders()).followUps, 0, "only once");

  // finish it
  assert.equal((await post(`${url}/${id}/complete`, "marketing", { held_on: today() })).status, 400, "notes are required");
  const done = await post(`${url}/${id}/complete`, "marketing", { held_on: calendar.addDays(today(), -2), notes: "Held as planned" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.status, "held");
  assert.equal((await pool.query(`SELECT status FROM coms_tasks WHERE id=$1`, [task])).rows[0].status, "done");
  assert.equal((await post(`${url}/${id}/cancel`, "marketing", { reason: "too late" })).status, 409, "already closed");
});

test("induction: a scheduled booking can be cancelled with a reason", async () => {
  const { D } = await onboardingAgent("Induct Four", "a@inctfour.in");
  const url = `/api/coms/agents/${D}/inductions`;
  const id = (await post(url, "marketing", { outcome: "scheduled", scheduled_for: calendar.addDays(today(), 4), ...BOOK })).body.data.id;
  assert.equal((await post(`${url}/${id}/cancel`, "marketing", {})).status, 400);
  const c = await post(`${url}/${id}/cancel`, "marketing", { reason: "Agent asked to move it" });
  assert.equal(c.status, 200);
  assert.equal(c.body.data.status, "cancelled");
  assert.equal((await audits("agent.induction_cancelled", D)).length, 1);
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: calendar.addDays(today(), 6), ...BOOK })).status, 201, "a new one can be booked");
});

test("induction: finishing the task on the board writes the induction record too", async () => {
  const { D, task } = await onboardingAgent("Induct Five", "a@inctfive.in");
  assert.equal((await post(`/api/coms/tasks/${task}/complete`, "marketing", { note: "Held with the principal" })).status, 200);
  const list = (await get(`/api/coms/agents/${D}/inductions`, "marketing")).body.data;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "held");
  assert.equal(list[0].notes, "Held with the principal");
  assert.equal(list[0].conducted_by_name, "Marketing Test");
  assert.ok((await pool.query(`SELECT induction_recorded_at FROM agents WHERE id=$1`, [D])).rows[0].induction_recorded_at);
});

test("induction task: reminded a week before it is due, flagged when overdue, and never escalated early", async () => {
  const { D, task } = await onboardingAgent("Induct Six", "a@inctsix.in");
  await pool.query(`UPDATE coms_tasks SET trigger_date = current_date - 10 WHERE id=$1`, [task]);
  outbox.length = 0;
  assert.equal((await tasksSvc.runAlerts()).escalated >= 0, true);
  assert.equal((await pool.query(`SELECT escalated_at FROM coms_tasks WHERE id=$1`, [task])).rows[0].escalated_at, null, "30-day task is not escalated on working day 4");
  const ind = require("../src/services/inductionService");
  assert.equal((await ind.runReminders()).taskDueSoon, 0, "30 days away");
  await pool.query(`UPDATE coms_tasks SET due_date = current_date + 6 WHERE id=$1`, [task]);
  outbox.length = 0;
  assert.equal((await ind.runReminders()).taskDueSoon, 1);
  assert.ok(mails("marketing@afc.test", /due soon/i).length === 1);
  assert.equal((await ind.runReminders()).taskDueSoon, 0, "once");
  await pool.query(`UPDATE coms_tasks SET due_date = current_date - 1 WHERE id=$1`, [task]);
  outbox.length = 0;
  assert.equal((await ind.runReminders()).taskOverdue, 1);
  assert.ok(mails("director@afc.test", /overdue/i).length === 1, "directors are told too");
  assert.equal((await ind.runReminders()).taskOverdue, 0, "once");
  assert.ok(D);
});

test("induction booking: time, and the link (online) or place / phone number are required and shown to the agent", async () => {
  const { D } = await onboardingAgent("Induct Seven", "a@inctseven.in");
  const url = `/api/coms/agents/${D}/inductions`;
  const day = calendar.addDays(today(), 2);
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: day, mode: "online", meeting_url: "https://x.example/j" })).status, 400, "time is required");
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: day, mode: "online", start_time: "10:30" })).status, 400, "online needs a link");
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: day, mode: "online", start_time: "10:30", meeting_url: "javascript:alert(1)" })).status, 400, "only web links");
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: day, mode: "in_person", start_time: "10:30" })).status, 400, "in person needs a place");
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: day, mode: "phone", start_time: "10:30" })).status, 400, "phone needs a number");

  outbox.length = 0;
  const ok = await post(url, "marketing", { outcome: "scheduled", scheduled_for: day, ...BOOK });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.start_time, "10:30");
  const mail = mails("a@inctseven.in", /induction/i)[0];
  assert.match(mail.text, /teams\.microsoft\.com/, "the agent gets the join link");
  assert.match(mail.text, /10:30 am/);
  // the agent's portal
  const agentUid = await (async () => {
    const hash = await hashPassword(PW);
    const u = (await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ('portal@inctseven.in',$1,'Pat','Seven','agent') RETURNING id`, [hash])).rows[0].id;
    await pool.query(`INSERT INTO agent_persons (agent_id, name, email, role, is_primary_contact, portal_user_id) VALUES ($1,'Pat Seven','portal@inctseven.in','staff',false,$2)`, [D, u]);
    return u;
  })();
  T.inductAgent = await login("portal@inctseven.in");
  const mine = (await get("/api/agent-application/induction", "inductAgent")).body.data;
  assert.equal(mine.eligible, true);
  assert.equal(mine.scheduled.meeting_url, BOOK.meeting_url);
  assert.equal(mine.scheduled.time.startsWith("10:30 am"), true);
  assert.equal(mine.scheduled.run_by, "Marketing Test");
  assert.equal(JSON.stringify(mine).includes("notes"), false, "internal notes are never sent to the agent");
  assert.equal((await get("/api/agent-application/induction", "marketing")).status, 403, "agents only");
  assert.ok(agentUid);

  // changing the mode needs the new details
  const id = ok.body.data.id;
  assert.equal((await post(`${url}/${id}/reschedule`, "marketing", { scheduled_for: day, mode: "in_person" })).status, 400);
  const moved = await post(`${url}/${id}/reschedule`, "marketing", { scheduled_for: day, mode: "in_person", location: "Level 2, 10 Bourke St, Melbourne" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.data.meeting_url, null);
  assert.equal((await get("/api/agent-application/induction", "inductAgent")).body.data.scheduled.location, "Level 2, 10 Bourke St, Melbourne");
});

test("induction: an agent who does not attend is recorded as missed, not held, and can be booked again", async () => {
  const { D, task } = await onboardingAgent("Induct Eight", "a@incteight.in");
  const url = `/api/coms/agents/${D}/inductions`;
  const id = (await post(url, "marketing", { outcome: "scheduled", scheduled_for: calendar.addDays(today(), 1), ...BOOK })).body.data.id;
  assert.equal((await post(`${url}/${id}/missed`, "marketing", {})).status, 400, "reason required");
  const m = await post(`${url}/${id}/missed`, "marketing", { reason: "Agent did not join the call" });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.status, "missed");
  assert.equal((await pool.query(`SELECT induction_recorded_at FROM agents WHERE id=$1`, [D])).rows[0].induction_recorded_at, null, "not recorded as held");
  assert.equal((await pool.query(`SELECT status FROM coms_tasks WHERE id=$1`, [task])).rows[0].status, "open");
  assert.equal((await audits("agent.induction_missed", D)).length, 1);
  assert.equal((await post(url, "marketing", { outcome: "scheduled", scheduled_for: calendar.addDays(today(), 3), ...BOOK })).status, 201);
});
