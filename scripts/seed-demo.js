// Adds sample agents, referees and tasks so every Part 2 screen has something to show.
// Safe to run again (skips agents that already exist). Demo emails end in @demo.example, so nothing is ever emailed.
// Usage: npm run seed:demo      Remove again: npm run seed:demo -- --remove
require("dotenv").config();
const { pool } = require("../src/config/db");

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ts = (n) => new Date(Date.now() + n * 86400000).toISOString();

const GOOD = { known_for: "About six years as a sub-agent for our group.", worked_with: true, honest: true, accurate_info: true, complaints: false, recommend: true, comments: "Reliable and well organised." };
const BAD = { known_for: "Met at a conference.", worked_with: true, honest: false, accurate_info: false, complaints: true, complaints_detail: "Two students were given wrong visa advice.", recommend: false };

const AGENTS = [
  { name: "Demo - Mekong Education Services", country: "Vietnam", email: "mekong@demo.example", status: "applied", received: -2 },
  { name: "Demo - Himalaya Study Bridge", country: "Nepal", email: "himalaya@demo.example", status: "due_diligence", received: -3,
    referees: [["Prof Sunita Rai", "Kathmandu University", "sunita@demo.example", "positive"], ["Mr Arjun Thapa", "Everest College", "arjun@demo.example", "pending"]] },
  { name: "Demo - Cedar Global Pathways", country: "Lebanon", email: "cedar@demo.example", status: "due_diligence", received: -17, // past day 10: shows red
    referees: [["Ms Lina Haddad", "Beirut Academy", "lina@demo.example", "negative"]] },
  { name: "Demo - Southern Cross Agents", country: "Australia", email: "southerncross@demo.example", status: "due_diligence", received: -11, // day 7+: shows amber
    referees: [["Dr Paul Nguyen", "Melbourne Skills", "paul@demo.example", "positive"], ["Ms Kim Ellis", "Hobart Training", "kim@demo.example", "positive"]], checks: true },
  { name: "Demo - Lotus Education Group", country: "India", email: "lotus@demo.example", status: "approved", received: -14, decided: -4,
    referees: [["Dr Meera Shah", "Pune Institute", "meera@demo.example", "positive"]], checks: true },
  { name: "Demo - Pacific Rim Students", country: "Philippines", email: "pacificrim@demo.example", status: "onboarding", received: -30, decided: -20, prisms: true,
    referees: [["Mr Ben Cruz", "Manila College", "ben@demo.example", "positive"]], checks: true, tasks: "onboarding" },
  { name: "Demo - Golden Gate Overseas", country: "China", email: "goldengate@demo.example", status: "active", received: -90, decided: -80, prisms: true, induction: true,
    referees: [["Ms Wei Zhang", "Shanghai Partners", "wei@demo.example", "positive"]], checks: true, tasks: "done" },
  { name: "Demo - Quick Visa Co", country: "Nigeria", email: "quickvisa@demo.example", status: "rejected", received: -40, decided: -30, reason: "Two referees reported misleading advice to students.",
    referees: [["Mr Tunde Bello", "Lagos School", "tunde@demo.example", "negative"]], checks: true },
];

async function remove() {
  const r = await pool.query("DELETE FROM agents WHERE email LIKE '%@demo.example' RETURNING id");
  console.log(`Removed ${r.rowCount} demo agents (their referees, checks and tasks go with them).`);
}

async function main() {
  if (process.argv.includes("--remove")) return remove();
  const staff = async (role) => (await pool.query("SELECT id FROM users WHERE role=$1 AND is_active IS NOT FALSE ORDER BY id LIMIT 1", [role]).catch(() => pool.query("SELECT id FROM users WHERE role=$1 ORDER BY id LIMIT 1", [role]))).rows[0]?.id || null;
  const marketing = await staff("marketing_officer"), director = await staff("director"), compliance = await staff("compliance"), coe = await staff("coe_admin");
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
       ts(a.received), day(a.received + 14), a.prisms ? ts(a.decided + 5) : null, a.induction ? ts(a.decided + 10) : null, a.reason || null]);
    const id = ag.id;
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
      const rows = [["PRISMS_ADD", `Add ${a.name} to PRISMS`, "regulatory", coe, "coe_admin", 5],
                    ["ASQANET_START", `Send the ASQAnet notice for ${a.name}`, "regulatory", compliance, "compliance", 30],
                    ["WEBSITE_ADD", `Add ${a.name} to the website agent list`, "regulatory", marketing, "marketing_officer", 5],
                    ["INDUCTION", `Induct ${a.name} and record staff training`, "general", marketing, "marketing_officer", 30]];
      for (const [type, title, cat, owner, role, due] of rows) {
        const done = a.tasks === "done";
        await pool.query(
          `INSERT INTO coms_tasks (category,type,title,agent_id,trigger_event,trigger_date,due_date,due_basis,owner_id,owner_role,status,completed_at,completed_by,completion_note,created_by)
           VALUES ($1,$2,$3,$4,'agreement.countersigned',$5,$6,$7,$8,$9,$10,$11,$12,$13,$8)`,
          [cat, type, title, id, day(a.decided + 3), day(a.decided + 3 + due), cat === "regulatory" && type !== "ASQANET_START" ? "business" : "calendar", owner, role,
           done ? "done" : "open", done ? ts(a.decided + 6) : null, done ? owner : null, done ? "Completed (sample data)." : null]);
      }
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
  console.log(`Added ${added} demo agents. Their emails end in @demo.example. Remove with: npm run seed:demo -- --remove`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
