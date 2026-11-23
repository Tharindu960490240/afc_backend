// The student application form (AFC-AEF-Int V3.1). `build(false)` is the draft check: every box may still be empty.
// `build(true)` is the submit check: everything the form asks for must be answered.
const { z } = require("zod");

const blank = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const valid = (v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date").refine(valid, "Enter a valid date");

const ENUM = {
  title: ["mr", "miss", "ms", "mrs", "other"],
  gender: ["male", "female"],
  english_ability: ["very_well", "well", "not_well", "not_at_all"],
  indigenous: ["no", "aboriginal", "torres_strait", "both", "prefer_not"],
  test_type: ["IELTS", "TOEFL", "PTE", "other"],
  exemptions: ["passport_country", "secondary_au", "aqf_iv_au", "five_years_english", "elicos_only", "foreign_affairs", "none"],
  disability: ["yes", "no", "prefer_not"],
  disability_areas: [11, 12, 13, 14, 15, 16, 17, 18, 19],
  school_level: ["year12", "year11", "year10", "year9", "year8", "never"],
  qual_levels: ["bachelor", "advanced_diploma", "diploma", "cert_iv", "cert_iii", "cert_ii", "cert_i", "other"],
  employment: ["full_time", "part_time", "self_employed_alone", "self_employed_employing", "family_business", "unemployed_full_time", "unemployed_part_time", "not_seeking"],
  study_reason: ["job", "develop_business", "start_business", "different_career", "better_job", "requirement_of_job", "extra_skills", "other_course", "personal_interest", "community_work", "other"],
};
const OPTIONS = ENUM;

function build(strict) {
  const R = (s) => z.preprocess(blank, strict ? s : s.optional());         // required on submit
  const O = (s) => z.preprocess(blank, s.optional());                      // never required
  const txt = (max, msg) => z.string().trim().min(1, msg || "This is required").max(max);
  const bool = () => z.boolean("Choose Yes or No");
  const num = (min, max) => z.coerce.number().int().min(min).max(max);

  const address = (extra = {}) => z.object({
    street: R(txt(200, "Enter the street address")), suburb: R(txt(100, "Enter the suburb")), postcode: O(z.string().trim().max(12)),
    country: O(z.string().trim().max(100)), ...extra,
  }).strict();

  const course = z.object({
    campus_id: R(z.coerce.number().int().positive("Choose a campus")),
    course_id: R(z.coerce.number().int().positive("Choose a course")),
    commencement_date: R(ymd),
    elicos_weeks: O(num(1, 200)),
  }).strict();

  const student = z.object({
    title: R(z.enum(ENUM.title)), given_names: R(txt(120, "Enter the given names")), surname: R(txt(120, "Enter the surname")),
    preferred_name: O(z.string().trim().max(120)), date_of_birth: R(ymd), country_of_birth: R(txt(100)), nationality: R(txt(100)),
    gender: R(z.enum(ENUM.gender)), phone: R(txt(60, "Enter a phone number")), email: R(z.string().trim().toLowerCase().email("Enter a valid email address").max(254)),
  }).strict();

  const addresses = z.object({
    overseas: (strict ? (x) => x : (x) => x.optional())(address({ country: R(txt(100, "Enter the country")), is_mailing: O(z.boolean()) })),
    australian: z.object({ street: O(z.string().trim().max(200)), suburb: O(z.string().trim().max(100)), state: O(z.string().trim().max(40)), postcode: O(z.string().trim().max(12)), is_mailing: O(z.boolean()) }).strict().optional(),
    mailing: z.object({ same_as_above: O(z.boolean()), street: O(z.string().trim().max(200)), suburb: O(z.string().trim().max(100)), postcode: O(z.string().trim().max(12)), country: O(z.string().trim().max(100)) }).strict().optional(),
  }).strict();

  const passport = z.object({ number: R(z.string().trim().min(3, "Enter the passport number").max(40)), expiry: R(ymd), country: R(txt(100)) }).strict();
  const visa = z.object({ holds_visa: R(bool()), type: O(z.string().trim().max(100)), expiry: O(ymd), apply_where: R(txt(200, "Say where the student will apply")) }).strict();
  const oshc = z.object({ has_oshc: R(bool()), provider: O(z.string().trim().max(120)), expiry: O(ymd), afc_arrange: O(bool()) }).strict();
  const current_studies = z.object({
    enrolled_elsewhere: R(bool()), provider: O(z.string().trim().max(160)), cricos_provider: O(z.string().trim().max(20)), course_start: O(ymd),
    course_name: O(z.string().trim().max(200)), coe_number: O(z.string().trim().max(40)), months_completed: O(num(0, 120)),
    is_principal: O(bool()), released: O(bool()),
  }).strict();
  const language = z.object({
    other_language: R(bool()), language: O(z.string().trim().max(80)), english_ability: R(z.enum(ENUM.english_ability)), indigenous: R(z.enum(ENUM.indigenous)),
  }).strict();
  const score = O(z.string().trim().max(10));
  const english = z.object({
    tested: R(bool()), test_date: O(ymd), test_type: O(z.enum(ENUM.test_type)), test_type_other: O(z.string().trim().max(60)),
    writing: score, reading: score, listening: score, speaking: score, overall: score, report_id: O(z.string().trim().max(60)),
    exemptions: z.array(z.enum(ENUM.exemptions)).max(7).optional(),
  }).strict();
  const disability = z.object({ answer: R(z.enum(ENUM.disability)), areas: z.array(z.coerce.number().int().refine((n) => ENUM.disability_areas.includes(n), "Choose from the list")).max(9).optional() }).strict();
  const schooling = z.object({ highest_level: R(z.enum(ENUM.school_level)), year_completed: O(num(1950, 2100)), still_enrolled: R(bool()) }).strict();
  const previous_quals = z.object({
    has_any: R(bool()), levels: z.array(z.enum(ENUM.qual_levels)).max(8).optional(),
    items: z.array(z.object({ name: O(z.string().trim().max(200)), institution: O(z.string().trim().max(200)), year: O(num(1950, 2100)), country: O(z.string().trim().max(100)) }).strict()).max(4).optional(),
  }).strict();
  const employment = z.object({ status: R(z.enum(ENUM.employment)) }).strict();
  const study_reason = z.object({ reason: R(z.enum(ENUM.study_reason)) }).strict();
  const credit = z.object({ apply: R(bool()) }).strict();
  const usi = z.object({ has_usi: R(bool()), usi: O(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, "A USI is 10 letters and numbers")) }).strict();
  const emergency = z.object({
    name: R(txt(120, "Enter the contact's name")), relationship: R(txt(80, "Enter the relationship")), phone: R(txt(60, "Enter a phone number")),
    email: O(z.string().trim().toLowerCase().email("Enter a valid email address").max(254)),
  }).strict();
  const extra_fees = z.object({ pay_more_than_50: R(bool()) }).strict();
  const agent = z.object({
    counsellor_name: R(txt(120, "Enter the counsellor's name")), counsellor_email: R(z.string().trim().toLowerCase().email("Enter a valid email address").max(254)),
    position: O(z.string().trim().max(120)), phone: R(txt(60, "Enter a phone number")), counsellor_marn: R(z.string().trim().min(5, "Enter the counsellor's MARN").max(20)),
  }).strict();
  const declaration = z.object({ items: z.array(z.boolean()).max(12).optional(), student_name: R(txt(160, "Enter the student's name")), date: R(ymd) }).strict();
  const confirmations = z.object({ pre_enrolment_sent: O(z.boolean()), agent_not_signed: O(z.boolean()), docs_received_on: R(ymd) }).strict();

  const all = z.object({
    course, student, addresses, passport, visa, oshc, current_studies, language, english, disability, schooling, previous_quals,
    employment, study_reason, credit, usi, emergency, extra_fees, agent, declaration, confirmations,
  }).strict();
  return strict ? all : all.partial();
}

