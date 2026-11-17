// Integration test: Settings the administrator can change (reference questions, documents, timers, college details, onboarding tasks).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/config/db");
const app = require("../src/app");
const { outbox } = require("../src/services/emailService");
const { hashPassword } = require("../src/utils/password");
const calendar = require("../src/services/calendarService");
const settings = require("../src/services/settingsService");
const { v2, needsV2, EXTRA } = require("./form2");

let server, base;
const PW = "Passw0rd@1";
const T = {};
const json = async (method, p, { token, body, raw } = {}) => {
  if (needsV2(method, p) && !raw) body = v2(body);
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json().catch(() => ({})) : Buffer.from(await res.arrayBuffer()), headers: res.headers };
};
const login = async (email) => (await json("POST", "/api/auth/login", { body: { email, password: PW } })).body.data?.token;
const mails = (to, re) => outbox.filter((m) => m.to === to && re.test(m.subject));
const get = (p, t) => json("GET", p, { token: T[t] });
const post = (p, t, body) => json("POST", p, { token: T[t], body: body || {} });
const put = (p, t, body) => json("PUT", p, { token: T[t], body });
const audits = async (action) => (await pool.query("SELECT * FROM audit_logs WHERE action=$1 ORDER BY id", [action])).rows;
const tokenFrom = (mail) => /reference\/([a-f0-9]{64})/.exec(mail.text)[1];

const form = (name, email) => ({
  first_name: "Dev", last_name: "Owner", email, phone: "+91 98765 43210", password: PW, consent: true,
  legal_name: name, abn_acn: "GST 12345", country: "India", is_body_corporate: false,
  principal_address: "12 MG Road, Bengaluru, India", applicant_role: "director", applicant_in_enrolments: true,
  referees: [
    { name: "Anil Rao", position: "Director", organisation: "Rao Colleges", email: `anil@${email.split("@")[1]}`, phone: "+91 98111 22222" },
    { name: "Mei Tan", position: "Dean", organisation: "Tan Institute", email: `mei@${email.split("@")[1]}`, phone: "+65 9123 0000" },
  ],
  coi_declared: false, code_of_ethics: true, information_true: true,
});
async function applied(name, email) {
  outbox.length = 0;
  assert.equal((await json("POST", "/api/auth/register-agent", { body: form(name, email) })).status, 202);
  const token = /verify\/([a-f0-9]{64})/.exec(mails(email, /confirm your email/i)[0].text)[1];
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token } })).status, 200);
  return (await pool.query(`SELECT id FROM agents WHERE lower(email)=lower($1)`, [email])).rows[0].id;
}
const good = { known_for: "Five years", worked_with: true, honest: true, accurate_info: true, complaints: false, recommend: true };

