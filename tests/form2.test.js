// Integration test: AFC Education Agent Application Form V2.0 and the Processing Agent Application procedure.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/config/db");
const app = require("../src/app");
const { outbox } = require("../src/services/emailService");
const { hashPassword } = require("../src/utils/password");
const calendar = require("../src/services/calendarService");
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
const pdf = (name = "doc.pdf") => ({ name, data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x20)]).toString("base64") });
const audits = async (action) => (await pool.query("SELECT * FROM audit_logs WHERE action=$1 ORDER BY id", [action])).rows;

const form = (name, email, over = {}) => ({
  first_name: "Dev", last_name: "Owner", email, phone: "+91 98765 43210", password: PW, consent: true,
  legal_name: name, abn_acn: "GST 12345", country: "India", is_body_corporate: false,
  principal_address: "12 MG Road, Bengaluru, India", applicant_role: "director", applicant_in_enrolments: true,
  referees: [
    { name: "Anil Rao", position: "Director", organisation: "Rao Colleges", email: `anil@${email.split("@")[1]}`, phone: "+91 98111 22222" },
    { name: "Mei Tan", position: "Dean", organisation: "Tan Institute", email: `mei@${email.split("@")[1]}`, phone: "+65 9123 0000" },
  ],
  coi_declared: false, code_of_ethics: true, information_true: true, ...over,
});
async function applied(name, email, over) {
  outbox.length = 0;
  assert.equal((await json("POST", "/api/auth/register-agent", { body: form(name, email, over) })).status, 202);
  const token = /verify\/([a-f0-9]{64})/.exec(mails(email, /confirm your email/i)[0].text)[1];
  assert.equal((await json("POST", "/api/auth/verify-agent", { body: { token } })).status, 200);
  return (await pool.query(`SELECT id FROM agents WHERE lower(email)=lower($1)`, [email])).rows[0].id;
}
let A;

