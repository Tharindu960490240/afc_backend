const { z } = require("zod");
const { validAbnOrAcn } = require("../utils/abn");
const { ROLE_LIST, STAFF_ROLES, PASSWORD_REGEX, AGENT_STATUS, AGENT_TIERS, RISK_RATINGS, PERSON_ROLES, TASK_TYPE_LIST } = require("../const");

const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(1).max(50).regex(/^[\p{L}][\p{L}\s'’.-]*$/u, "Invalid characters");
const password = z.string().regex(PASSWORD_REGEX, "Password must be 8-72 characters with upper and lower case letters, a number and one of @$!%*?&");
const phone = z
  .string().trim().max(30)
  .refine((v) => /^\+?[\d\s()-]+$/.test(v) && v.replace(/\D/g, "").length >= 8 && v.replace(/\D/g, "").length <= 15, "Invalid phone number");
const country = z.string().trim().min(2).max(80);
const token = z.string().regex(/^[a-f0-9]{64}$/i, "Invalid token");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
  const now = new Date();
  const age = (now - d) / (365.25 * 24 * 3600 * 1000);
  return d <= now && age <= 100;
}, "Invalid date of birth");

const login = z.object({ email, password: z.string().min(1).max(200) });
const forgotPassword = z.object({ email });
const resetPassword = z.object({ token, password });
const changePassword = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });
const updateProfile = z
  .object({ first_name: name.optional(), last_name: name.optional(), phone: phone.optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

const createInvitation = z.object({
  email,
  role: z.enum(ROLE_LIST),
  first_name: name.optional(),
});

// Common sign-up fields. NOTE: email and role are never accepted here; they come from the invitation.
const acceptBase = {
  first_name: name,
  last_name: name,
  phone,
  password,
  consent: z.literal(true, { error: "You must accept the terms" }),
};
const acceptSchemas = {
  admin: z.object(acceptBase).strict(),
  teacher: z.object(acceptBase).strict(),
  ...Object.fromEntries(STAFF_ROLES.filter((r) => r !== "admin").map((r) => [r, z.object(acceptBase).strict()])),
  agent: z
    .object({
      ...acceptBase,
      agency_name: z.string().trim().min(2).max(160),
      business_number: z.string().trim().max(25).regex(/^([A-Za-z0-9][A-Za-z0-9 -]{3,24})?$/, "Invalid business number").default(""),
      country,
    })
    .strict(),
  student: z.object({ ...acceptBase, date_of_birth: isoDate, country }).strict(),
};

// ---------- agent application form (website registration and the portal) ----------
const longText = (min, max, label) => z.string().trim().min(min, `${label} is required`).max(max);
const marn = z.string().trim().regex(/^(\d{7})?$/, "A MARN has 7 digits").default("");
const applicationPerson = z.object({
  name: z.string().trim().min(2, "Enter the full name").max(120),
  email,
  role: z.enum(PERSON_ROLES),
  marn,
  involved_in_enrolments: z.boolean(),
  location: z.string().trim().max(160).default(""),
}).strict();
const applicationReferee = z.object({
  name: z.string().trim().min(2, "Enter the referee's name").max(120),
  position: z.string().trim().min(2, "Enter the referee's position").max(120),
  organisation: z.string().trim().min(2, "Enter the referee's company name").max(160),
  email,
  phone,
}).strict();

// ----- AFC Education Agent Application Form V2.0, sections 1l-8 -----
const short = (label, max = 200) => z.string().trim().min(1, `Enter ${label}`).max(max);
const place = z.object({ location: short("the location", 160), details: z.string().trim().max(500).default("") }).strict();
const recruitedRow = z.object({ sector: short("the sector", 120), students: z.coerce.number().int().min(0).max(1000000) }).strict();
const yn = (label) => z.boolean({ error: `Please answer ${label}` });
const applicationExtra = z.object({
  services: z.array(short("a service", 200)).min(1, "List at least one service").max(10),                 // 1l
  offshore_offices: z.array(place).max(10).default([]),                                                       // 1m
  sub_contractors: z.array(place).max(10).default([]),                                                        // 1n
  offshore_partners: z.array(place).max(10).default([]),                                                      // 1o
  registrations: z.array(z.object({ number: short("the registration number", 60), country: short("the country", 80) }).strict())
    .min(1, "Give at least one registration").max(10),                                                        // 2
  recruited_australia: z.array(recruitedRow).max(10).default([]),                                             // 3a
  recruited_other: z.array(recruitedRow).max(10).default([]),                                                 // 3b
  esos_read: yn("whether you have read the ESOS Act 2000"),                                                   // 4a
  esos_intend: z.boolean().nullable().default(null),
  national_code_read: yn("whether you have read the National Code 2018"),                                    // 4b
  national_code_intend: z.boolean().nullable().default(null),
  experience_education: z.string().trim().min(10, "Describe your experience in the education industry").max(3000), // 5a
  experience_other: z.string().trim().max(3000).default(""),                                                  // 5b
  markets: z.array(z.object({ area: short("the area", 160), characteristics: z.string().trim().max(500).default("") }).strict())
    .min(1, "Give at least one current market").max(15),                                                      // 6a
  potential_markets: z.string().trim().max(2000).default(""),                                                 // 6b
  memberships: z.array(short("an organisation", 160)).max(10).default([]),                                    // 7
  services_to_afc: z.string().trim().min(10, "Outline the services you will provide to the college").max(3000), // 8
}).strict();
const applicationShape = {
  legal_name: z.string().trim().min(2, "Enter the legal name").max(200),
  trading_names: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  country,
  abn_acn: z.string().trim().min(4, "Enter your ABN, ACN or business registration number").max(40),
  is_body_corporate: z.boolean(),
  principal_address: longText(5, 500, "The principal place of business"),
  registered_office_address: z.string().trim().max(500).default(""),
  postal_address: z.string().trim().max(500).default(""),
  business_phone: z.union([phone, z.literal("")]).default(""),
  website: z.union([z.string().trim().max(300).url("Enter a full web address, for example https://example.com"), z.literal("")]).default(""),
  marn,
  gst_registered: z.boolean({ error: "Please choose Yes or No" }),                                          // 1d
  owner_name: z.string().trim().min(2, "Enter the name of the Chief Executive Officer or owner").max(160),   // 1h
  staff_count: z.coerce.number().int().min(0, "Enter the number of staff").max(100000),                      // 1i
  years_in_business: z.coerce.number().int().min(0, "Enter the number of years").max(300),                   // 1k
  extra: applicationExtra,
  // the person filling in the form
  applicant_role: z.enum(["director", "staff"]),
  applicant_marn: marn,
  applicant_in_enrolments: z.boolean(),
  // everyone else: directors, staff, sub-agents
  people: z.array(applicationPerson).max(30).default([]),
  referees: z.array(applicationReferee).min(2, "Give two referees").max(3),
  coi_declared: z.boolean({ error: "Please answer this question" }),
  coi_details: z.string().trim().max(2000).default(""),
  code_of_ethics: z.literal(true, { error: "You must accept the code of ethics" }),
  information_true: z.literal(true, { error: "Please confirm the information is correct" }),
  privacy_agreed: z.literal(true, { error: "You must agree to the privacy notice" }),                        // 10
  declaration_name: z.string().trim().min(2, "Type the name of the Chief Executive Officer or owner").max(160), // 11
};
// rules that look at several fields at once
function checkApplication(v, ctx, applicantEmail) {
  const fail = (path, message) => ctx.addIssue({ code: "custom", path: [].concat(path), message });
  if (/^australia$/i.test(v.country) && !validAbnOrAcn(v.abn_acn)) fail("abn_acn", "This is not a valid ABN or ACN");
  if (v.is_body_corporate) {
    if (!v.registered_office_address) fail("registered_office_address", "A body corporate needs a registered office address");
    if (v.applicant_role !== "director" && !v.people.some((p) => p.role === "director")) fail("people", "Add at least one director");
  }
  if (v.coi_declared && v.coi_details.length < 10) fail("coi_details", "Please describe the conflict of interest");
  const x = v.extra;
  if (x.esos_read === false && x.esos_intend === null) fail(["extra", "esos_intend"], "Please answer this question");
  if (x.national_code_read === false && x.national_code_intend === null) fail(["extra", "national_code_intend"], "Please answer this question");
  const seen = new Set(applicantEmail ? [applicantEmail] : []);
  v.people.forEach((p, i) => {
    if (seen.has(p.email)) fail(["people", i, "email"], "This email is already on the list");
    seen.add(p.email);
  });
  const refs = new Set();
  v.referees.forEach((r, i) => {
    if (refs.has(r.email) || (applicantEmail && r.email === applicantEmail)) fail(["referees", i, "email"], "Use a different email for each referee");
    refs.add(r.email);
  });
}
const registerAgent = z
  .object({ ...acceptBase, email, ...applicationShape })
  .strict()
  .superRefine((v, ctx) => checkApplication(v, ctx, v.email));
// A signed-in agent (invited by the college) completes the same application.
const submitApplication = z
  .object(applicationShape)
  .strict()
  .superRefine((v, ctx) => checkApplication(v, ctx, null));
const verifyAgent = z.object({ token });
const registrationListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending_approval", "unverified", "rejected"]).default("pending_approval"),
});
const rejectRegistration = z.object({ reason: z.string().trim().max(1000).optional() });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(ROLE_LIST).optional(),
  status: z.string().max(20).optional(),
  search: z.string().trim().max(100).optional(),
});