const draftSchema = z.object({ data: build(false) }).strict();
const submitForm = build(true);
const SECTIONS = Object.keys(submitForm.shape);

// "Yes" answers that make other boxes required, and the cross-checks the form implies.
// Returns { section: { field: message } } so the screens can show the message next to the box.
function conditionalErrors(d) {
  const e = {};
  const need = (section, field, msg) => { (e[section] = e[section] || {})[field] = msg; };
  const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  const g = (s, f) => (d[s] || {})[f];
  if (g("visa", "holds_visa") === true) { if (empty(g("visa", "type"))) need("visa", "type", "Enter the visa type"); if (empty(g("visa", "expiry"))) need("visa", "expiry", "Enter the expiry date"); }
  if (g("oshc", "has_oshc") === true) { if (empty(g("oshc", "provider"))) need("oshc", "provider", "Enter the OSHC provider"); if (empty(g("oshc", "expiry"))) need("oshc", "expiry", "Enter the expiry date"); }
  if (g("oshc", "has_oshc") === false && g("oshc", "afc_arrange") === undefined) need("oshc", "afc_arrange", "Say whether AFC should arrange OSHC");
  if (g("language", "other_language") === true && empty(g("language", "language"))) need("language", "language", "Enter the language");
  if (g("current_studies", "enrolled_elsewhere") === true) {
    for (const [f, m] of [["provider", "Enter the provider"], ["course_name", "Enter the course"], ["course_start", "Enter the start date"], ["months_completed", "Enter the months completed"], ["is_principal", "Choose Yes or No"], ["released", "Choose Yes or No"]]) if (empty(g("current_studies", f))) need("current_studies", f, m);
  }
  if (g("english", "tested") === true) {
    for (const [f, m] of [["test_date", "Enter the test date"], ["test_type", "Choose the test"], ["overall", "Enter the overall score"], ["report_id", "Enter the report or result number"]]) if (empty(g("english", f))) need("english", f, m);
    if (g("english", "test_type") === "other" && empty(g("english", "test_type_other"))) need("english", "test_type_other", "Enter the test name");
  } else if (g("english", "tested") === false && empty(g("english", "exemptions"))) need("english", "exemptions", "Choose an exemption, or None of the above");
  if (g("disability", "answer") === "yes" && empty(g("disability", "areas"))) need("disability", "areas", "Choose at least one area");
  if (g("schooling", "highest_level") && g("schooling", "highest_level") !== "never" && empty(g("schooling", "year_completed"))) need("schooling", "year_completed", "Enter the year");
  if (g("previous_quals", "has_any") === true) {
    if (empty(g("previous_quals", "levels"))) need("previous_quals", "levels", "Choose the levels completed");
    const first = (g("previous_quals", "items") || [])[0];
    if (!first || empty(first.name) || empty(first.institution)) need("previous_quals", "items", "Enter at least one qualification");
  }
  if (g("usi", "has_usi") === true && empty(g("usi", "usi"))) need("usi", "usi", "Enter the USI");
  const mail = (d.addresses || {}).mailing || {};
  if (!mail.same_as_above && (empty(mail.street) || empty(mail.suburb) || empty(mail.country))) need("addresses", "mailing", "Enter the mailing address, or tick that it is the same as above");
  return e;
}

