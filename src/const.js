const ROLES = Object.freeze({
  ADMIN: "admin",
  AGENT: "agent",
  TEACHER: "teacher",
  STUDENT: "student",
  // COMS (Marketing & Sales block) staff groups
  CEO: "ceo",
  DIRECTOR: "director", // Strategy & Growth Director
  MARKETING: "marketing_officer", // Sales & Marketing Officer
  ADMISSIONS: "admissions",
  COE_ADMIN: "coe_admin", // Administration Manager / CoE Administrator
  ACCOUNTS: "accounts",
  COMPLIANCE: "compliance",
});
const ROLE_LIST = Object.values(ROLES);

// everyone who works for the college inside COMS (admin is the system administrator and can do everything)
const STAFF_ROLES = Object.freeze([
  ROLES.ADMIN, ROLES.CEO, ROLES.DIRECTOR, ROLES.MARKETING, ROLES.ADMISSIONS, ROLES.COE_ADMIN, ROLES.ACCOUNTS, ROLES.COMPLIANCE,
]);

// who may invite whom
const INVITE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: ROLE_LIST,
  [ROLES.DIRECTOR]: [ROLES.AGENT],
  [ROLES.MARKETING]: [ROLES.AGENT],
  [ROLES.AGENT]: [ROLES.STUDENT],
});

// ---------- COMS agent register ----------
const AGENT_STATUS = Object.freeze([
  "prospect", "applied", "due_diligence", "approved", "onboarding", "active",
  "under_review", "suspended", "expired", "terminated", "rejected",
]);
const AGENT_TIERS = Object.freeze(["strategic", "growth", "standard", "dormant"]);
const RISK_RATINGS = Object.freeze(["low", "medium", "high"]);
const PERSON_ROLES = Object.freeze(["director", "staff", "sub_agent"]);

// Who may do what with the agent register (NF-03)
const AGENT_PERMS = Object.freeze({
  read: STAFF_ROLES,
  create: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MARKETING],
  edit: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MARKETING],
  portfolio: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], // account manager, tier, risk, cadence
  remove: [ROLES.ADMIN, ROLES.DIRECTOR],
  restore: [ROLES.ADMIN],
  recordPrisms: [ROLES.ADMIN, ROLES.COE_ADMIN],
  recordInduction: [ROLES.ADMIN, ROLES.MARKETING, ROLES.DIRECTOR],
  // Part 2
  dueDiligence: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MARKETING, ROLES.COMPLIANCE], // referee checks, ABN/MARN/PRISMS checks, declarations
  decide: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO],                                // approve or reject (BR-06: never the preparer)
  sendAgreement: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MARKETING, ROLES.CEO],
});

// The reference verification form. The same questions are used for the emailed form and for phone checks.
// `favourable` is the answer that counts as a good reference; a question without it is for information only.
const REFERENCE_QUESTIONS = Object.freeze([
  { key: "known_for", type: "text", required: true, label: "How long, and in what capacity, have you known this agent?" },
  { key: "worked_with", type: "yesno", required: true, label: "Has your organisation worked with this agent (for example, received student applications from them)?" },
  { key: "honest", type: "yesno", required: true, favourable: true, label: "In your experience, does the agent act honestly and ethically towards students and providers?" },
  { key: "accurate_info", type: "yesno", required: true, favourable: true, label: "Does the agent give students accurate information about courses, fees and visa requirements?" },
  { key: "complaints", type: "yesno", required: true, favourable: false, detail: true, label: "Are you aware of any complaints, concerns or incidents involving this agent?" },
  { key: "recommend", type: "yesno", required: true, favourable: true, label: "Would you recommend this agent to another education provider?" },
  { key: "comments", type: "text", required: false, label: "Anything else we should know?" },
]);