const userStatus = z.object({ status: z.enum(["active", "suspended"]) });
const userAuthorised = z.object({ authorised: z.boolean() }).strict();
const idParam = z.object({ id: z.coerce.number().int().positive() });


// ---------- agreements ----------
// multipart fields arrive as strings, and empty boxes arrive as ""
const blankToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());
const months = z.coerce.number().int().min(1).max(60);
const dateOnlyAny = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, "Invalid date");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "Invalid date");

const sendAgreement = z.object({
  agent_id: z.coerce.number().int().positive(),
  title: optional(z.string().trim().min(3).max(160)),
  note: optional(z.string().trim().max(1000)),
  validity_months: optional(months),
});
// signing: the typed name is the signature, a drawn image is optional
const signedName = z.string().trim().min(2, "Please type your full name").max(120);
const signatureImage = z.preprocess(blankToUndefined, z.string().max(250000).optional().nullable());
const accept = z.literal(true, { error: "Please tick the box to confirm" });
const signAgreement = z.object({ signed_name: signedName, signature_image: signatureImage, accept });
const approveAgreement = z.object({
  signed_name: signedName,
  position: optional(z.string().trim().min(2).max(120)),
  signature_image: signatureImage,
  accept,
  effective_date: optional(dateOnly),
  validity_months: optional(months),
});
const saveTemplate = z.object({
  name: z.string().trim().min(3).max(160),
  body: z.string().trim().min(100, "The agreement text is too short").max(60000),
});
const previewTemplate = z.object({ body: z.string().trim().min(1).max(60000) });
const rejectAgreement = z.object({ reason: z.string().trim().min(3, "Please give a reason").max(1000) });
const cancelAgreement = z.object({ reason: optional(z.string().trim().max(1000)) });
const agreementFileParams = z.object({ id: z.coerce.number().int().positive(), fileId: z.coerce.number().int().positive() });
const agreementListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["sent", "submitted", "rejected", "active", "expired", "cancelled", "superseded"]).optional(),
  agent_id: z.coerce.number().int().positive().optional(),
});
const agentsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  agreement: z.enum(["none", "sent", "submitted", "rejected", "active", "expiring", "expired"]).optional(),
});