before(async () => {
  await pool.query("TRUNCATE agreements, audit_logs, password_resets, invitations, student_profiles, agent_profiles, users RESTART IDENTITY CASCADE");
  await require("./form2").restoreSettings(pool);
  await settings.reload();
  const hash = await hashPassword(PW);
  for (const [name, role] of [["admin", "admin"], ["marketing", "marketing_officer"], ["director", "director"]]) {
    await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ($1,$2,$3,'Test',$4)`, [`${name}@afc.test`, hash, name[0].toUpperCase() + name.slice(1), role]);
  }
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const n of ["admin", "marketing", "director"]) T[n] = await login(`${n}@afc.test`);
  calendar.clearCache();
});
after(async () => { server.close(); await pool.end(); });

test("only administrators can open or change Settings, and the standard values are there", async () => {
  assert.equal((await get("/api/settings", "director")).status, 403);
  assert.equal((await put("/api/settings/timers", "director", { ack_days: 3, decision_days: 10, amber_after_days: 7, referee_link_days: 21, referee_reminder_days: 3, referee_max_reminders: 2 })).status, 403);
  assert.equal((await json("GET", "/api/settings")).status, 401);
  const s = (await get("/api/settings", "admin")).body.data;
  assert.equal(s.reference_questions.length, 7);
  assert.deepEqual(s.document_types.filter((d) => d.required).map((d) => d.key), ["business_registration", "agency_profile"]);
  assert.equal(s.timers.decision_days, 10);
  assert.equal(s.college.rto, "45616");
  assert.deepEqual(s.onboarding_tasks.map((t) => t.type), ["PRISMS_ADD", "ASQANET_START", "WEBSITE_ADD", "COMMISSION_REPORT", "INDUCTION"]);
});

test("reference questions: add, edit and switch off; the referee form and the outcome follow; old answers keep their wording", async () => {
  const A = await applied("Settings Edu", "owner@settings.in");
  assert.equal((await post(`/api/coms/agents/${A}/status`, "marketing", { status: "due_diligence" })).status, 200);
  const [r1, r2] = (await pool.query(`SELECT id FROM agent_referees WHERE agent_id=$1 ORDER BY created_at, id`, [A])).rows.map((r) => r.id);

  // first referee answers with the standard questions
  outbox.length = 0;
  assert.equal((await post(`/api/coms/agents/${A}/referees/${r1}/request`, "marketing")).status, 200);
  const t1 = tokenFrom(mails("anil@settings.in", /reference request/i)[0]);
  assert.equal((await json("POST", `/api/reference/${t1}`, { body: { answers: good } })).status, 200);
  const first = (await pool.query(`SELECT questions, outcome FROM referee_checks WHERE referee_id=$1`, [r1])).rows[0];
  assert.equal(first.outcome, "positive");
  assert.equal(first.questions.length, 7, "the questions asked are kept with the answers");

  // rules
  const cur = (await get("/api/settings", "admin")).body.data.reference_questions;
  assert.equal((await put("/api/settings/reference-questions", "admin", { items: cur.slice(1) })).status, 400, "cannot delete");
  assert.equal((await put("/api/settings/reference-questions", "admin", { items: cur.map((q) => ({ ...q, favourable: null, active: true })) })).status, 400, "needs a favourable answer");
  assert.equal((await put("/api/settings/reference-questions", "admin", { items: cur.map((q) => ({ ...q, active: false })) })).status, 400, "needs one question on");
  assert.equal((await put("/api/settings/reference-questions", "marketing", { items: cur })).status, 403);

  // add a question that must be answered "yes", rename another, switch one off
  const items = cur.map((q) => (q.key === "known_for" ? { ...q, label: "How do you know this agent, and for how long?" } : q.key === "recommend" ? { ...q, active: false } : q));
  items.push({ label: "Is the agent registered with the migration agents board?", type: "yesno", required: true, favourable: true, ask_details: true, active: true });
  const saved = await put("/api/settings/reference-questions", "admin", { items });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const added = saved.body.data.reference_questions.find((q) => /migration agents board/.test(q.label));
  assert.match(added.key, /^is_the_agent_registered/);
  assert.equal((await audits("settings.reference_questions_updated")).length, 1);

  // the second referee sees the new list straight away
  outbox.length = 0;
  assert.equal((await post(`/api/coms/agents/${A}/referees/${r2}/request`, "marketing")).status, 200);
  const t2 = tokenFrom(mails("mei@settings.in", /reference request/i)[0]);
  const page = (await json("GET", `/api/reference/${t2}`)).body.data;
  assert.equal(page.questions.length, 7);
  assert.ok(page.questions.some((q) => q.key === added.key));
  assert.ok(!page.questions.some((q) => q.key === "recommend"));
  assert.equal(page.questions[0].label, "How do you know this agent, and for how long?");
  // the new question is required, and a "no" needs details
  assert.equal((await json("POST", `/api/reference/${t2}`, { body: { answers: good } })).status, 400);
  assert.equal((await json("POST", `/api/reference/${t2}`, { body: { answers: { ...good, [added.key]: false } } })).status, 400);
  assert.equal((await json("POST", `/api/reference/${t2}`, { body: { answers: { ...good, [added.key]: false, [`${added.key}_detail`]: "Not registered" } } })).status, 200);
  const second = (await pool.query(`SELECT outcome, questions FROM referee_checks WHERE referee_id=$1`, [r2])).rows[0];
  assert.equal(second.outcome, "negative", "the new favourable question counts");
  assert.ok(second.questions.some((q) => q.key === added.key));
  // the first referee's check still shows the wording and questions it was answered against
  const old = (await pool.query(`SELECT questions FROM referee_checks WHERE referee_id=$1`, [r1])).rows[0].questions;
  assert.equal(old.find((q) => q.key === "known_for").label, "How long, and in what capacity, have you known this agent?");
  assert.ok(old.some((q) => q.key === "recommend"));
  const dd = (await get(`/api/coms/agents/${A}/due-diligence`, "director")).body.data;
  assert.equal(dd.referees[0].checks[0].questions.length, 7);
});

test("document types: a new required document gates approval; the rules protect 'other'", async () => {
  const cur = (await get("/api/settings", "admin")).body.data.document_types;
  assert.equal((await put("/api/settings/document-types", "admin", { items: cur.filter((d) => d.key !== "mara_certificate") })).status, 400, "cannot delete");
  assert.equal((await put("/api/settings/document-types", "admin", { items: cur.map((d) => (d.key === "other" ? { ...d, active: false } : d)) })).status, 400);
  assert.equal((await put("/api/settings/document-types", "admin", { items: cur.map((d) => (d.key === "mara_certificate" ? { ...d, required: true, active: false } : d)) })).status, 400);
  const items = [...cur.map((d) => (d.key === "mara_certificate" ? { ...d, required: true } : d)), { label: "Police clearance", file_name: "Police clearance", required: false, active: true }];
  const r = await put("/api/settings/document-types", "admin", { items });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.document_types.find((d) => d.key === "police_clearance"));

  const A = (await pool.query(`SELECT id FROM agents WHERE email='owner@settings.in'`)).rows[0].id;
  const docs = (await get(`/api/coms/agents/${A}/documents`, "director")).body;
  assert.deepEqual(docs.data.required.map((x) => x.kind), ["business_registration", "agency_profile", "mara_certificate"]);
  assert.ok(docs.data.kinds.police_clearance);
  const up = await post(`/api/coms/agents/${A}/documents`, "marketing", { kind: "police_clearance", file: { name: "pc.pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x20)]).toString("base64") } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.match(up.body.data.documents.find((d) => d.kind === "police_clearance").filing_name, /Settings Edu - Police clearance - /);
  assert.equal((await post(`/api/coms/agents/${A}/documents`, "marketing", { kind: "nonsense", file: { name: "x.pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x20)]).toString("base64") } })).status, 400);
  // switch it off again: existing files still show a name, new uploads are refused
  const back = (await get("/api/settings", "admin")).body.data.document_types.map((d) => (d.key === "police_clearance" ? { ...d, active: false } : d.key === "mara_certificate" ? { ...d, required: false } : d));
  assert.equal((await put("/api/settings/document-types", "admin", { items: back })).status, 200);
  const after = (await get(`/api/coms/agents/${A}/documents`, "director")).body.data;
  assert.equal(after.documents.find((d) => d.kind === "police_clearance").kind, "police_clearance");
  assert.equal(after.kinds.police_clearance.active, false);
  assert.deepEqual(after.required.map((x) => x.kind), ["business_registration", "agency_profile"]);
});

test("timers change the deadlines and the amber warning", async () => {
  const body = { ack_days: 2, decision_days: 5, amber_after_days: 3, referee_link_days: 14, referee_reminder_days: 2, referee_max_reminders: 1, task_escalation_days: 4 };
  assert.equal((await put("/api/settings/timers", "admin", { ...body, amber_after_days: 9 })).status, 400, "amber cannot be after the deadline");
  assert.equal((await put("/api/settings/timers", "admin", { ...body, decision_days: 0 })).status, 400);
  assert.equal((await put("/api/settings/timers", "admin", body)).status, 200);
  assert.equal((await audits("settings.timers_updated")).length, 1);
  const B = await applied("Timer Edu", "owner@timer.in");
  const rec = (await get(`/api/coms/agents/${B}`, "director")).body.data;
  assert.equal(rec.sla.decision.due, await calendar.addBusinessDays(calendar.localDate(), 5));
  assert.equal(rec.sla.acknowledgement.due, await calendar.addBusinessDays(calendar.localDate(), 2));
  // the referee link lasts 14 days now
  await pool.query(`UPDATE agents SET status='due_diligence' WHERE id=$1`, [B]);
  const r = (await pool.query(`SELECT id FROM agent_referees WHERE agent_id=$1 ORDER BY created_at LIMIT 1`, [B])).rows[0].id;
  await post(`/api/coms/agents/${B}/referees/${r}/request`, "marketing");
  const days = (await pool.query(`SELECT extract(epoch FROM (token_expires_at - now()))/86400 AS d FROM referee_checks WHERE referee_id=$1`, [r])).rows[0].d;
  assert.ok(days > 13 && days <= 14, `expires in ${days} days`);
  await put("/api/settings/timers", "admin", { ack_days: 3, decision_days: 10, amber_after_days: 7, referee_link_days: 21, referee_reminder_days: 3, referee_max_reminders: 2 });
});

test("college details and the certificate signatory flow into the certificate", async () => {
  const college = require("../src/emails/college");
  assert.equal((await put("/api/settings/college", "admin", { name: "Australian Federation College", rto: "99999", cricos: "00001A", signer_name: "Jane CITIZEN", signer_position: "Chief Executive Officer", campuses: ["1 Test St, Hobart TAS 7000"] })).status, 200);
  assert.equal(college.rto, "99999");
  assert.equal(college.signer.name, "Jane CITIZEN");
  assert.deepEqual(college.campuses, ["1 Test St, Hobart TAS 7000"]);
  assert.equal(college.phone, "+61 3 6393 3225", "anything left blank keeps the standard value");
  const pdf = await require("../src/services/certificatePdf").render({ id: 1, agency_name: "Test Agency" });
  assert.ok(pdf.length > 10000);
  assert.equal((await audits("settings.college_updated")).length, 1);
  // a custom signature (PNG) and back to the standard one
  const png = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "emails", "assets", "signature-sohel-rana.png"));
  assert.equal((await put("/api/settings/signature", "admin", { signature_image: "data:image/png;base64," + png.toString("base64") })).status, 200);
  assert.equal((await get("/api/settings", "admin")).body.data.has_custom_signature, true);
  assert.equal((await put("/api/settings/signature", "admin", { signature_image: "data:image/png;base64," + Buffer.from("not an image at all, just text padding padding padding padding padding padding padding").toString("base64") })).status, 400);
  assert.equal((await post("/api/settings/signature/remove", "admin")).status, 200);
  assert.equal((await get("/api/settings", "admin")).body.data.has_custom_signature, false);
  await put("/api/settings/college", "admin", {}); // back to the standard details
  assert.equal(college.rto, "45616");
});

test("onboarding tasks follow the template; required ones cannot be switched off", async () => {
  const cur = (await get("/api/settings", "admin")).body.data.onboarding_tasks;
  assert.equal((await put("/api/settings/onboarding-tasks", "admin", { items: cur.map((t) => (t.type === "PRISMS_ADD" ? { ...t, enabled: false } : t)) })).status, 400);
  assert.equal((await put("/api/settings/onboarding-tasks", "admin", { items: cur.map((t) => (t.type === "INDUCTION" ? { ...t, enabled: false } : t)) })).status, 400);
  assert.equal((await put("/api/settings/onboarding-tasks", "admin", { items: cur.map((t) => (t.type === "WEBSITE_ADD" ? { ...t, owner_role: "nobody" } : t)) })).status, 400);
  assert.equal((await put("/api/settings/onboarding-tasks", "admin", { items: [{ ...cur[0], type: "MADE_UP" }] })).status, 400);
  const items = cur.map((t) => (t.type === "WEBSITE_ADD" ? { ...t, title: "Publish {agent} on the website", owner_role: "marketing_officer", due_days: 2 }
    : t.type === "COMMISSION_REPORT" ? { ...t, enabled: false } : t));
  assert.equal((await put("/api/settings/onboarding-tasks", "admin", { items })).status, 200);
  assert.equal((await audits("settings.onboarding_tasks_updated")).length, 1);

  const taskService = require("../src/services/taskService");
  const A = (await pool.query(`SELECT id FROM agents WHERE email='owner@settings.in'`)).rows[0].id;
  const agent = (await pool.query(`SELECT * FROM agents WHERE id=$1`, [A])).rows[0];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ag = (await client.query(`INSERT INTO agreements (agent_id, title, status, effective_date, expires_at) SELECT id, 'Agreement', 'active', current_date, current_date + 365 FROM users WHERE email='owner@settings.in' RETURNING id`)).rows[0];
    const made = await taskService.createOnboardingTasks(client, { agent, agreement: { id: ag.id, effective_date: calendar.localDate() }, actorId: null });
    assert.equal(made.length, 4, "the switched-off task is not created");
    const rows = (await client.query(`SELECT type, title, owner_role, due_date::text, legal_deadline::text FROM coms_tasks WHERE agreement_id=$1 ORDER BY type`, [ag.id])).rows;
    assert.ok(!rows.some((r) => r.type === "COMMISSION_REPORT"));
    const web = rows.find((r) => r.type === "WEBSITE_ADD");
    assert.equal(web.title, "Publish Settings Edu on the website");
    assert.equal(web.owner_role, "marketing_officer");
    assert.equal(web.due_date, await calendar.addBusinessDays(calendar.localDate(), 2));
    assert.equal(rows.find((r) => r.type === "ASQANET_START").legal_deadline, null);
    assert.equal(rows.find((r) => r.type === "ASQANET_START").owner_role, "ceo");
    await client.query("ROLLBACK");
  } finally { client.release(); }
  // put things back
  await put("/api/settings/onboarding-tasks", "admin", { items: cur });
});