// Regulatory and onboarding tasks (E5). due_basis: business = working days, calendar = calendar days.
const TASK_TYPES = Object.freeze({
  PRISMS_ADD: { category: "regulatory", label: "Add agent to PRISMS", ownerRole: ROLES.COE_ADMIN },
  PRISMS_UPDATE: { category: "regulatory", label: "Update agent in PRISMS", ownerRole: ROLES.COE_ADMIN },
  PRISMS_REMOVE: { category: "regulatory", label: "Remove agent from PRISMS", ownerRole: ROLES.COE_ADMIN },
  ASQANET_START: { category: "regulatory", label: "ASQAnet notice: agreement start", ownerRole: ROLES.COE_ADMIN },
  ASQANET_END: { category: "regulatory", label: "ASQAnet notice: agreement end", ownerRole: ROLES.COMPLIANCE },
  WEBSITE_ADD: { category: "regulatory", label: "Add agent to the website list", ownerRole: ROLES.ADMIN },
  WEBSITE_REMOVE: { category: "regulatory", label: "Remove agent from the website list", ownerRole: ROLES.MARKETING },
  S21B_REQUEST: { category: "regulatory", label: "Section 21B request", ownerRole: ROLES.COMPLIANCE },
  INDUCTION: { category: "general", label: "Agent induction and staff training", ownerRole: ROLES.MARKETING },
  COMMISSION_REPORT: { category: "general", label: "Report commission and bonus to Accounts", ownerRole: ROLES.MARKETING },
  GENERAL: { category: "general", label: "Task", ownerRole: null },
});
const TASK_TYPE_LIST = Object.freeze(Object.keys(TASK_TYPES));

// Who may finish a task: its owner, or anyone with the type's role, or these management roles.
const TASK_MANAGERS = Object.freeze([ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO, ROLES.COMPLIANCE]);

// Manual status moves. Approve/reject is a recorded decision (Due diligence tab), Expired is automatic (Part 5).
// "reason" = the person must say why.
const AGENT_TRANSITIONS = Object.freeze({
  prospect: { applied: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MARKETING] } },
  applied: { due_diligence: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MARKETING] } },
  due_diligence: {},
  approved: {
    suspended: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    terminated: { roles: [ROLES.ADMIN, ROLES.CEO], reason: true },
  },
  onboarding: {
    active: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MARKETING] }, // BR-01, BR-02 checked in the service
    suspended: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    terminated: { roles: [ROLES.ADMIN, ROLES.CEO], reason: true },
  },
  active: {
    under_review: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    suspended: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    terminated: { roles: [ROLES.ADMIN, ROLES.CEO], reason: true },
  },
  under_review: {
    active: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    suspended: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    terminated: { roles: [ROLES.ADMIN, ROLES.CEO], reason: true },
  },
  suspended: {
    under_review: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    active: { roles: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.CEO], reason: true },
    terminated: { roles: [ROLES.ADMIN, ROLES.CEO], reason: true },
  },
  expired: {},
  terminated: {},
  rejected: {},
});

// same rule as the React sign-up form
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,72}$/;

// The agent folder (procedure step 1). 'required' ones must be received and accepted before approval.
const DOC_KINDS = Object.freeze({
  business_registration: { label: "Business registration certificate", required: true, file: "Business registration" },
  agency_profile: { label: "Organisational profile", required: true, file: "Agency profile" },
  mara_certificate: { label: "Certificate of registration with MARA (if available)", required: false, file: "MARA certificate" },
  application_form: { label: "Signed application form", required: false, file: "Application form" },
  other: { label: "Other supporting document", required: false, file: "Supporting document" },
});
const REQUIRED_DOC_KINDS = Object.freeze(Object.keys(DOC_KINDS).filter((k) => DOC_KINDS[k].required));
const DOC_STATUS = Object.freeze(["received", "accepted", "needs_update"]);

module.exports = {
  ROLES, ROLE_LIST, STAFF_ROLES, INVITE_PERMISSIONS, PASSWORD_REGEX,
  AGENT_STATUS, AGENT_TIERS, RISK_RATINGS, PERSON_ROLES, AGENT_PERMS, AGENT_TRANSITIONS,
  REFERENCE_QUESTIONS, TASK_TYPES, TASK_TYPE_LIST, TASK_MANAGERS, DOC_KINDS, REQUIRED_DOC_KINDS, DOC_STATUS,
};