// ---------- COMS agent register ----------
const nullable = (schema) => z.union([schema, z.null()]);
const text = (max) => z.string().trim().max(max).transform((v) => (v === "" ? null : v));
const optText = (max) => nullable(text(max)).optional();
const uuidParam = z.object({ id: z.string().uuid() });
const personParams = z.object({ id: z.string().uuid(), personId: z.string().uuid() });
const reasonText = z.string().trim().min(3, "Please give a reason").max(1000);

const createAgentEoi = z.object({
  legal_name: z.string().trim().min(2).max(200),
  email,
  country,
  phone: phone.optional(),
  contact_name: name.optional(),
  source: z.enum(["eoi", "staff"]).default("eoi"),
  send_link: z.boolean().default(true),
}).strict();

const updateAgent = z.object({
  legal_name: z.string().trim().min(2).max(200).optional(),
  trading_names: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  abn_acn: optText(40),
  country: country.optional(),
  is_body_corporate: z.boolean().optional(),
  principal_address: optText(500),
  registered_office_address: optText(500),
  postal_address: optText(500),
  phone: nullable(phone).optional(),
  email: email.optional(),
  website: nullable(z.string().trim().max(300).url("Enter a full web address, for example https://example.com")).optional(),
  marn: optText(20),
  account_manager_id: nullable(z.coerce.number().int().positive()).optional(),
  tier: nullable(z.enum(AGENT_TIERS)).optional(),
  risk_rating: nullable(z.enum(RISK_RATINGS)).optional(),
  risk_override_reason: optText(1000),
  contact_cadence_days: z.coerce.number().int().min(1).max(365).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");

const agentStatusChange = z.object({ status: z.enum(AGENT_STATUS), reason: z.string().trim().max(1000).optional() }).strict();
const agentDelete = z.object({ reason: reasonText }).strict();
const personBody = {
  name: name.max(120),
  email,
  role: z.enum(PERSON_ROLES),
  marn: optText(20),
  involved_in_enrolments: z.boolean(),
  location: optText(160),
  is_primary_contact: z.boolean(),
};
const createPerson = z.object(personBody).partial({ role: true, marn: true, involved_in_enrolments: true, location: true, is_primary_contact: true }).strict();
const updatePerson = z.object({ ...personBody, training_completed_at: nullable(z.coerce.date()), active: z.boolean() })
  .partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");
const milestone = z.object({ type: z.enum(["prisms", "induction", "sms_contact"]), date: dateOnly.optional() }).strict();
const csvBool = z.enum(["true", "false"]).transform((v) => v === "true");
const comsAgentsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.string().max(200).optional()
    .transform((v) => (v ? v.split(",").map((x) => x.trim()).filter((x) => AGENT_STATUS.includes(x)) : undefined)),
  tier: z.enum(AGENT_TIERS).optional(),
  risk: z.enum(RISK_RATINGS).optional(),
  country: z.string().trim().max(80).optional(),
  manager: z.union([z.literal("unassigned"), z.coerce.number().int().positive()]).optional(),
  deleted: csvBool.optional(),
  sort: z.enum(["created_at", "legal_name", "status", "country", "decision_due", "agreement_end"]).default("created_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
const holidayBody = z.object({
  date: dateOnly,
  name: z.string().trim().min(2).max(120),
  jurisdiction: z.enum(["TAS", "VIC"]),
}).strict();

// ---------- COMS Part 2: due diligence, decision, tasks ----------
const upload = z.object({ name: z.string().trim().min(1).max(200), data: z.string().min(4) }).strict();
const refereeBody = {
  name: z.string().trim().min(2).max(120),
  position: nullable(z.string().trim().min(2).max(120)).optional(),
  organisation: z.string().trim().min(2).max(160),
  email,
  phone: nullable(phone).optional(),
};
const createReferee = z.object(refereeBody).strict();
const updateReferee = z.object(refereeBody).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");
const refereeParams = z.object({ id: z.string().uuid(), refereeId: z.string().uuid() });
const checkParams = z.object({ id: z.string().uuid(), checkId: z.string().uuid() });
const answers = z.record(z.string().max(70), z.union([z.string().trim().max(2000), z.boolean()]));
const phoneCheck = z.object({
  call_date: dateOnly,
  spoke_to: z.string().trim().min(2).max(160),
  answers,
  outcome: z.enum(["positive", "negative"]).optional(),
  summary: z.string().trim().min(3).max(3000),
  file: upload.optional(),
}).strict();
const referenceOutcome = z.object({
  outcome: z.enum(["positive", "negative", "no_response"]),
  summary: z.string().trim().min(3, "Please add a short summary").max(3000),
}).strict();
const referenceAnswers = z.object({ answers }).strict();
const dueDiligenceCheck = z.object({
  key: z.enum(["abn", "marn", "prisms"]),
  status: z.enum(["verified", "failed", "not_applicable"]),
  note: z.string().trim().max(1000).optional(),
}).strict();
const declarations = z.object({
  coi_declared: z.boolean(),
  coi_details: optText(2000),
  code_of_ethics_ack: z.boolean().optional(),
  coi_review_note: optText(2000),
  file: upload.optional(),
}).strict();
const decision = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(3, "Please give a reason").max(2000),
  send_email: z.boolean().default(true),
  email_subject: z.string().trim().max(200).optional(),
  email_body: z.string().trim().max(5000).optional(),
}).strict();
const sendAgentAgreement = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  note: z.string().trim().max(1000).optional(),
  validity_months: z.coerce.number().int().min(1).max(60).optional(),
}).strict();
const taskCreate = z.object({
  type: z.enum(TASK_TYPE_LIST).default("GENERAL"),
  title: z.string().trim().min(3).max(200),
  description: optText(2000),
  agent_id: z.string().uuid().optional(),
  due_date: dateOnlyAny,
  due_basis: z.enum(["business", "calendar"]).default("calendar"),
  owner_id: z.coerce.number().int().positive().optional(),
}).strict();
const taskComplete = z.object({ note: z.string().trim().max(2000).optional(), file: upload.optional() }).strict();
const taskAssign = z.object({ owner_id: z.coerce.number().int().positive() }).strict();
const tasksQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.string().max(200).optional()
    .transform((v) => (v ? v.split(",").map((x) => x.trim()).filter((x) => TASK_TYPE_LIST.includes(x)) : undefined)),
  status: z.enum(["open", "done", "cancelled", "all"]).default("open"),
  overdue: csvBool.optional(),
  agent_id: z.string().uuid().optional(),
  owner: z.union([z.literal("me"), z.literal("unassigned"), z.coerce.number().int().positive()]).optional(),
  category: z.enum(["regulatory", "general"]).optional(),
  search: z.string().trim().max(100).optional(),
});
const publicToken = z.object({ token });
const fileParams = z.object({ fileId: z.string().uuid() });
const cancelTask = z.object({ reason: z.string().trim().min(3, "Please give a reason").max(1000) }).strict();
const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  entity_type: z.string().trim().max(40).optional(),
  entity_id: z.string().trim().max(40).optional(),
  actor_id: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(60).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

