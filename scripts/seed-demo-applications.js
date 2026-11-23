// Sample student applications for the demo agents (Phase 5). Called from seed-demo.js; uses the real services,
// so every rule (gate, validation, status log, audit) is applied exactly as in the portal.
const { pool } = require("../src/config/db");
const apps = require("../src/services/studentApplicationService");
const review = require("../src/services/studentReviewService");
const letters = require("../src/services/studentLetterService");
const reviewRepo = require("../src/repositories/studentAppRepo");

const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const PDF = { name: "demo-document.pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n% Demo document, not a real record\n"), Buffer.alloc(200, 0x20)]).toString("base64") };

const form = (courseId, campusId, who, over = {}) => ({
  course: { campus_id: campusId, course_id: courseId, commencement_date: iso(75) },
  student: { title: who.title, given_names: who.given, surname: who.surname, date_of_birth: who.dob, country_of_birth: who.country, nationality: who.nationality, gender: who.gender, phone: "+00 000 000 000", email: `${who.given}.${who.surname}@student.demo.example`.toLowerCase() },
  addresses: { overseas: { street: "1 Demo Street", suburb: who.city, country: who.country }, mailing: { same_as_above: true } },
  passport: { number: who.passport, expiry: "2033-05-01", country: who.country },
  visa: { holds_visa: false, apply_where: who.city },
  oshc: { has_oshc: false, afc_arrange: true },
  current_studies: { enrolled_elsewhere: false },
  language: { other_language: true, language: who.language, english_ability: "well", indigenous: "no" },
  english: { tested: true, test_type: "IELTS", test_date: iso(-120), overall: "6.0", listening: "6.0", reading: "6.0", writing: "6.0", speaking: "6.0", report_id: "DEMO-" + who.passport },
  disability: { answer: "no" },
  schooling: { highest_level: "year12", year_completed: 2019, still_enrolled: false },
  previous_quals: { has_any: false },
  employment: { status: "unemployed_full_time" },
  study_reason: { reason: "better_job" },
  credit: { apply: false },
  usi: { has_usi: false },
  emergency: { name: "Demo Parent", relationship: "Parent", phone: "+00 000 000 001" },
  extra_fees: { pay_more_than_50: false },
  agent: { counsellor_name: "Demo Counsellor", counsellor_email: "counsellor@demo.example", phone: "+00 000 000 002", counsellor_marn: "1234567" },
  declaration: { items: [true, true, true, true, true, true], student_name: `${who.given} ${who.surname}`, date: iso(-1) },
  confirmations: { pre_enrolment_sent: true, agent_not_signed: true, docs_received_on: iso(0) },
  ...over,
});