const upload = z.object({ name: z.string().trim().min(1).max(255), data: z.string().min(10) }).strict();
const docBody = z.object({ kind: z.string().trim().min(1).max(60), label: z.string().trim().max(160).optional(), file: upload }).strict();
const idParam = z.object({ id: z.string().uuid() });
const docParams = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
const formParams = z.object({ formId: z.string().uuid() });

// ---- administrators ----
const settingsBody = z.object({
  declaration_items: z.array(z.string().trim().min(5).max(800)).min(1).max(12),
  privacy_notice: z.string().trim().min(5).max(6000),
  agent_not_signed_text: z.string().trim().min(5).max(800),
  pre_enrolment_text: z.string().trim().min(5).max(800),
  docs_deadline_hours: z.coerce.number().int().min(1).max(240),
  assessment_working_days: z.coerce.number().int().min(1).max(30),
  loo_template: z.string().trim().min(20).max(8000).optional(),
  loo_conditions: z.string().trim().min(5).max(4000).optional(),
  loo_signer_name: z.string().trim().min(2).max(120).optional(),
  loo_signer_title: z.string().trim().min(2).max(160).optional(),
  voe_template: z.string().trim().min(20).max(4000).optional(),
  letters_confirmed: z.boolean().optional(),
}).strict();
const docTypesBody = z.object({
  items: z.array(z.object({
    key: z.string().trim().max(40).optional(), label: z.string().trim().min(3).max(200), required: z.boolean(), active: z.boolean(),
  }).strict()).min(1).max(30),
}).strict();
const formUploadBody = z.object({ label: z.string().trim().min(3).max(160), file: upload }).strict();
const formToggleBody = z.object({ active: z.boolean() }).strict();

// ---- staff ----
const reviewQuery = z.object({ status: z.enum(["received", "under_review", "info_requested", "decision_made", "coe_issued", "withdrawn"]).optional(), q: z.string().trim().max(100).optional(), attention: z.enum(["1"]).optional() });
const docReviewBody = z.object({ status: z.enum(["accepted", "needs_update"]), note: z.string().trim().max(1000).optional() }).strict();
const infoBody = z.object({ note: z.string().trim().min(5, "Tell the agent what you need").max(3000) }).strict();
const decisionBody = z.object({ decision: z.enum(["offer", "not_offered"]), reason: z.string().trim().max(3000).optional() }).strict();
const withdrawBody = z.object({ reason: z.string().trim().min(3, "Give a reason").max(1000) }).strict();

const money = z.preprocess(blank, z.coerce.number().min(0).max(1000000).optional());
const letterBody = z.object({ body: z.string().trim().min(20, "The letter is empty").max(10000), tuition_fee: money, material_fee: money, enrolment_fee: money }).strict();
const paymentBody = z.object({ note: z.string().trim().max(500).optional() }).strict();
const coeBody = z.object({
  coe_number: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5,20}$/, "Enter the CoE number from PRISMS (letters and numbers only)"),
  issued_on: ymd,
  file: upload.optional(),
}).strict();
const fileKind = z.object({ id: z.string().uuid(), kind: z.enum(["letter", "coe", "voe"]) });

module.exports = {
  letterBody, paymentBody, coeBody, fileKind,
  reviewQuery, docReviewBody, infoBody, decisionBody, withdrawBody, build, draftSchema, submitForm, SECTIONS, conditionalErrors, OPTIONS, docBody, idParam, docParams, formParams, settingsBody, docTypesBody, formUploadBody, formToggleBody };
