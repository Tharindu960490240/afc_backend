// Integration test for the agent agreement flow: generated from a template, signed in the portal.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "afc-uploads-"));

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/config/db");
const app = require("../src/app");
const { outbox } = require("../src/services/emailService");
const { hashPassword } = require("../src/utils/password");
const reminders = require("../src/jobs/agreementReminders");
const docs = require("../src/services/agreementDocument");
const storage = require("../src/services/fileStorage");

let server, base, adminT, agentT, agent2T, agentId;
const zlib = require("zlib");
const crypto = require("crypto");
// a small but real PNG, like the one the signature pad produces
const pngDataUrl = (w = 80, h = 30) => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), crypto.randomBytes(w * 3)])));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
};
const PW = "Passw0rd@1";

const json = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})), res };
};
const login = async (email) => (await json("POST", "/api/auth/login", { body: { email, password: PW } })).body.data.token;
const lastMail = (to, re) => [...outbox].reverse().find((m) => m.to === to && re.test(m.subject));
const filesOnDisk = () => {
  let n = 0;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : n++));
  walk(process.env.UPLOAD_DIR);
  return n;
};

before(async () => {
  await pool.query("TRUNCATE agreements, audit_logs, password_resets, invitations, student_profiles, agent_profiles, users RESTART IDENTITY CASCADE");
  // TRUNCATE ... users CASCADE also empties the templates table, so put the sample template back
  const sample = fs.readFileSync(path.join(__dirname, "..", "migrations", "003_agreement_signing.sql"), "utf8").split("$tpl$")[1];
  await pool.query("INSERT INTO agreement_templates (name, body, version, is_active) VALUES ('Education Agent Agreement', $1, 1, true)", [sample]);
  const hash = await hashPassword(PW);
  const mk = async (email, first, role) =>
    (await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,role) VALUES ($1,$2,$3,'Test',$4) RETURNING id`, [email, hash, first, role])).rows[0].id;
  await mk("admin@afc.test", "Ada", "admin");
  agentId = await mk("agent1@x.com", "Sam", "agent");
  await mk("agent2@x.com", "Zed", "agent");
  await mk("teacher@x.com", "Tia", "teacher");
  await pool.query("INSERT INTO agent_profiles (user_id, agency_name, business_number, country) VALUES ($1,'Sam Education','ABN 1234','India')", [agentId]);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  adminT = await login("admin@afc.test");
  agentT = await login("agent1@x.com");
  agent2T = await login("agent2@x.com");
});
after(async () => { server.close(); await pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

let id; // the agreement under test
const SIGN = (name = "Sam Test") => ({ signed_name: name, accept: true });
const SIGN_ADMIN = (extra = {}) => ({ signed_name: "Ada Test", position: "Director", accept: true, ...extra });
const send = (body, token = adminT) => json("POST", "/api/agreements", { token, body });

test("only admins can send; target must be an active agent", async () => {
  assert.equal((await send({ agent_id: agentId }, agentT)).status, 403);
  const teacher = (await pool.query("SELECT id FROM users WHERE email='teacher@x.com'")).rows[0].id;
  assert.equal((await send({ agent_id: teacher })).status, 404);
  assert.equal((await send({ agent_id: 9999 })).status, 404);
  assert.equal((await send({})).status, 400);
});

test("the template can be read and edited by admins only, and unknown placeholders are refused", async () => {
  assert.equal((await json("GET", "/api/agreement-template", { token: agentT })).status, 403);
  const t = await json("GET", "/api/agreement-template", { token: adminT });
  assert.equal(t.status, 200);
  assert.match(t.body.data.body, /\{\{agent_name\}\}/);
  assert.ok(t.body.data.placeholders.agent_name);
  const bad = await json("PUT", "/api/agreement-template", { token: adminT, body: { name: "Bad", body: "x".repeat(120) + " {{nope}}" } });
  assert.equal(bad.status, 400);
  const pv = await json("POST", "/api/agreement-template/preview", { token: adminT, body: { body: "# Title\n\nHello {{agent_name}} of {{agency_name}}." } });
  assert.equal(pv.body.data.blocks[1].text, "Hello Sample Agent of Sample Education Pty.");
});

test("admin sends a generated agreement; agent gets a reminder email only", async () => {
  outbox.length = 0;
  const r = await send({ agent_id: agentId, note: "Please sign by Friday", validity_months: 12 });
  assert.equal(r.status, 201);
  id = r.body.data.id;
  assert.equal(r.body.data.status, "sent");
  assert.equal(r.body.data.in_portal, true);
  const mail = lastMail("agent1@x.com", /agreement is waiting/i);
  assert.ok(mail);
  assert.match(mail.text, /not attached/i);
  assert.equal(filesOnDisk(), 0); // nothing is stored until it is finished
});

test("the wording is filled in for this agent and the snapshot never changes", async () => {
  const d = (await json("GET", `/api/agreements/${id}`, { token: agentT })).body.data;
  const text = d.document.map((b) => b.text).join("\n");
  assert.match(text, /Sam Test/);
  assert.match(text, /Sam Education/);
  assert.match(text, /ABN 1234/);
  assert.match(text, /India/);
  assert.equal(/\{\{/.test(text), false);
  assert.match(text, /the date the College countersigns/);
  assert.equal(d.reference, `AGR-${String(id).padStart(5, "0")}`);
  // editing the template later does not touch an agreement already sent
  await json("PUT", "/api/agreement-template", { token: adminT, body: { name: "Education Agent Agreement", body: "# Changed\n\n" + "New wording for {{agent_name}}. ".repeat(10) } });
  const again = (await json("GET", `/api/agreements/${id}`, { token: agentT })).body.data;
  assert.equal(again.document[0].text, "Education Agent Agreement");
  // restore a full template for the rest of the tests
  const original = fs.readFileSync(path.join(__dirname, "..", "migrations", "003_agreement_signing.sql"), "utf8").split("$tpl$")[1];
  assert.equal((await json("PUT", "/api/agreement-template", { token: adminT, body: { name: "Education Agent Agreement", body: original } })).status, 200);
  assert.equal((await json("GET", "/api/agreement-template", { token: adminT })).body.data.version, 3);
});

test("only one agreement in progress per agent", async () => {
  assert.equal((await send({ agent_id: agentId })).status, 409);
});

test("visibility: agents see only their own agreements", async () => {
  assert.equal((await json("GET", `/api/agreements/${id}`, { token: agent2T })).status, 404);
  assert.equal((await json("GET", `/api/agreements/${id}`)).status, 401);
  const own = await json("GET", "/api/agreements", { token: agentT });
  assert.deepEqual(own.body.data.map((a) => a.id), [id]);
  assert.equal((await json("GET", "/api/agreements", { token: agent2T })).body.data.length, 0);
  const detail = await json("GET", `/api/agreements/${id}`, { token: agentT });
  const raw = JSON.stringify(detail.body);
  assert.equal(raw.includes("storage_key"), false);
  assert.equal(raw.includes("body_snapshot"), false);
  assert.equal(raw.includes("sig_image"), false);
});

test("anyone allowed can open a PDF of the current state, others cannot", async () => {
  const url = `/api/agreements/${id}/pdf`;
  assert.equal((await fetch(base + url)).status, 401);
  assert.equal((await fetch(base + url, { headers: { Authorization: `Bearer ${agent2T}` } })).status, 404);
  const ok = await fetch(base + url, { headers: { Authorization: `Bearer ${agentT}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/pdf");
  assert.match(ok.headers.get("content-disposition"), /attachment/);
  const buf = Buffer.from(await ok.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
});

test("agent signs in the portal; admins get a review email", async () => {
  assert.equal((await json("POST", `/api/agreements/${id}/sign`, { token: adminT, body: SIGN() })).status, 403);
  assert.equal((await json("POST", `/api/agreements/${id}/sign`, { token: agent2T, body: SIGN() })).status, 404);
  assert.equal((await json("POST", `/api/agreements/${id}/sign`, { token: agentT, body: { signed_name: "S" , accept: true } })).status, 400); // too short
  assert.equal((await json("POST", `/api/agreements/${id}/sign`, { token: agentT, body: { signed_name: "Sam Test" } })).status, 400); // box not ticked
  assert.equal((await json("POST", `/api/agreements/${id}/sign`, { token: agentT, body: { ...SIGN(), signature_image: "data:image/png;base64,AAAA" } })).status, 400); // not a real image
  assert.equal((await json("POST", `/api/agreements/${id}/sign`, { token: agentT, body: { ...SIGN(), signature_image: "data:text/html;base64,PGI+" } })).status, 400);
  outbox.length = 0;
  const r = await json("POST", `/api/agreements/${id}/sign`, { token: agentT, body: { ...SIGN(), signature_image: pngDataUrl() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "submitted");
  assert.equal(r.body.data.agent_sig_name, "Sam Test");
  assert.ok(r.body.data.agent_signed_at);
  assert.ok(lastMail("admin@afc.test", /submitted by/i));
  assert.equal((await json("POST", `/api/agreements/${id}/sign`, { token: agentT, body: SIGN() })).status, 409); // already signed
  // the interim PDF shows the agent's signature
  const pdf = await fetch(base + `/api/agreements/${id}/pdf`, { headers: { Authorization: `Bearer ${adminT}` } });
  assert.equal(pdf.status, 200);
});

test("admin rejects with a reason; the agent must sign again", async () => {
  assert.equal((await json("POST", `/api/agreements/${id}/reject`, { token: adminT, body: {} })).status, 400);
  assert.equal((await json("POST", `/api/agreements/${id}/reject`, { token: agentT, body: { reason: "nope nope" } })).status, 403);
  outbox.length = 0;
  const r = await json("POST", `/api/agreements/${id}/reject`, { token: adminT, body: { reason: "Name does not match the business" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "rejected");
  assert.equal(r.body.data.agent_sig_name, null); // their old signature is cleared
  assert.match(lastMail("agent1@x.com", /needs changes/i).text, /Name does not match/);
  assert.equal((await json("POST", `/api/agreements/${id}/reject`, { token: adminT, body: { reason: "again again" } })).status, 409);
  const again = await json("POST", `/api/agreements/${id}/sign`, { token: agentT, body: SIGN("Sam Test") });
  assert.equal(again.body.data.status, "submitted");
});

test("countersign needs a name, the tick box and a sensible date", async () => {
  const u = `/api/agreements/${id}/approve`;
  assert.equal((await json("POST", u, { token: adminT, body: {} })).status, 400);
  assert.equal((await json("POST", u, { token: adminT, body: { ...SIGN_ADMIN(), accept: false } })).status, 400);
  assert.equal((await json("POST", u, { token: adminT, body: SIGN_ADMIN({ effective_date: "2099-01-01" }) })).status, 400);
  assert.equal((await json("POST", u, { token: agentT, body: SIGN_ADMIN() })).status, 403);
  assert.equal(filesOnDisk(), 0);
});

test("countersign -> active for 12 months, final PDF stored, everyone can download it", async () => {
  outbox.length = 0;
  const r = await json("POST", `/api/agreements/${id}/approve`, { token: adminT, body: SIGN_ADMIN({ signature_image: pngDataUrl(120, 40) }) });
  assert.equal(r.status, 200);
  const a = r.body.data;
  assert.equal(a.status, "active");
  assert.ok(a.final_file_id);
  assert.equal(a.admin_sig_name, "Ada Test");
  assert.equal(a.admin_sig_position, "Director");
  const eff = new Date(a.effective_date), exp = new Date(a.expires_at);
  assert.equal((exp.getFullYear() - eff.getFullYear()) * 12 + exp.getMonth() - eff.getMonth(), 12);
  assert.ok(lastMail("agent1@x.com", /approved/i));
  assert.ok(Number(a.days_left) >= 364);
  assert.equal(filesOnDisk(), 1);

  const detail = (await json("GET", `/api/agreements/${id}`, { token: agentT })).body.data;
  assert.deepEqual(detail.files.map((f) => f.kind), ["final"]);
  assert.deepEqual(detail.events.map((e) => e.type), ["sent", "submitted", "rejected", "submitted", "approved"]);
  // the dates are now written into the wording
  assert.match(detail.document.map((b) => b.text).join(" "), new RegExp(docs.longDate(a.effective_date)));

  const url = `/api/agreements/${id}/files/${a.final_file_id}/download`;
  assert.equal((await fetch(base + url)).status, 401);
  assert.equal((await fetch(base + url, { headers: { Authorization: `Bearer ${agent2T}` } })).status, 404);
  for (const t of [agentT, adminT]) {
    const ok = await fetch(base + url, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  }
  // the /pdf link serves the same stored file once the agreement is finished
  const viaPdf = await fetch(base + `/api/agreements/${id}/pdf`, { headers: { Authorization: `Bearer ${agentT}` } });
  assert.equal(viaPdf.status, 200);
  assert.equal((await json("POST", `/api/agreements/${id}/approve`, { token: adminT, body: SIGN_ADMIN() })).status, 409);
});

test("agents overview and filters", async () => {
  const all = await json("GET", "/api/agents", { token: adminT });
  assert.equal(all.body.data.length, 2);
  const sam = all.body.data.find((x) => x.email === "agent1@x.com");
  assert.equal(sam.agreement_status, "active");
  assert.equal(sam.agency_name, "Sam Education");
  assert.equal((await json("GET", "/api/agents?agreement=none", { token: adminT })).body.data.map((x) => x.email)[0], "agent2@x.com");
  assert.equal((await json("GET", "/api/agents?agreement=active", { token: adminT })).body.data.length, 1);
  assert.equal((await json("GET", "/api/agents?search=zed", { token: adminT })).body.data.length, 1);
  assert.equal((await json("GET", "/api/agents", { token: agentT })).status, 403);
});

test("expiry warnings are sent once per stage; expired status is automatic", async () => {
  await pool.query("UPDATE agreements SET expires_at = CURRENT_DATE + 20 WHERE id=$1", [id]);
  assert.equal((await json("GET", "/api/agents?agreement=expiring", { token: adminT })).body.data.length, 1);
  outbox.length = 0;
  assert.equal((await reminders.run()).expiry, 1);
  assert.ok(lastMail("agent1@x.com", /expires in 20 days/i));
  assert.equal((await reminders.run()).expiry, 0); // no repeat the same day

  await pool.query("UPDATE agreements SET expires_at = CURRENT_DATE + 5 WHERE id=$1", [id]);
  assert.equal((await reminders.run()).expiry, 1); // new stage (7 days)

  await pool.query("UPDATE agreements SET expires_at = CURRENT_DATE - 1 WHERE id=$1", [id]);
  const listed = await json("GET", "/api/agreements?status=expired", { token: adminT });
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].status, "expired");
  assert.equal((await reminders.run()).expiry, 1);
  assert.ok(lastMail("agent1@x.com", /has expired/i));
  assert.equal((await reminders.run()).expiry, 0);
  const sam = (await json("GET", "/api/agents", { token: adminT })).body.data.find((x) => x.email === "agent1@x.com");
  assert.equal(sam.agreement_status, "expired");
});

test("renewal: a new agreement replaces the old one when approved", async () => {
  const sent = await send({ agent_id: agentId, title: "Renewal 2027", validity_months: 24 });
  assert.equal(sent.status, 201);
  const id2 = sent.body.data.id;
  await json("POST", `/api/agreements/${id2}/sign`, { token: agentT, body: SIGN() });
  const ok = await json("POST", `/api/agreements/${id2}/approve`, { token: adminT, body: SIGN_ADMIN() });
  assert.equal(ok.body.data.status, "active");
  assert.equal(ok.body.data.validity_months, 24);
  const old = await json("GET", `/api/agreements/${id}`, { token: adminT });
  assert.equal(old.body.data.status, "superseded");
  id = id2;
});

test("reminders: unsigned agreements nudge the agent every 3 days, then stop at 5", async () => {
  const sent = await send({ agent_id: (await pool.query("SELECT id FROM users WHERE email='agent2@x.com'")).rows[0].id });
  const id3 = sent.body.data.id;
  outbox.length = 0;
  assert.equal((await reminders.run()).agent, 0); // too soon
  await pool.query("UPDATE agreements SET sent_at = now() - interval '4 days' WHERE id=$1", [id3]);
  assert.equal((await reminders.run()).agent, 1);
  assert.ok(lastMail("agent2@x.com", /reminder/i));
  assert.equal((await reminders.run()).agent, 0); // not again right away
  for (let i = 0; i < 6; i++) {
    await pool.query("UPDATE agreements SET last_reminder_at = now() - interval '4 days' WHERE id=$1", [id3]);
    await reminders.run();
  }
  const row = (await pool.query("SELECT reminder_count FROM agreements WHERE id=$1", [id3])).rows[0];
  assert.equal(row.reminder_count, 5);

  // review reminder for admins
  await json("POST", `/api/agreements/${id3}/sign`, { token: agent2T, body: SIGN("Zed Test") });
  await pool.query("UPDATE agreements SET submitted_at = now() - interval '3 days' WHERE id=$1", [id3]);
  outbox.length = 0;
  assert.equal((await reminders.run()).review, 1);
  assert.ok(lastMail("admin@afc.test", /needs review/i));
});

test("cancel withdraws an agreement and frees the agent", async () => {
  const id3 = (await pool.query("SELECT id FROM agreements WHERE status='submitted'")).rows[0].id;
  const r = await json("POST", `/api/agreements/${id3}/cancel`, { token: adminT, body: { reason: "Sent by mistake" } });
  assert.equal(r.body.data.status, "cancelled");
  assert.equal((await json("POST", `/api/agreements/${id3}/cancel`, { token: adminT, body: {} })).status, 409);
  const again = await send({ agent_id: (await pool.query("SELECT agent_id FROM agreements WHERE id=$1", [id3])).rows[0].agent_id });
  assert.equal(again.status, 201);
});

test("storage refuses paths outside its folder", async () => {
  assert.throws(() => storage.createReadStream("../../etc/passwd"));
});

test("audit trail records agreement actions", async () => {
  const n = (await pool.query("SELECT count(*)::int AS c FROM audit_logs WHERE action LIKE 'agreement.%'")).rows[0].c;
  assert.ok(n >= 8);
});
