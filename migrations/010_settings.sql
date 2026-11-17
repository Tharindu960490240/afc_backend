-- 010_settings.sql : things the college can change without a code change
-- (reference questions, document types, timers, college details, onboarding tasks)

CREATE TABLE settings (
  key         VARCHAR(60) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Questions asked of referees (online form and phone check).
-- favourable: the answer that counts as a good reference (NULL = for information only).
CREATE TABLE reference_questions (
  id          BIGSERIAL PRIMARY KEY,
  key         VARCHAR(60) NOT NULL UNIQUE,            -- never changes once created: answers are stored under it
  label       VARCHAR(400) NOT NULL,
  type        VARCHAR(10) NOT NULL CHECK (type IN ('text','yesno')),
  required    BOOLEAN NOT NULL DEFAULT true,
  favourable  BOOLEAN,
  ask_details BOOLEAN NOT NULL DEFAULT false,         -- ask for details when the answer is not the favourable one
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each completed check keeps the questions it was asked, so later edits never rewrite history.
ALTER TABLE referee_checks ADD COLUMN IF NOT EXISTS questions JSONB;

-- Document types in the agent folder. 'required' ones must be accepted before approval.
CREATE TABLE document_types (
  key         VARCHAR(60) PRIMARY KEY,
  label       VARCHAR(160) NOT NULL,
  file_name   VARCHAR(80) NOT NULL,                   -- used in the filing name
  required    BOOLEAN NOT NULL DEFAULT false,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE agent_documents DROP CONSTRAINT IF EXISTS agent_documents_kind_check;

-- The tasks created when an agreement is countersigned.
CREATE TABLE onboarding_task_templates (
  type                    VARCHAR(30) PRIMARY KEY,
  title                   VARCHAR(200) NOT NULL,       -- {agent} is replaced with the agency name
  owner_role              VARCHAR(30) NOT NULL,
  due_days                INTEGER NOT NULL CHECK (due_days BETWEEN 1 AND 120),
  due_basis               VARCHAR(10) NOT NULL CHECK (due_basis IN ('business','calendar')),
  legal_days              INTEGER CHECK (legal_days BETWEEN 1 AND 365),   -- calendar days from the agreement start
  prefer_account_manager  BOOLEAN NOT NULL DEFAULT false,
  enabled                 BOOLEAN NOT NULL DEFAULT true,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  updated_by              BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO reference_questions (key, label, type, required, favourable, ask_details, sort_order) VALUES
 ('known_for',     'How long, and in what capacity, have you known this agent?', 'text', true, NULL, false, 1),
 ('worked_with',   'Has your organisation worked with this agent (for example, received student applications from them)?', 'yesno', true, NULL, false, 2),
 ('honest',        'In your experience, does the agent act honestly and ethically towards students and providers?', 'yesno', true, true, false, 3),
 ('accurate_info', 'Does the agent give students accurate information about courses, fees and visa requirements?', 'yesno', true, true, false, 4),
 ('complaints',    'Are you aware of any complaints, concerns or incidents involving this agent?', 'yesno', true, false, true, 5),
 ('recommend',     'Would you recommend this agent to another education provider?', 'yesno', true, true, false, 6),
 ('comments',      'Anything else we should know?', 'text', false, NULL, false, 7);

INSERT INTO document_types (key, label, file_name, required, sort_order) VALUES
 ('business_registration', 'Business registration certificate', 'Business registration', true, 1),
 ('agency_profile', 'Organisational profile', 'Agency profile', true, 2),
 ('mara_certificate', 'Certificate of registration with MARA (if available)', 'MARA certificate', false, 3),
 ('application_form', 'Signed application form', 'Application form', false, 4),
 ('other', 'Other supporting document', 'Supporting document', false, 5);

INSERT INTO onboarding_task_templates (type, title, owner_role, due_days, due_basis, legal_days, prefer_account_manager, sort_order) VALUES
 ('PRISMS_ADD',        'Add {agent} to PRISMS', 'coe_admin', 5, 'business', NULL, false, 1),
 ('ASQANET_START',     'Report {agent} to ASQAnet', 'coe_admin', 5, 'business', 30, false, 2),
 ('WEBSITE_ADD',       'List {agent} on the AFC website', 'admin', 5, 'business', NULL, false, 3),
 ('COMMISSION_REPORT', 'Record commission and bonus for {agent} and report to Accounts', 'marketing_officer', 5, 'business', NULL, false, 4),
 ('INDUCTION',         'Induct {agent} and record staff training', 'marketing_officer', 30, 'calendar', NULL, true, 5);
