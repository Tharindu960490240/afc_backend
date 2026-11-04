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
});

// Manual status moves. Approve/reject (needs due diligence) arrives in Part 2, Expired is automatic (Part 5).
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

module.exports = {
  ROLES, ROLE_LIST, STAFF_ROLES, INVITE_PERMISSIONS, PASSWORD_REGEX,
  AGENT_STATUS, AGENT_TIERS, RISK_RATINGS, PERSON_ROLES, AGENT_PERMS, AGENT_TRANSITIONS,
};
