// Adds sample data covering every screen built so far: demo staff logins for each role, agents at every stage with
// their application answers, documents, referees, due diligence, agreements, a certificate, tasks, status history and audit entries.
// Safe to run again (skips what already exists). Demo emails end in @demo.example, so nothing is ever emailed.
// Usage: npm run seed:demo      Remove again: npm run seed:demo -- --remove
// Every demo login uses the password in DEMO_PASSWORD (default Passw0rd@1).
require("dotenv").config();
const crypto = require("crypto");
const { pool } = require("../src/config/db");
const { hashPassword } = require("../src/utils/password");
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "Passw0rd@1";

const STAFF = [
  ["ceo", "Cathy", "Chief", "ceo@demo.example"], ["director", "Sohel", "Director", "director@demo.example"],
  ["marketing_officer", "Maya", "Marketing", "marketing@demo.example"], ["admissions", "Adam", "Admissions", "admissions@demo.example"],
  ["coe_admin", "Cleo", "CoE", "coe@demo.example"], ["accounts", "Alan", "Accounts", "accounts@demo.example"],
  ["compliance", "Cora", "Compliance", "compliance@demo.example"],
];

const day = (n) => (n == null ? null : new Date(Date.now() + n * 86400000).toISOString().slice(0, 10));
const ts = (n) => (n == null ? null : new Date(Date.now() + n * 86400000).toISOString());
const plus = (n, k) => (n == null ? null : n + k);

const GOOD = { known_for: "About six years as a sub-agent for our group.", worked_with: true, honest: true, accurate_info: true, complaints: false, recommend: true, comments: "Reliable and well organised." };
const BAD = { known_for: "Met at a conference.", worked_with: true, honest: false, accurate_info: false, complaints: true, complaints_detail: "Two students were given wrong visa advice.", recommend: false };

const EXTRA = (a) => ({
  services: ["Student counselling", "Course selection", "Visa document checking"], offshore_offices: [], sub_contractors: [], offshore_partners: [],
  registrations: [{ number: "REG-" + a.name.length * 977, country: a.country }],
  recruited_australia: [{ sector: "VET", students: 25 }], recruited_other: [{ sector: "Schools (UK)", students: 10 }],
  esos_read: true, esos_intend: null, national_code_read: true, national_code_intend: null,
  experience_education: "Over six years placing students with Australian providers.", experience_other: "",
  markets: [{ area: a.country, characteristics: "Growing demand for vocational study" }], potential_markets: "", memberships: ["Local education agents association"],
  services_to_afc: "Recruit and counsel students, check documents and refer enrolments to the college.",
});

const AGENTS = [
  { name: "Demo - Aurora Overseas", country: "Brazil", email: "aurora@demo.example", status: "prospect", received: null, invite: true },
  { name: "Demo - Mekong Education Services", country: "Vietnam", email: "mekong@demo.example", status: "applied", received: -2, login: true },
  { name: "Demo - Himalaya Study Bridge", country: "Nepal", email: "himalaya@demo.example", status: "due_diligence", received: -3,
    referees: [["Prof Sunita Rai", "Kathmandu University", "sunita@demo.example", "positive"], ["Mr Arjun Thapa", "Everest College", "arjun@demo.example", "pending"]] },
  { name: "Demo - Cedar Global Pathways", country: "Lebanon", email: "cedar@demo.example", status: "due_diligence", received: -17, // past day 10: shows red
    referees: [["Ms Lina Haddad", "Beirut Academy", "lina@demo.example", "negative"]] },
  { name: "Demo - Southern Cross Agents", country: "Australia", email: "southerncross@demo.example", status: "due_diligence", received: -11, // day 7+: shows amber
    referees: [["Dr Paul Nguyen", "Melbourne Skills", "paul@demo.example", "positive"], ["Ms Kim Ellis", "Hobart Training", "kim@demo.example", "positive"]], checks: true },
  { name: "Demo - Lotus Education Group", country: "India", email: "lotus@demo.example", status: "approved", received: -14, decided: -4, login: true, agreement: "sent",
    referees: [["Dr Meera Shah", "Pune Institute", "meera@demo.example", "positive"]], checks: true },
  { name: "Demo - Pacific Rim Students", country: "Philippines", email: "pacificrim@demo.example", status: "onboarding", received: -30, decided: -20, prisms: true, login: true, agreement: "active", effective: -17,
    referees: [["Mr Ben Cruz", "Manila College", "ben@demo.example", "positive"]], checks: true, tasks: "onboarding" },
  { name: "Demo - Golden Gate Overseas", country: "China", email: "goldengate@demo.example", status: "active", received: -90, decided: -80, prisms: true, induction: true, login: true, agreement: "active", effective: -75,
    referees: [["Ms Wei Zhang", "Shanghai Partners", "wei@demo.example", "positive"]], checks: true, tasks: "done" },
  { name: "Demo - Sunrise Education Partners", country: "Indonesia", email: "sunrise@demo.example", status: "active", received: -370, decided: -360, prisms: true, induction: true, login: true, agreement: "active", effective: -340,
    referees: [["Ms Dewi Lestari", "Jakarta Language Centre", "dewi@demo.example", "positive"]], checks: true, tasks: "done" },
  { name: "Demo - Quick Visa Co", country: "Nigeria", email: "quickvisa@demo.example", status: "rejected", received: -40, decided: -30, reason: "Two referees reported misleading advice to students.",
    referees: [["Mr Tunde Bello", "Lagos School", "tunde@demo.example", "negative"]], checks: true },
];

