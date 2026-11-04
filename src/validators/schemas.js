const { z } = require("zod");
const { ROLE_LIST, STAFF_ROLES, PASSWORD_REGEX, AGENT_STATUS, AGENT_TIERS, RISK_RATINGS, PERSON_ROLES } = require("../const");

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

// Agent registration from the website. Same fields as an invited agent, plus the email.
const registerAgent = z
  .object({
    ...acceptBase,
    email,
    agency_name: z.string().trim().min(2).max(160),
    business_number: z.string().trim().max(25).regex(/^([A-Za-z0-9][A-Za-z0-9 -]{3,24})?$/, "Invalid business number").default(""),
    country,
  })
  .strict();
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
const idParam = z.object({ id: z.coerce.number().int().positive() });


// ---------- agreements ----------
// multipart fields arrive as strings, and empty boxes arrive as ""
const blankToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());
const months = z.coerce.number().int().min(1).max(60);
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
const milestone = z.object({ type: z.enum(["prisms", "induction"]), date: dateOnly.optional() }).strict();
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

module.exports = {
  createAgentEoi, updateAgent, agentStatusChange, agentDelete, createPerson, updatePerson, milestone,
  comsAgentsQuery, uuidParam, personParams, holidayBody, auditQuery,
  login, forgotPassword, resetPassword, changePassword, updateProfile,
  registerAgent, verifyAgent, registrationListQuery, rejectRegistration,
  createInvitation, acceptSchemas, listQuery, userStatus, idParam, token,
  sendAgreement, signAgreement, approveAgreement, saveTemplate, previewTemplate, rejectAgreement, cancelAgreement, agreementFileParams, agreementListQuery, agentsQuery,
};
