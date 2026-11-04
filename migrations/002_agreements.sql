-- 002_agreements.sql : agent agreements, their files and history

CREATE TABLE agreements (
  id                BIGSERIAL PRIMARY KEY,
  agent_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             VARCHAR(160) NOT NULL DEFAULT 'Education Agent Agreement',
  note              TEXT,
  -- sent: waiting for the agent | submitted: waiting for admin review
  -- rejected: agent must upload a corrected copy | active: countersigned and in force
  -- cancelled: withdrawn/terminated | superseded: replaced by a newer agreement
  status            VARCHAR(20) NOT NULL
                    CHECK (status IN ('sent','submitted','rejected','active','cancelled','superseded')),
  validity_months   SMALLINT NOT NULL DEFAULT 12 CHECK (validity_months BETWEEN 1 AND 60),
  sent_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at      TIMESTAMPTZ,
  reviewed_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  effective_date    DATE,
  expires_at        DATE,
  -- reminder bookkeeping (see jobs/agreementReminders.js)
  last_reminder_at  TIMESTAMPTZ,
  reminder_count    INTEGER NOT NULL DEFAULT 0,
  expiry_notice_days INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- an agent can have only one agreement in progress at a time
CREATE UNIQUE INDEX agreements_one_open_per_agent
  ON agreements (agent_id) WHERE status IN ('sent','submitted','rejected');
CREATE INDEX agreements_agent_idx  ON agreements (agent_id);
CREATE INDEX agreements_status_idx ON agreements (status);

CREATE TABLE agreement_files (
  id            BIGSERIAL PRIMARY KEY,
  agreement_id  BIGINT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  kind          VARCHAR(20) NOT NULL CHECK (kind IN ('template','signed_by_agent','countersigned')),
  original_name VARCHAR(255) NOT NULL,
  -- random name on disk; the browser never sees or chooses it
  storage_key   VARCHAR(200) NOT NULL UNIQUE,
  mime_type     VARCHAR(100) NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        CHAR(64) NOT NULL,
  uploaded_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agreement_files_agreement_idx ON agreement_files (agreement_id);

CREATE TABLE agreement_events (
  id           BIGSERIAL PRIMARY KEY,
  agreement_id BIGINT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  actor_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  type         VARCHAR(30) NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agreement_events_agreement_idx ON agreement_events (agreement_id, created_at);