// agent folder: documents, requests for information, commission and bonus (Part 2b)
const uploadFile = z.object({ name: z.string().trim().min(1).max(255), data: z.string().min(10) }).strict();
const agentDocument = z.object({
  kind: z.string().trim().min(1).max(60), // checked against the document types in Settings
  label: z.string().trim().max(160).optional(),
  file: uploadFile,
}).strict();
const documentParams = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
const documentReview = z.object({
  status: z.enum(["accepted", "needs_update"]),
  note: z.string().trim().max(1000).optional(),
}).strict().refine((v) => v.status !== "needs_update" || (v.note && v.note.length >= 3), { message: "Say what needs to change", path: ["note"] });
const infoRequest = z.object({ message: z.string().trim().min(10, "Write what you need from the agent").max(3000) }).strict();
const pct = (label) => z.coerce.number({ error: `Enter the ${label} percentage` }).min(0, "Cannot be below 0").max(100, "Cannot be above 100");
const agentTerms = z.object({
  vet_percent: pct("VET").default(35),
  elicos_percent: pct("ELICOS").default(30),
  bonus_terms: z.string().trim().max(2000).default(""),
}).strict();
const agentTermsSend = z.object({
  subject: z.string().trim().min(3, "Write a subject").max(200),
  body: z.string().trim().min(10, "Write the message").max(5000),
}).strict();

module.exports = {
  userAuthorised,
  agentTermsSend,
  agentDocument, documentParams, documentReview, infoRequest, agentTerms,
  createAgentEoi, updateAgent, agentStatusChange, agentDelete, createPerson, updatePerson, milestone,
  comsAgentsQuery, uuidParam, personParams, holidayBody, auditQuery,
  upload, createReferee, updateReferee, refereeParams, checkParams, phoneCheck, referenceOutcome, referenceAnswers,
  dueDiligenceCheck, declarations, decision, sendAgentAgreement, taskCreate, taskComplete, taskAssign, tasksQuery, publicToken, fileParams, cancelTask,
  login, forgotPassword, resetPassword, changePassword, updateProfile,
  registerAgent, submitApplication, verifyAgent, registrationListQuery, rejectRegistration,
  createInvitation, acceptSchemas, listQuery, userStatus, idParam, token,
  sendAgreement, signAgreement, approveAgreement, saveTemplate, previewTemplate, rejectAgreement, cancelAgreement, agreementFileParams, agreementListQuery, agentsQuery,
};