async function remove() {
  // online-induction completions and acknowledgements are evidence (guarded by triggers): lift the guard only for the demo agents
  const demo = "(SELECT id FROM agents WHERE email LIKE '%@demo.example')";
  // Phase 4 records are kept for 7 years (delete is blocked by triggers). Lift the guard only for the demo agents, then put it back.
  const keep = ["agent_communications", "agent_leads", "agent_training_records", "agent_corrective_actions", "agent_monitoring_reviews", "marketing_broadcast_deliveries", "marketing_broadcasts", "agents"];
  for (const t of keep) await pool.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  let r;
  try {
    for (const t of ["agent_communications", "agent_leads", "agent_training_records", "agent_corrective_actions", "agent_monitoring_reviews", "marketing_broadcast_deliveries"]) {
      await pool.query(`DELETE FROM ${t} WHERE agent_id IN ${demo}`);
    }
    await pool.query("DELETE FROM marketing_broadcast_deliveries WHERE broadcast_id IN (SELECT id FROM marketing_broadcasts WHERE subject LIKE '[Demo]%')");
    await pool.query("DELETE FROM marketing_broadcasts WHERE subject LIKE '[Demo]%'");
    await pool.query("DELETE FROM coms_tasks WHERE type = 'MONITORING' AND agent_id IN " + demo);
  for (const t of ["induction_completions", "pp_acknowledgements"]) {
    await pool.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    try { await pool.query(`DELETE FROM ${t} WHERE agent_id IN ${demo}`); } finally { await pool.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`); }
  }
  await pool.query(`DELETE FROM marketing_material_deliveries WHERE agent_id IN ${demo}`);
  const mats = (await pool.query(`SELECT m.id, f.id AS file_id, f.storage_key FROM marketing_materials m JOIN coms_files f ON f.id = m.file_id WHERE f.original_name LIKE 'demo-%'`)).rows;
  for (const m of mats) {
    await pool.query("DELETE FROM marketing_material_deliveries WHERE material_id = $1", [m.id]);
    await pool.query("DELETE FROM marketing_materials WHERE id = $1", [m.id]);
    await pool.query("DELETE FROM coms_files WHERE id = $1", [m.file_id]);
    await require("../src/services/fileStorage").remove(m.storage_key).catch(() => null);
  }
  await pool.query("DELETE FROM agent_inductions WHERE agent_id IN (SELECT id FROM agents WHERE email LIKE '%@demo.example')");
  r = await pool.query("DELETE FROM agents WHERE email LIKE '%@demo.example' RETURNING id");
  } finally {
    for (const t of keep) await pool.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
  const u = await pool.query("DELETE FROM users WHERE email LIKE '%@demo.example'");
  await pool.query("DELETE FROM invitations WHERE email LIKE '%@demo.example'");
  console.log(`Removed ${r.rowCount} demo agents and ${u.rowCount} demo logins (their referees, checks, agreements and tasks go with them).`);
}

async function main() {
  if (process.argv.includes("--remove")) return remove();
  const hash = await hashPassword(DEMO_PASSWORD);
  for (const [role, first, last, email] of STAFF) {
    await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, status, consent_at) SELECT $1::varchar,$2,$3,$4,$5,'active',now() WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1::varchar))`,
      [email, hash, first, last, role]);
  }
  const staff = async (role) => (await pool.query("SELECT id FROM users WHERE role=$1 AND is_active IS NOT FALSE ORDER BY id LIMIT 1", [role]).catch(() => pool.query("SELECT id FROM users WHERE role=$1 ORDER BY id LIMIT 1", [role]))).rows[0]?.id || null;
  const marketing = await staff("marketing_officer"), director = await staff("director"), compliance = await staff("compliance"), coe = await staff("coe_admin"), ceo = await staff("ceo");
  const template = (await pool.query("SELECT id, body FROM agreement_templates WHERE is_active ORDER BY id DESC LIMIT 1")).rows[0];
  const logins = [];
  let added = 0;
  for (const a of AGENTS) {
    if ((await pool.query("SELECT 1 FROM agents WHERE lower(email)=$1", [a.email])).rowCount) continue;
    const marn = a.country === "Australia" ? null : "1" + String(Math.abs(a.name.length * 7919)).padStart(6, "0");
    const decidedAt = a.decided != null ? ts(a.decided) : null;
    const { rows: [ag] } = await pool.query(
      `INSERT INTO agents (legal_name, country, email, status, source, principal_address, registered_office_address, phone, abn_acn, marn, is_body_corporate, account_manager_id,
         application_received_at, application_submitted_at, decision_due_date, coi_declared, code_of_ethics_ack_at, information_confirmed_at,
         prisms_recorded_at, induction_recorded_at, rejection_reason, created_by)
       VALUES ($1,$2,$3,$4,'website',$5,$5,'+61 3 9000 0000',$6,$7,true,$8,$9,$9,$10,false,$9,$9,$11,$12,$13,$8) RETURNING id`,
      [a.name, a.country, a.email, a.status, "1 Sample Street, " + a.country, "5" + String(10000000 + a.name.length * 104729).slice(0, 10), marn, marketing,
       ts(a.received), day(plus(a.received, 14)), a.prisms ? ts(a.decided + 5) : null, a.induction ? ts(a.decided + 10) : null, a.reason || null]);
    const id = ag.id;
    await pool.query(
      `UPDATE agents SET gst_registered = $2, owner_name = $3, staff_count = $4, years_in_business = $5, application_extra = $6::jsonb,
         privacy_agreed_at = application_submitted_at, declaration_name = $3, declaration_at = application_submitted_at,
         sms_contact_at = CASE WHEN $7 THEN application_received_at + interval '1 day' END,
         commission_terms = $8, bonus_terms = $9, terms_recorded_at = CASE WHEN $8::text IS NOT NULL THEN now() END,
         commission_vet_pct = CASE WHEN $8::text IS NOT NULL THEN 35 END, commission_elicos_pct = CASE WHEN $8::text IS NOT NULL THEN 30 END,
         terms_sent_at = CASE WHEN $8::text IS NOT NULL THEN now() END WHERE id = $1`,
      [id, a.country === "Australia", "Owner of " + a.name.replace("Demo - ", ""), 8, 6, JSON.stringify(EXTRA(a)), !['applied', 'prospect'].includes(a.status),
       a.status === "active" ? "VET courses: 35% of tuition fees paid. ELICOS courses: 30% of tuition fees paid (EAA Schedule 1)." : null, a.status === "active" ? "$500 after 10 enrolments in a year" : null]);
    if (!['applied', 'prospect'].includes(a.status)) {
      for (const kind of ["business_registration", "agency_profile"]) {
        const f = (await pool.query(
          `INSERT INTO coms_files (kind, original_name, storage_key, mime_type, size_bytes, sha256) VALUES ('agent_document',$1,$2,'application/pdf',10,$3) RETURNING id`,
          [`${kind}.pdf`, `demo/${id}/${kind}`, "0".repeat(64)])).rows[0].id;
        await pool.query("INSERT INTO agent_documents (agent_id, kind, file_id, status, reviewed_by, reviewed_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, kind, f, a.checks ? "accepted" : "received", a.checks ? marketing : null, a.checks ? ts(a.received + 1) : null]);
      }
    }
    await pool.query("INSERT INTO agent_persons (agent_id,name,email,role,is_director,is_primary_contact,involved_in_enrolments,created_by) VALUES ($1,$2,$3,'director',true,true,true,$4)", [id, "Director of " + a.name.replace("Demo - ", ""), "director." + a.email, marketing]);
    if (["due_diligence", "approved", "onboarding", "active", "rejected"].includes(a.status)) {
      await pool.query(
        `INSERT INTO agent_due_diligence (agent_id, opened_by, opened_at, preparers,
           abn_check_status, abn_checked_at, abn_checked_by, marn_check_status, marn_checked_at, marn_checked_by,
           prisms_check_status, prisms_checked_at, prisms_checked_by, coi_reviewed_at, coi_reviewed_by,
           decision, decision_reason, decided_by, decided_at)
         VALUES ($1,$2,$3,$4, $5,$6,$2, $5,$6,$2, $7,$6,$2, $8,$2, $9,$10,$11,$12)`,
        [id, marketing, ts(a.received), marketing ? [marketing] : [], a.checks ? "verified" : null, a.checks ? ts(a.received + 1) : null,
         a.checks ? "verified" : null, a.checks ? ts(a.received + 1) : null,
         ["approved", "onboarding", "active"].includes(a.status) ? "approved" : a.status === "rejected" ? "rejected" : null,
         a.status === "rejected" ? a.reason : ["approved", "onboarding", "active"].includes(a.status) ? "All checks verified." : null,
         decidedAt ? director : null, decidedAt]);
    }
    for (const [name, org, email, outcome] of a.referees || []) {
      const { rows: [r] } = await pool.query("INSERT INTO agent_referees (agent_id,name,organisation,email,phone,created_by) VALUES ($1,$2,$3,$4,'+61 400 000 000',$5) RETURNING id", [id, name, org, email, marketing]);
      if (outcome === "pending") {
        await pool.query("INSERT INTO referee_checks (agent_id,referee_id,method,sent_at,sent_by,outcome,created_by) VALUES ($1,$2,'email_form',$3,$4,'pending',$4)", [id, r.id, ts(a.received + 1), marketing]);
      } else {
        await pool.query(
          "INSERT INTO referee_checks (agent_id,referee_id,method,call_date,spoke_to,response_at,answers,outcome,outcome_by,summary,created_by) VALUES ($1,$2,'phone',$3,$4,$5,$6,$7,$8,$9,$8)",
          [id, r.id, day(a.received + 1), name, ts(a.received + 1), outcome === "positive" ? GOOD : BAD, outcome, marketing, outcome === "positive" ? "Strong, positive reference." : "Raised concerns about advice given to students."]);
      }
    }
    if (a.tasks) {
      const admin = await staff("admin");
      const rows = [["PRISMS_ADD", `Add ${a.name} to PRISMS`, "regulatory", compliance, "compliance", 5],
                    ["ASQANET_START", `Report ${a.name} to ASQAnet`, "regulatory", ceo, "ceo", 5],
                    ["WEBSITE_ADD", `List ${a.name} on the AFC website`, "regulatory", admin, "admin", 5],
                    ["COMMISSION_REPORT", `Record commission and bonus for ${a.name} and report to Accounts`, "general", marketing, "marketing_officer", 5],
                    ["INDUCTION", `Induct ${a.name} and record staff training`, "general", marketing, "marketing_officer", 30]];
      for (const [type, title, cat, owner, role, due] of rows) {
        const done = a.tasks === "done";
        await pool.query(
          `INSERT INTO coms_tasks (category,type,title,agent_id,trigger_event,trigger_date,due_date,due_basis,owner_id,owner_role,status,completed_at,completed_by,completion_note,created_by)
           VALUES ($1,$2,$3,$4,'agreement.countersigned',$5,$6,$7,$8,$9,$10,$11,$12,$13,$8)`,
          [cat, type, title, id, day(a.decided + 3), day(a.decided + 3 + due), type === "INDUCTION" ? "calendar" : "business", owner, role,
           done ? "done" : "open", done ? ts(a.decided + 6) : null, done ? owner : null, done ? "Completed (sample data)." : null]);
      }
    }
    // a prospect has only shown interest: no application answers yet
    if (a.status === "prospect") {
      await pool.query(`UPDATE agents SET coi_declared = NULL, code_of_ethics_ack_at = NULL, information_confirmed_at = NULL, application_extra = '{}'::jsonb,
        gst_registered = NULL, owner_name = NULL, staff_count = NULL, years_in_business = NULL, abn_acn = NULL, source = 'eoi' WHERE id = $1`, [id]);
    }

    // status history, so the Overview timeline is filled in
    const path = { prospect: ["prospect"], applied: ["prospect", "applied"], due_diligence: ["prospect", "applied", "due_diligence"],
      approved: ["prospect", "applied", "due_diligence", "approved"], onboarding: ["prospect", "applied", "due_diligence", "approved", "onboarding"],
      active: ["prospect", "applied", "due_diligence", "approved", "onboarding", "active"], rejected: ["prospect", "applied", "due_diligence", "rejected"] }[a.status];
    const base = a.received == null ? -3 : a.received;
    for (let i = 0; i < path.length; i++) {
      await pool.query("INSERT INTO agent_status_history (agent_id, from_status, to_status, reason, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, i ? path[i - 1] : null, path[i], i === 0 ? "Registered" : null, marketing, ts(i === 0 ? base - 1 : base + (a.decided != null ? Math.round((a.decided - base) * i / path.length) : i))]);
    }
    const note = (action, when, who, meta = {}) => pool.query("INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1,$2,'agent',$3,$4,$5)", [who, action, id, meta, when]);
    if (a.status !== "prospect") await note("agent.application_submitted", ts(a.received), null, { source: "website" });
    if (a.decided != null) await note(a.status === "rejected" ? "agent.rejected" : "agent.approved", ts(a.decided), director);

    // portal login for the agent's main contact
    let portalId = null;
    if (a.login) {
      const email = "director." + a.email;
      portalId = (await pool.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, status, consent_at) VALUES ($1,$2,'Demo',$3,'agent','active',now()) RETURNING id`,
        [email, await hashPassword(DEMO_PASSWORD), a.name.replace("Demo - ", "").split(" ")[0]])).rows[0].id;
      await pool.query(`INSERT INTO agent_profiles (user_id, agency_name, business_number, country, registered_via, email_verified_at, decided_by, decided_at) VALUES ($1,$2,$3,$4,'website',now(),$5,now())`,
        [portalId, a.name.replace("Demo - ", ""), String(10000000000 + a.name.length * 104729), a.country, director]);
      await pool.query("UPDATE agent_persons SET portal_user_id = $2 WHERE agent_id = $1 AND is_primary_contact", [id, portalId]);
      logins.push(`${email}  (${a.name.replace("Demo - ", "")}, ${a.status})`);
    }

    // agreements: sent to the agent, or signed and countersigned
    if (a.agreement && portalId && template) {
      const text = template.body.replace(/{{\s*agency_name\s*}}/g, a.name.replace("Demo - ", "")).replace(/{{\s*[a-z_]+\s*}}/g, "");
      const sha = crypto.createHash("sha256").update(text).digest("hex");
      const sentDay = a.decided + 1;
      const ag2 = (await pool.query(
        `INSERT INTO agreements (agent_id, title, status, validity_months, sent_by, sent_at, template_id, body_snapshot, body_sha256) VALUES ($1,'Education Agent Agreement',$2,12,$3,$4,$5,$6,$7) RETURNING id`,
        [portalId, a.agreement === "sent" ? "sent" : "active", marketing, ts(sentDay), template.id, text, sha])).rows[0].id;
      await pool.query("INSERT INTO agreement_events (agreement_id, actor_id, type, note, created_at) VALUES ($1,$2,'sent','Sample agreement',$3)", [ag2, marketing, ts(sentDay)]);
      await pool.query("INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, created_at) VALUES ($1,'agreement.sent','agreement',$2,$3)", [marketing, String(ag2), ts(sentDay)]);
      if (a.agreement === "active") {
        await pool.query(
          `UPDATE agreements SET submitted_at=$2, agent_sig_name=$3, agent_signed_at=$2, agent_signed_ip='127.0.0.1',
             reviewed_by=$4, reviewed_at=$5, admin_sig_name='Sohel RANA', admin_sig_position='Strategy & Growth Director', admin_signed_at=$5, admin_signed_ip='127.0.0.1',
             effective_date=$6, expires_at=($6::date + interval '12 months')::date WHERE id=$1`,
          [ag2, ts(sentDay + 1), "Owner of " + a.name.replace("Demo - ", ""), director, ts(a.effective - 1), day(a.effective)]);
        await pool.query("INSERT INTO agreement_events (agreement_id, actor_id, type, note, created_at) VALUES ($1,$2,'submitted',NULL,$3),($1,$4,'approved','Countersigned',$5)", [ag2, portalId, ts(sentDay + 1), director, ts(a.effective - 1)]);
        await pool.query("INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, created_at) VALUES ($1,'agreement.approved','agreement',$2,$3)", [director, String(ag2), ts(a.effective - 1)]);
      }
    }
    if (a.status === "active") {
      await pool.query("UPDATE agents SET certificate_sent_at = $2 WHERE id = $1", [id, ts(a.induction ? a.decided + 10 : -5)]);
      await note("agent.activated", ts(a.decided + 10), marketing);
      await note("agent.terms_recorded", ts(a.decided + 8), marketing);
      await note("agent.certificate_sent", ts(a.decided + 10), marketing);
    }
    if (a.invite) {
      await pool.query("INSERT INTO invitations (email, role, first_name, token_hash, invited_by, expires_at, agent_id) VALUES ($1,'agent','Aurora',$2,$3,$4,$5)",
        [a.email, crypto.randomBytes(32).toString("hex"), marketing, ts(10), id]);
    }
    added++;
  }
  // a couple of general tasks, one overdue
  const first = (await pool.query("SELECT id FROM agents WHERE email='goldengate@demo.example'")).rows[0];
  if (first && !(await pool.query("SELECT 1 FROM coms_tasks WHERE title LIKE 'Sample:%' LIMIT 1")).rowCount) {
    await pool.query(
      `INSERT INTO coms_tasks (category,type,title,description,agent_id,trigger_date,due_date,due_basis,owner_id,owner_role,created_by) VALUES
       ('general','GENERAL','Sample: send updated brochure to agent','Overdue example',$1,$2,$3,'business',$4,'marketing_officer',$4),
       ('general','GENERAL','Sample: schedule quarterly catch-up call','Upcoming example',$1,$2,$5,'business',$4,'marketing_officer',$4)`,
      [first.id, day(-10), day(-3), marketing, day(12)]);
  }
  // induction examples (Phase 3): one held, one booked online, one missed then re-booked by phone
  const induct = async (email, rows) => {
    const a = (await pool.query("SELECT id FROM agents WHERE email=$1", [email])).rows[0];
    if (!a || (await pool.query("SELECT 1 FROM agent_inductions WHERE agent_id=$1 LIMIT 1", [a.id])).rowCount) return;
    for (const r of rows) {
      await pool.query(
        `INSERT INTO agent_inductions (agent_id, status, mode, scheduled_for, held_on, start_time, meeting_url, location, conducted_by, attendees, notes, cancel_reason, created_by, updated_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,$9,$13)`,
        [a.id, r.status, r.mode, day(r.scheduled), day(r.held), r.time || null, r.url || null, r.where || null, r.by, r.attendees || null, r.notes || null, r.reason || null, ts(r.created)]);
    }
  };
  await induct("goldengate@demo.example", [{ status: "held", mode: "online", held: -70, scheduled: -72, time: "10:00", url: "https://teams.microsoft.com/l/meetup-join/demo-golden-gate", by: director,
    attendees: "Mr Li Wei (principal), Ms Chen (counsellor)", notes: "Covered the code of ethics, PRISMS rules, how to submit applications and commission reporting.", created: -73 }]);
  await induct("pacificrim@demo.example", [{ status: "scheduled", mode: "online", scheduled: 2, time: "10:30", url: "https://teams.microsoft.com/l/meetup-join/demo-pacific-rim", by: marketing, created: -1 }]);
  await induct("lotus@demo.example", [
    { status: "missed", mode: "online", scheduled: -6, time: "14:00", url: "https://teams.microsoft.com/l/meetup-join/demo-lotus", by: marketing, reason: "The agent did not join the call and did not reply to our email.", created: -9 },
    { status: "scheduled", mode: "phone", scheduled: 5, time: "11:00", where: "+91 98765 43210", by: marketing, created: -5 },
  ]);
  // online induction (Phase 3): Golden Gate finished and confirmed; Pacific Rim finished and is waiting for staff to confirm; Lotus is half way
  const online = async (email, count, ack, daysAgo) => {
    const a = (await pool.query("SELECT a.id, p.portal_user_id AS uid FROM agents a LEFT JOIN agent_persons p ON p.agent_id = a.id AND p.portal_user_id IS NOT NULL WHERE a.email=$1 LIMIT 1", [email])).rows[0];
    if (!a || (await pool.query("SELECT 1 FROM induction_completions WHERE agent_id=$1 LIMIT 1", [a.id])).rowCount) return;
    const mods = (await pool.query("SELECT id, version FROM induction_modules WHERE active ORDER BY position LIMIT $1", [count])).rows;
    let i = 0;
    for (const m of mods) {
      await pool.query(`INSERT INTO induction_completions (agent_id, module_id, module_version, user_id, completed_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,'203.0.113.10','Demo browser')`,
        [a.id, m.id, m.version, a.uid, ts(daysAgo + i * 0.01)]);
      i++;
    }
    const pp = ack && (await pool.query("SELECT id, version FROM pp_versions WHERE is_current")).rows[0];
    if (pp) await pool.query(`INSERT INTO pp_acknowledgements (agent_id, user_id, pp_version_id, pp_version, acknowledged_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,'203.0.113.10','Demo browser')`, [a.id, a.uid, pp.id, pp.version, ts(daysAgo + 0.1)]);
  };
  await online("goldengate@demo.example", 99, true, -74);
  await online("pacificrim@demo.example", 99, true, -1);
  await online("lotus@demo.example", 3, false, -2);
  await online("sunrise@demo.example", 99, true, -330);
  // marketing materials (Phase 3): two approved, one waiting for approval. Small generated PDFs stand in for AFC's real files.
  if (!(await pool.query("SELECT 1 FROM marketing_materials m JOIN coms_files f ON f.id = m.file_id WHERE f.original_name LIKE 'demo-%' LIMIT 1")).rowCount) {
    const PDFDocument = require("pdfkit");
    const storage = require("../src/services/fileStorage");
    const pdf = (title) => new Promise((resolve) => {
      const d = new PDFDocument(); const parts = [];
      d.on("data", (c) => parts.push(c)); d.on("end", () => resolve(Buffer.concat(parts)));
      d.fontSize(22).text(title); d.moveDown().fontSize(12).text("Sample material for the demo only. AFC replaces this with its real, approved file.");
      d.end();
    });
    for (const [title, category, version, desc, status, name] of [
      ["AFC agent brochure 2027", "brochure", "1.0", "Courses, campuses and entry requirements.", "approved", "demo-agent-brochure.pdf"],
      ["International student fee schedule", "fees", "2.1", "Tuition and fee schedule for 2027 intakes.", "approved", "demo-fee-schedule.pdf"],
      ["Updated refund policy summary", "policy", "1.0", "Waiting for Marketing to approve.", "draft", "demo-refund-policy.pdf"],
    ]) {
      const buf = await pdf(title);
      const saved = await storage.save(buf, "pdf", "coms");
      const f = (await pool.query(
        `INSERT INTO coms_files (kind, original_name, storage_key, mime_type, size_bytes, sha256, uploaded_by) VALUES ('marketing_material',$1,$2,'application/pdf',$3,$4,$5) RETURNING id`,
        [name, saved.key, saved.size ?? buf.length, saved.sha256 ?? crypto.createHash("sha256").update(buf).digest("hex"), marketing])).rows[0].id;
      await pool.query(
        `INSERT INTO marketing_materials (title, description, category, version, file_id, status, uploaded_by, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6::varchar,$7,CASE WHEN $6::text='approved' THEN $8::bigint END,CASE WHEN $6::text='approved' THEN now() - interval '5 days' END)`,
        [title, desc, category, version, f, status, marketing, director]);
    }
  }
  // the month-11 renewal task for Sunrise (the daily job does this on a live system)
  await require("../src/services/settingsService").ensureFresh();
  await require("../src/services/taskService").createRenewalTasks();
  // Phase 4 (agent CRM): communications, leads, training, a monitoring review with a corrective notice, and two broadcasts
  const demoAgent = async (email) => (await pool.query("SELECT id FROM agents WHERE email=$1", [email])).rows[0]?.id;
  const gg = await demoAgent("goldengate@demo.example"), sr = await demoAgent("sunrise@demo.example"), pr = await demoAgent("pacificrim@demo.example");
  if (gg && !(await pool.query("SELECT 1 FROM agent_communications WHERE agent_id = $1 LIMIT 1", [gg])).rowCount) {
    const comm = (agent, type, direction, daysAgo, staffId, subject, summary, source = "staff") => pool.query(
      `INSERT INTO agent_communications (agent_id, type, direction, occurred_at, staff_id, subject, summary, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [agent, type, direction, ts(daysAgo), staffId, subject, summary, source]);
    await comm(gg, "phone", "outbound", -60, marketing, "Welcome call", "Welcomed the agent, explained how to submit applications and where the marketing materials are.");
    await comm(gg, "email", "inbound", -40, null, "Question about intake dates", "Hello, when is the next intake for the Diploma of Leadership and Management?", "inbound_email");
    await comm(gg, "email", "outbound", -39, marketing, "Re: Question about intake dates", "Replied with the 2027 intake dates and the course page link.");
    await comm(gg, "meeting", "outbound", -20, director, "Quarterly catch-up", "Video call with Mr Li Wei. Agreed to focus on Melbourne campus IT diplomas. Agent asked about commission timing.");
    await comm(gg, "note", "internal", -19, director, null, "Agent is responsive and well organised. Will look at a higher tier at the next review.");
    await comm(sr, "phone", "outbound", -30, marketing, "Renewal heads-up", "Told the agent the agreement ends soon and we will send the renewal. Agent wants to renew.");
    await comm(sr, "email", "outbound", -12, marketing, "Corrected fee information", "Asked the agent to remove an old fee table from their website.");
    await comm(pr, "phone", "outbound", -3, marketing, "Induction reminder", "Reminded the agent to finish the online induction modules.");
    const lead = (agent, name, country, course, daysAgo, outcome, notes) => pool.query(
      `INSERT INTO agent_leads (agent_id, student_name, country, course_interest, contact_date, outcome, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [agent, name, country, course, day(daysAgo), outcome, notes || null]);
    await lead(gg, "Wang Fang", "China", "ICT50220 Diploma of Information Technology", -35, "submitted", "Application sent in.");
    await lead(gg, "Liu Yang", "China", "BSB50420 Diploma of Leadership and Management", -28, "submitted");
    await lead(gg, "Chen Hao", "China", "SIT50422 Diploma of Hospitality Management", -21, "not_proceeding", "Chose another provider.");
    await lead(gg, "Zhao Mei", "China", "General English (ELICOS)", -9, "pending");
    await lead(gg, "Sun Li", "China", "CHC52025 Diploma of Community Services", -3, "pending", "Waiting for English test result.");
    await lead(sr, "Budi Santoso", "Indonesia", "ICT60220 Advanced Diploma of Information Technology", -45, "submitted");
    await lead(sr, "Sari Dewi", "Indonesia", "AHC51422 Diploma of Agribusiness Management", -15, "pending");
    await pool.query(`INSERT INTO agent_training_records (agent_id, title, kind, held_on, delivered_by, notes, created_by) VALUES ($1,'Refresher: fees and refunds 2027','refresher',$2,'Maya Marketing','Online, 40 minutes. Covered the refund table and visa refusal rules.',$3)`, [sr, day(-25), marketing]);
    await pool.query(`INSERT INTO agent_training_records (agent_id, title, kind, held_on, delivered_by, created_by) VALUES ($1,'Product update: new IT specialisations','product_update',$2,'Sohel Director',$3)`, [gg, day(-14), director]);
    // monitoring: Sunrise's six-month review found a problem; a notice went out and is waiting for the agent to fix it
    const rev = (await pool.query(
      `INSERT INTO agent_monitoring_reviews (agent_id, period_start, period_end, applications_submitted, conversion_rate, student_performance, incidents_found, unauthorised_advice_found, unauthorised_advice_detail, outcome, notes, completed_by, completed_at)
       VALUES ($1,$2,$3,4,50,'Two of the four enrolled students are attending well. One is at risk on course progress.',false,true,'An old fee table was still on the agent website.','issues_found','Agent was cooperative.',$4,$5) RETURNING id`,
      [sr, day(-340), day(-160), marketing, ts(-158)])).rows[0].id;
    await pool.query(
      `INSERT INTO agent_corrective_actions (agent_id, review_id, issues, required_actions, due_date, notice_subject, notice_body, status, drafted_by, sent_by, sent_at, sent_to)
       VALUES ($1,$2,'An old fee table was on the agent website','Remove the old fee table and use the current fee schedule',$3,'Corrective action required: Education Agent Agreement',
       $4,'sent',$5,$5,$6,'sunrise@demo.example')`,
      [sr, rev, day(10), "Dear Demo - Sunrise Education Partners,\n\nOur six-monthly review identified the following:\n\n- An old fee table was on the agent website\n\nPlease do the following:\n\n- Remove the old fee table and use the current fee schedule\n\nFailing to carry out a corrective action is grounds for termination of the agreement.\n\nKind regards,\nAustralian Federation College", marketing, ts(-5)]);
    await comm(sr, "corrective_action", "outbound", -5, marketing, "Corrective action required: Education Agent Agreement", "Our six-monthly review identified an old fee table on the agent website. Please remove it by the due date.", "system");
    // the next monitoring task, so the Tasks board shows one
    const owner = marketing;
    const ag = (await pool.query("SELECT g.id FROM agreements g JOIN agent_persons p ON p.portal_user_id = g.agent_id WHERE p.agent_id = $1 AND g.status = 'active' LIMIT 1", [sr])).rows[0];
    await pool.query(
      `INSERT INTO coms_tasks (category, type, title, agent_id, agreement_id, trigger_event, trigger_date, due_date, due_basis, owner_id, owner_role, description)
       VALUES ('general','MONITORING','Complete the 6-monthly monitoring form for Demo - Sunrise Education Partners',$1,$2,'monitoring_period_2',$3,$4,'calendar',$5,'marketing_officer','Open the agent record, go to the Monitoring tab and complete the Agent Monitoring Form. Saving the form closes this task.')`,
      [sr, ag?.id || null, day(-1), day(25), owner]);
    // broadcasts: one sent, one waiting for the Director to approve
    const bc = (await pool.query(
      `INSERT INTO marketing_broadcasts (kind, subject, body, status, drafted_by, approved_by, approved_at, sent_at, recipients) VALUES ('fee','[Demo] AFC fee update for 2027',$1,'sent',$2,$3,$4,$4,2) RETURNING id`,
      ["We are writing to let you know about a fee update at Australian Federation College.\n\nWhat has changed:\n- Tuition fees for 2027 intakes are in the new fee schedule\n\nPlease use only the current approved materials.", marketing, director, ts(-8)])).rows[0].id;
    for (const a of [gg, sr]) {
      await pool.query("INSERT INTO marketing_broadcast_deliveries (broadcast_id, agent_id, sent_to, sent_at) VALUES ($1,$2,'demo',$3)", [bc, a, ts(-8)]);
      await comm(a, "broadcast", "outbound", -8, marketing, "[Demo] AFC fee update for 2027", "Tuition fees for 2027 intakes are in the new fee schedule.", "system");
    }
    await pool.query(
      `INSERT INTO marketing_broadcasts (kind, subject, body, status, drafted_by) VALUES ('policy','[Demo] Updated complaints policy','We have updated our complaints and appeals policy. The new version is on the AFC website.\n\nPlease use the current version when you talk to students.','draft',$1)`, [marketing]);
  }
  console.log(`Added ${added} demo agents. Their emails end in @demo.example. Remove with: npm run seed:demo -- --remove`);
  console.log(`\nDemo logins (password ${DEMO_PASSWORD}):`);
  for (const [role, , , email] of STAFF) console.log(`  ${email}  (${role})`);
  for (const l of logins) console.log(`  ${l}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