async function seed() {
  const cfgUser = (await pool.query(`SELECT u.id, u.role FROM users u WHERE lower(u.email) = 'director.goldengate@demo.example'`)).rows[0];
  const staff = async (email) => (await pool.query(`SELECT id, role FROM users WHERE lower(email) = $1`, [email])).rows[0];
  const admissions = await staff("admissions@demo.example");
  if (!cfgUser || !admissions) return 0;
  const already = (await pool.query(`SELECT count(*)::int AS n FROM student_applications a JOIN agents g ON g.id = a.agent_id WHERE g.email LIKE '%@demo.example' AND a.ref_no IS NOT NULL`)).rows[0].n;
  if (already) return 0;
  const user = { id: cfgUser.id, role: cfgUser.role };

  const cfg = await apps.formConfig(user);
  if (!cfg.can_submit) { console.log("Skipped demo student applications: the Golden Gate demo agent has not finished the induction."); return 0; }
  const mel = cfg.campuses.find((c) => c.name === "Melbourne").id;
  const lau = cfg.campuses.find((c) => c.name === "Launceston").id;
  const course = (code, spec) => cfg.courses.find((c) => c.code === code && (!spec || c.specialisation === spec)).id;
  const required = cfg.doc_types.filter((t) => t.required);

  const people = [
    { given: "Wei", surname: "Zhang", title: "mr", gender: "male", dob: "2001-02-11", country: "China", nationality: "Chinese", city: "Shanghai", language: "Mandarin", passport: "E1234001" },
    { given: "Mei", surname: "Lin", title: "ms", gender: "female", dob: "1999-09-30", country: "China", nationality: "Chinese", city: "Shenzhen", language: "Mandarin", passport: "E1234002" },
    { given: "Hao", surname: "Chen", title: "mr", gender: "male", dob: "2000-06-02", country: "China", nationality: "Chinese", city: "Beijing", language: "Mandarin", passport: "E1234003" },
    { given: "Xin", surname: "Wang", title: "ms", gender: "female", dob: "1998-12-12", country: "China", nationality: "Chinese", city: "Chengdu", language: "Mandarin", passport: "E1234004" },
    { given: "Jun", surname: "Liu", title: "mr", gender: "male", dob: "2002-04-20", country: "China", nationality: "Chinese", city: "Wuhan", language: "Mandarin", passport: "E1234005" },
    { given: "Yan", surname: "Huang", title: "ms", gender: "female", dob: "1997-08-08", country: "China", nationality: "Chinese", city: "Xiamen", language: "Mandarin", passport: "E1234006" },
  ];
  const make = async (who, c, campus, over) => {
    const id = (await apps.createDraft(user, {})).id;
    await apps.saveDraft(user, id, { data: form(c, campus, who, over) }, {});
    for (const t of required) await apps.addDocument(user, id, { kind: t.key, file: PDF }, {});
    await apps.submit(user, id, {});
    return id;
  };
  const backdate = (id, daysAgo) => pool.query(`UPDATE student_applications SET submitted_at = now() - ($2 || ' days')::interval WHERE id = $1`, [id, String(daysAgo)]);
  const dueIn = (id, n) => pool.query(`UPDATE student_applications SET assessment_due = $2 WHERE id = $1`, [id, iso(n)]);

  // 1 just received, 2 under review and due tomorrow, 3 waiting for the agent, 4 offer, 5 not offered, 6 flagged
  const a1 = await make(people[0], course("BSB50420"), mel);
  const a2 = await make(people[1], course("ICT60220", "Cyber Security Specialisation"), mel);
  await review.startReview(admissions, a2, {}); await backdate(a2, 5); await dueIn(a2, 1);
  const a3 = await make(people[2], course("CHC52025"), mel);
  const d3 = (await reviewRepo.docs(a3)).find((d) => d.kind === "passport");
  await review.reviewDocument(admissions, a3, d3.id, { status: "needs_update", note: "The photo page is cut off. Please send the full page." }, {});
  await review.requestInfo(admissions, a3, { note: "Please send a clearer copy of the passport photo page." }, {});
  const a4 = await make(people[3], course("BSB50420"), lau);
  await review.startReview(admissions, a4, {});
  await review.decide(admissions, a4, { decision: "offer" }, {});
  await letters.prepareLetter(admissions, a4, {}); // a draft for the Director to review; wording is not confirmed, so it cannot be issued yet
  const a5 = await make(people[4], course("ICT60220", "Cyber Security Specialisation"), lau);
  await review.decide(admissions, a5, { decision: "not_offered", reason: "The student does not meet the entry requirements for this course." }, {});
  const a6 = await make(people[5], course("BSB50420"), mel, {
    current_studies: { enrolled_elsewhere: true, provider: "Demo College", course_name: "Diploma of Business", course_start: iso(-150), months_completed: 5, is_principal: true, released: false },
    credit: { apply: true }, confirmations: { pre_enrolment_sent: true, agent_not_signed: true, docs_received_on: iso(-4) },
  });
  await pool.query(`UPDATE student_applications SET submitted_at = now() - interval '2 days' WHERE id IN ($1,$2)`, [a1, a6]);
  return 6;
}

// removes the sample applications (they are 7-year records, so the guards are lifted only for demo agents)
async function remove() {
  const keep = ["student_applications", "application_documents", "application_status_log", "letters_of_offer"];
  const demo = "(SELECT id FROM agents WHERE email LIKE '%@demo.example')";
  const storage = require("../src/services/fileStorage");
  for (const t of keep) await pool.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    const files = (await pool.query(`SELECT f.id, f.storage_key FROM application_documents d JOIN coms_files f ON f.id = d.file_id WHERE d.application_id IN (SELECT id FROM student_applications WHERE agent_id IN ${demo})`)).rows;
    const appIds = `(SELECT id FROM student_applications WHERE agent_id IN ${demo})`;
    files.push(...(await pool.query(`SELECT f.id, f.storage_key FROM coms_files f WHERE f.id IN (SELECT file_id FROM letters_of_offer WHERE application_id IN ${appIds} AND file_id IS NOT NULL) OR f.id IN (SELECT coe_file_id FROM student_applications WHERE id IN ${appIds}) OR f.id IN (SELECT voe_file_id FROM student_applications WHERE id IN ${appIds})`)).rows);
    await pool.query(`DELETE FROM letters_of_offer WHERE application_id IN ${appIds}`);
    await pool.query(`DELETE FROM application_status_log WHERE application_id IN (SELECT id FROM student_applications WHERE agent_id IN ${demo})`);
    await pool.query(`DELETE FROM application_documents WHERE application_id IN (SELECT id FROM student_applications WHERE agent_id IN ${demo})`);
    await pool.query(`DELETE FROM student_applications WHERE agent_id IN ${demo}`);
    for (const f of files) { await pool.query(`DELETE FROM coms_files WHERE id = $1`, [f.id]); await storage.remove(f.storage_key).catch(() => null); }
  } finally {
    for (const t of keep) await pool.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
}

module.exports = { seed, remove };
