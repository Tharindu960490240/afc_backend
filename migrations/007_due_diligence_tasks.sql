-- 007_due_diligence_tasks.sql : COMS Block 1, Part 2
--   referee verification, due-diligence checklist, director decision,
--   evidence files, task engine (regulatory onboarding tasks).

-- ---------------------------------------------------------------- evidence files
-- Used for referee/phone-check notes, declarations and task evidence. Stored privately on disk (fileStorage).
CREATE TABLE coms_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          VARCHAR(30)  NOT NULL CHECK (kind IN ('referee','declaration','task_evidence','other')),
  original_name VARCHAR(255) NOT NULL,
  storage_key   VARCHAR(200) NOT NULL UNIQUE,
  mime_type     VARCHAR(100) NOT NULL,
  size_bytes    INTEGER      NOT NULL,
  sha256        CHAR(64)     NOT NULL,
  uploaded_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- due diligence (one per agent)
CREATE TABLE agent_due_diligence (
  agent_id          UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  opened_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- everyone who prepared the file; none of them may approve it (BR-06)
  preparers         BIGINT[]    NOT NULL DEFAULT '{}',

  abn_check_status  VARCHAR(16) CHECK (abn_check_status  IN ('verified','failed','not_applicable')),
  abn_check_note    TEXT, abn_checked_at  TIMESTAMPTZ, abn_checked_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  marn_check_status VARCHAR(16) CHECK (marn_check_status IN ('verified','failed','not_applicable')),
  marn_check_note   TEXT, marn_checked_at TIMESTAMPTZ, marn_checked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  prisms_check_status VARCHAR(16) CHECK (prisms_check_status IN ('verified','failed')),
  prisms_check_note TEXT, prisms_checked_at TIMESTAMPTZ, prisms_checked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,

  coi_reviewed_at   TIMESTAMPTZ,            -- someone at the college reviewed the conflict-of-interest declaration
  coi_reviewed_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  coi_review_note   TEXT,
  coi_file_id       UUID REFERENCES coms_files(id) ON DELETE SET NULL,

  decision          VARCHAR(10) CHECK (decision IN ('approved','rejected')),
  decision_reason   TEXT,
  decided_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ,
  -- BR-08: warn at day 7, alert at day 10 (each sent once)
  warned_at         TIMESTAMPTZ,
  alerted_at        TIMESTAMPTZ
);

-- ---------------------------------------------------------------- referee checks
CREATE TABLE referee_checks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  referee_id       UUID NOT NULL REFERENCES agent_referees(id) ON DELETE CASCADE,
  method           VARCHAR(12) NOT NULL CHECK (method IN ('email_form','phone')),
  token_hash       CHAR(64) UNIQUE,                 -- email form only; single use
  token_expires_at TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  sent_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reminder_count   SMALLINT NOT NULL DEFAULT 0,
  last_reminder_at TIMESTAMPTZ,
  call_date        DATE,                            -- phone only
  spoke_to         VARCHAR(160),
  response_at      TIMESTAMPTZ,
  answers          JSONB,
  outcome          VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','positive','negative','no_response')),
  outcome_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,   -- set when staff confirm or override
  summary          TEXT,
  file_id          UUID REFERENCES coms_files(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  deleted_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  delete_reason    TEXT
);
CREATE INDEX referee_checks_agent_idx ON referee_checks (agent_id) WHERE deleted_at IS NULL;
CREATE INDEX referee_checks_pending_idx ON referee_checks (sent_at) WHERE outcome = 'pending' AND method = 'email_form' AND deleted_at IS NULL;

-- ---------------------------------------------------------------- task engine
CREATE TABLE coms_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category         VARCHAR(12) NOT NULL DEFAULT 'general' CHECK (category IN ('regulatory','general')),
  type             VARCHAR(20) NOT NULL CHECK (type IN (
                     'PRISMS_ADD','PRISMS_UPDATE','PRISMS_REMOVE','ASQANET_START','ASQANET_END',
                     'WEBSITE_ADD','WEBSITE_REMOVE','S21B_REQUEST','INDUCTION','GENERAL')),
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  agent_id         UUID REFERENCES agents(id) ON DELETE CASCADE,
  agreement_id     BIGINT REFERENCES agreements(id) ON DELETE SET NULL,
  trigger_event    VARCHAR(60),
  trigger_date     DATE NOT NULL DEFAULT current_date,
  due_date         DATE NOT NULL,
  due_basis        VARCHAR(10) NOT NULL DEFAULT 'business' CHECK (due_basis IN ('business','calendar')),
  legal_deadline   DATE,
  owner_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  owner_role       VARCHAR(20),
  status           VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at     TIMESTAMPTZ,
  completed_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  completion_note  TEXT,
  evidence_file_id UUID REFERENCES coms_files(id) ON DELETE SET NULL,
  -- reminders and escalation (each happens once)
  warned_at        TIMESTAMPTZ,
  escalated_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at       TIMESTAMPTZ,
  deleted_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  delete_reason    TEXT
);
CREATE INDEX coms_tasks_due_idx   ON coms_tasks (due_date) WHERE status = 'open' AND deleted_at IS NULL;
CREATE INDEX coms_tasks_agent_idx ON coms_tasks (agent_id) WHERE deleted_at IS NULL;
CREATE INDEX coms_tasks_owner_idx ON coms_tasks (owner_id) WHERE status = 'open' AND deleted_at IS NULL;
-- one open task of each regulatory type per agreement: stops duplicates if a countersign is retried
CREATE UNIQUE INDEX coms_tasks_once_uq ON coms_tasks (agreement_id, type)
  WHERE agreement_id IS NOT NULL AND deleted_at IS NULL AND category = 'regulatory';

-- the certificate of appointment is stored next to the signed agreement
ALTER TABLE agreement_files DROP CONSTRAINT agreement_files_kind_check;
ALTER TABLE agreement_files
  ADD CONSTRAINT agreement_files_kind_check
  CHECK (kind IN ('template','signed_by_agent','countersigned','final','certificate'));

-- agents already in due diligence get an (empty) checklist
INSERT INTO agent_due_diligence (agent_id)
SELECT id FROM agents WHERE status = 'due_diligence' AND deleted_at IS NULL;