before(async () => {
  await pool.query("TRUNCATE agreements, audit_logs, password_resets, invitations, student_profiles, agent_profiles, users RESTART IDENTITY CASCADE");
  await require("./form2").restoreSettings(pool);
  const hash = await hashPassword(PW);
  for (const [name, role] of [["admin", "admin"], ["marketing", "marketing_officer"], ["director", "director"], ["accounts", "accounts"], ["coe", "coe_admin"]]) {
    await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ($1,$2,$3,'Test',$4)`, [`${name}@afc.test`, hash, name[0].toUpperCase() + name.slice(1), role]);
  }
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const n of ["admin", "marketing", "director", "accounts", "coe"]) T[n] = await login(`${n}@afc.test`);
  calendar.clearCache();
});
after(async () => { server.close(); await pool.end(); });

test("the application asks every question on the AFC form and explains what is missing", async () => {
  const bad = async (over, field, extraOver) => {
    const body = { ...v2(form("Zeta Education", "owner@zeta.in")), ...over };
    if (extraOver) body.extra = { ...body.extra, ...extraOver };
    const r = await json("POST", "/api/auth/register-agent", { body, raw: true });
    assert.equal(r.status, 400, field);
    assert.ok(JSON.stringify(r.body.errors || {}).includes(field), `${field} in ${JSON.stringify(r.body.errors)}`);
  };
  await bad({ gst_registered: undefined }, "gst_registered");
  await bad({ owner_name: "" }, "owner_name");
  await bad({ staff_count: -1 }, "staff_count");
  await bad({ years_in_business: undefined }, "years_in_business");
  await bad({ privacy_agreed: false }, "privacy_agreed");
  await bad({ declaration_name: "" }, "declaration_name");
  await bad({}, "services", { services: [] });
  await bad({}, "registrations", { registrations: [] });
  await bad({}, "markets", { markets: [] });
  await bad({}, "services_to_afc", { services_to_afc: "" });
  await bad({}, "experience_education", { experience_education: "" });
  await bad({}, "esos_intend", { esos_read: false, esos_intend: null });
  await bad({}, "national_code_intend", { national_code_read: false, national_code_intend: null });
  const noPos = form("Zeta Education", "owner@zeta.in");
  noPos.referees[0].position = "";
  const r = await json("POST", "/api/auth/register-agent", { body: { ...EXTRA, ...noPos }, raw: true });
  assert.equal(r.status, 400);
  assert.ok(JSON.stringify(r.body.errors).includes("position"));
});

test("a submitted application is stored in full, filed as a PDF, and shown to staff", async () => {
  A = await applied("Beta Education", "owner@beta.in", {
    gst_registered: true, owner_name: "Beta Owner", staff_count: 12, years_in_business: 9, declaration_name: "Beta Owner",
    extra: { ...EXTRA.extra, esos_read: false, esos_intend: true, offshore_offices: [{ location: "Mumbai", details: "Counselling office" }],
      recruited_australia: [{ sector: "University", students: 40 }], recruited_other: [{ sector: "Schools (UK)", students: 15 }] },
  });
  const rec = (await get(`/api/coms/agents/${A}`, "director")).body.data;
  assert.equal(rec.gst_registered, true);
  assert.equal(rec.owner_name, "Beta Owner");
  assert.equal(rec.staff_count, 12);
  assert.equal(rec.years_in_business, 9);
  assert.equal(rec.application_extra.esos_read, false);
  assert.equal(rec.application_extra.offshore_offices[0].location, "Mumbai");
  assert.equal(rec.application_extra.recruited_other[0].students, 15);
  assert.ok(rec.privacy_agreed_at && rec.declaration_at);
  assert.equal(rec.declaration_name, "Beta Owner");
  assert.equal(rec.referees[0].position, "Director");

  assert.equal((await get(`/api/coms/agents/${A}/application.pdf`, "accounts")).status, 200, "any staff member may read it");
  const file = await get(`/api/coms/agents/${A}/application.pdf`, "marketing");
  assert.equal(file.status, 200);
  assert.equal(file.body.subarray(0, 4).toString(), "%PDF");
  assert.match(decodeURIComponent(file.headers.get("content-disposition")), /Beta Education - Education Agent Application Form\.pdf/);
  assert.equal((await json("GET", `/api/coms/agents/${A}/application.pdf`)).status, 401);
  assert.equal((await audits("agent.application_pdf_downloaded")).length, 2);
});

test("documents: the agent uploads, staff review, and approval waits until the required ones are accepted", async () => {
  // the college has approved the registration login (so the agent can sign in to upload)
  await pool.query("UPDATE users SET status = 'active' WHERE lower(email) = 'owner@beta.in'");
  const agentTok = await login("owner@beta.in");
  // the agent's own list
  const mine = await json("GET", "/api/agent-application/documents", { token: agentTok });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.complete, false);
  assert.deepEqual(mine.body.data.required.map((r) => r.status), ["missing", "missing"]);
  // file checks
  const up = (kind, file, label) => json("POST", "/api/agent-application/documents", { token: agentTok, body: { kind, file, label } });
  assert.equal((await up("business_registration", { name: "run.exe", data: "AAAAAAAAAAAA" })).status, 400);
  assert.equal((await up("business_registration", { name: "fake.pdf", data: Buffer.from("not a pdf!!").toString("base64") })).status, 400);
  assert.equal((await up("passport", pdf())).status, 400);
  assert.equal((await up("business_registration", pdf("registration.pdf"))).status, 201);
  assert.equal((await up("agency_profile", pdf("profile.pdf"))).status, 201);
  assert.equal((await up("other", pdf("extra.pdf"), "Letter of support")).status, 201);
  assert.equal((await json("POST", "/api/agent-application/documents", { token: T.admin, body: { kind: "other", file: pdf() } })).status, 403, "staff use the agent record");

  // staff see them, with a proper filing name
  const list = (await get(`/api/coms/agents/${A}/documents`, "marketing")).body.data;
  assert.equal(list.documents.length, 3);
  assert.equal(list.complete, false);
  const reg = list.documents.find((d) => d.kind === "business_registration");
  const dl = await get(`/api/coms/agents/${A}/documents/${reg.id}/download`, "marketing");
  assert.equal(dl.status, 200);
  assert.match(decodeURIComponent(dl.headers.get("content-disposition")), /^attachment; filename="Beta Education - Business registration - \d{4}-\d{2}-\d{2}\.pdf"$/);
  const other = list.documents.find((d) => d.kind === "other");
  assert.match(decodeURIComponent((await get(`/api/coms/agents/${A}/documents/${other.id}/download`, "marketing")).headers.get("content-disposition")), /Letter of support/);

  // moving to due diligence: approval is blocked by the documents
  assert.equal((await post(`/api/coms/agents/${A}/status`, "marketing", { status: "due_diligence" })).status, 200);
  const dd = (await get(`/api/coms/agents/${A}/due-diligence`, "director")).body.data;
  const item = dd.items.find((i) => i.key === "documents");
  assert.equal(item.done, false);
  assert.ok(dd.blockers.some((b) => /documents/i.test(b)));

  // review: needs a note when something must change; only the right roles
  assert.equal((await post(`/api/coms/agents/${A}/documents/${reg.id}/review`, "accounts", { status: "accepted" })).status, 403);
  assert.equal((await post(`/api/coms/agents/${A}/documents/${reg.id}/review`, "marketing", { status: "needs_update" })).status, 400);
  assert.equal((await post(`/api/coms/agents/${A}/documents/${reg.id}/review`, "marketing", { status: "needs_update", note: "Certificate is not readable" })).status, 200);
  const agentView = (await json("GET", "/api/agent-application/documents", { token: agentTok })).body.data;
  assert.equal(agentView.documents.find((d) => d.kind === "business_registration").review_note, "Certificate is not readable", "the agent sees what to fix");

  // "reply back to agent": an email goes to the applicant
  outbox.length = 0;
  assert.equal((await post(`/api/coms/agents/${A}/request-information`, "marketing", { message: "x" })).status, 400);
  const asked = await post(`/api/coms/agents/${A}/request-information`, "marketing", { message: "Please send a clearer copy of your registration certificate." });
  assert.equal(asked.status, 200);
  const mail = mails("owner@beta.in", /more information needed/i)[0];
  assert.ok(mail);
  assert.match(mail.text, /clearer copy/);
  assert.match(mail.text, /Business registration certificate/);
  assert.equal((await audits("agent.information_requested")).length, 1);

  // the agent replaces the file; the new one is "received"; staff accept both required documents
  assert.equal((await up("business_registration", pdf("registration2.pdf"))).status, 201);
  const after = (await get(`/api/coms/agents/${A}/documents`, "marketing")).body.data;
  assert.equal(after.documents.filter((d) => d.kind === "business_registration").length, 1, "old version is replaced");
  for (const d of after.documents.filter((x) => ["business_registration", "agency_profile"].includes(x.kind))) {
    assert.equal((await post(`/api/coms/agents/${A}/documents/${d.id}/review`, "marketing", { status: "accepted" })).status, 200);
  }
  const done = (await get(`/api/coms/agents/${A}/documents`, "marketing")).body.data;
  assert.equal(done.complete, true);
  const dd2 = (await get(`/api/coms/agents/${A}/due-diligence`, "director")).body.data;
  assert.equal(dd2.items.find((i) => i.key === "documents").done, true);
  // an accepted document cannot be removed by the agent; the agent can remove an unreviewed one
  const accepted = done.documents.find((d) => d.kind === "agency_profile");
  assert.equal((await json("POST", `/api/agent-application/documents/${accepted.id}/delete`, { token: agentTok, body: {} })).status, 409);
  const otherDoc = done.documents.find((d) => d.kind === "other");
  assert.equal((await json("POST", `/api/agent-application/documents/${otherDoc.id}/delete`, { token: agentTok, body: {} })).status, 200);
  // staff removal needs a reason
  assert.equal((await post(`/api/coms/agents/${A}/documents/${accepted.id}/delete`, "marketing", {})).status, 400);
  assert.equal((await audits("agent.document_added")).length >= 4, true);
});

test("procedure step 2: the contact in the student management system is recorded", async () => {
  assert.equal((await post(`/api/coms/agents/${A}/milestones`, "accounts", { type: "sms_contact" })).status, 403);
  const r = await post(`/api/coms/agents/${A}/milestones`, "marketing", { type: "sms_contact" });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.sms_contact_at);
  const dd = (await get(`/api/coms/agents/${A}/due-diligence`, "director")).body.data;
  assert.ok(!dd.warnings.some((w) => /student management system/.test(w)));
  assert.equal((await audits("agent.sms_contact_recorded")).length, 1);
});

test("procedure step 6: commission and bonus are recorded, sent to Accounts, and finish their task", async () => {
  // put the agent where the procedure is at step 6, with the task the countersigned agreement would create
  await pool.query(`UPDATE agents SET status = 'onboarding' WHERE id = $1`, [A]);
  const t = await post("/api/coms/tasks", "marketing", { type: "COMMISSION_REPORT", title: "Record commission and bonus for Beta Education and report to Accounts", agent_id: A, due_date: calendar.addDays(calendar.localDate(), 5), due_basis: "business" });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  // the task cannot be closed before the terms exist
  const blocked = await post(`/api/coms/tasks/${t.body.data.id}/complete`, "marketing", { note: "done" });
  assert.equal(blocked.status, 400);
  assert.match(JSON.stringify(blocked.body.errors), /commission/i);

  assert.equal((await post(`/api/coms/agents/${A}/terms`, "coe", { vet_percent: 35, elicos_percent: 30 })).status, 403);
  assert.equal((await post(`/api/coms/agents/${A}/terms`, "marketing", { vet_percent: 150 })).status, 400);
  assert.equal((await get(`/api/coms/agents/${A}/terms/draft`, "marketing")).status, 409, "nothing recorded yet");
  outbox.length = 0;
  // defaults are the Schedule 1 rates; recording does not email anyone
  const ok = await post(`/api/coms/agents/${A}/terms`, "marketing", { bonus_terms: "$500 for 10 enrolments in a year" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(Number(ok.body.data.commission_vet_pct), 35);
  assert.equal(Number(ok.body.data.commission_elicos_pct), 30);
  assert.match(ok.body.data.commission_terms, /VET courses: 35%.*ELICOS courses: 30%/);
  assert.equal(outbox.filter((m) => m.to === "accounts@afc.test").length, 0, "staff review the draft first");
  const draft = ok.body.data.draft;
  assert.equal(draft.to[0].email, "accounts@afc.test");
  assert.match(draft.body, /VET courses: 35%/);
  assert.match(draft.body, /\$500/);
  let task = (await get(`/api/coms/tasks?agent_id=${A}&status=all`, "director")).body.data.find((x) => x.type === "COMMISSION_REPORT");
  assert.equal(task.status, "open", "saving alone does not finish the task");

  // the officer edits the wording and sends it
  assert.equal((await post(`/api/coms/agents/${A}/terms/send`, "coe", { subject: "Commission", body: "Please add this agent." })).status, 403);
  const sent = await post(`/api/coms/agents/${A}/terms/send`, "marketing", { subject: draft.subject, body: `${draft.body}\n\nPlease confirm when done.` });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.data.accounts_notified, 1);
  const mail = mails("accounts@afc.test", /new agent commission/i)[0];
  assert.ok(mail);
  assert.match(mail.text, /Please confirm when done/);
  task = (await get(`/api/coms/tasks?agent_id=${A}&status=all`, "director")).body.data.find((x) => x.type === "COMMISSION_REPORT");
  assert.equal(task.status, "done", "sending the email finishes the task");
  assert.equal((await audits("agent.terms_sent")).length, 1);
  assert.equal((await audits("agent.terms_recorded"))[0].before.commission_terms, null);

  // an agent still being assessed has no terms yet
  const other = await applied("Gamma Education", "owner@gamma.in");
  assert.equal((await post(`/api/coms/agents/${other}/terms`, "marketing", { vet_percent: 35, elicos_percent: 30 })).status, 409);
});
