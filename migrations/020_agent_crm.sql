-- Phase 4: agent CRM and communications (client requirements document, 17 November 2026).
-- Every table here is a 7-year record (EAA obligation): rows can be corrected through the application but never deleted.

CREATE FUNCTION retention_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'This record is kept for 7 years and cannot be deleted';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- communication log (mandatory for all staff contact)
CREATE TABLE agent_communications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(id),
  type         VARCHAR(20) NOT NULL CHECK (type IN ('email', 'phone', 'meeting', 'note', 'broadcast', 'corrective_action', 'other')),
  direction    VARCHAR(10) NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound', 'internal')),
  occurred_at  TIMESTAMPTZ NOT NULL,
  staff_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  subject      VARCHAR(200),
  summary      TEXT NOT NULL,
  source       VARCHAR(14) NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'system', 'inbound_email')),
  external_id  VARCHAR(300) UNIQUE,                       -- the Message-ID of a logged email, so a retry never doubles it
  edited_at    TIMESTAMPTZ,
  edited_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_communications_agent_idx ON agent_communications (agent_id, occurred_at DESC);

-- ---------------------------------------------------------------- student leads and enquiries logged by the agent
CREATE TABLE agent_leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id),
  student_name    VARCHAR(160) NOT NULL,
  country         VARCHAR(100) NOT NULL,
  course_interest VARCHAR(200) NOT NULL,
  contact_date    DATE NOT NULL,
  outcome         VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'submitted', 'not_proceeding')),
  notes           TEXT,
  application_id  UUID,                                    -- set when Phase 5 turns the lead into an application
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_leads_agent_idx ON agent_leads (agent_id, contact_date DESC);

-- ---------------------------------------------------------------- training records (beyond the induction)
CREATE TABLE agent_training_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(id),
  title        VARCHAR(200) NOT NULL,
  kind         VARCHAR(20) NOT NULL DEFAULT 'refresher' CHECK (kind IN ('refresher', 'product_update', 'compliance', 'other')),
  held_on      DATE NOT NULL,
  delivered_by VARCHAR(160),
  notes        TEXT,
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_training_agent_idx ON agent_training_records (agent_id, held_on DESC);

-- ---------------------------------------------------------------- the 6-monthly Agent Monitoring Form
CREATE TABLE agent_monitoring_reviews (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                UUID NOT NULL REFERENCES agents(id),
  agreement_id            BIGINT REFERENCES agreements(id) ON DELETE SET NULL,
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  applications_submitted  INTEGER NOT NULL CHECK (applications_submitted >= 0),
  conversion_rate         NUMERIC(5, 2) CHECK (conversion_rate BETWEEN 0 AND 100),
  student_performance     TEXT NOT NULL,                  -- attendance and course progress of enrolled students
  incidents_found         BOOLEAN NOT NULL DEFAULT false,
  incidents_detail        TEXT,
  unauthorised_advice_found BOOLEAN NOT NULL DEFAULT false,
  unauthorised_advice_detail TEXT,
  outcome                 VARCHAR(14) NOT NULL CHECK (outcome IN ('satisfactory', 'issues_found')),
  notes                   TEXT,
  task_id                 UUID,
  completed_by            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  completed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (NOT incidents_found OR coalesce(incidents_detail, '') <> ''),
  CHECK (NOT unauthorised_advice_found OR coalesce(unauthorised_advice_detail, '') <> '')
);
CREATE INDEX agent_monitoring_agent_idx ON agent_monitoring_reviews (agent_id, period_end DESC);

-- ---------------------------------------------------------------- corrective action notices (drafted, reviewed and sent by staff, then tracked)
CREATE TABLE agent_corrective_actions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID NOT NULL REFERENCES agents(id),
  review_id           UUID REFERENCES agent_monitoring_reviews(id) ON DELETE SET NULL,
  issues              TEXT NOT NULL,
  required_actions    TEXT NOT NULL,
  due_date            DATE NOT NULL,
  notice_subject      VARCHAR(200) NOT NULL,
  notice_body         TEXT NOT NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'implemented', 'not_implemented', 'cancelled')),
  drafted_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  sent_by             BIGINT REFERENCES users(id) ON DELETE SET NULL,
  sent_at             TIMESTAMPTZ,
  sent_to             TEXT,
  resolved_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT,
  overdue_alerted_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_corrective_agent_idx ON agent_corrective_actions (agent_id, created_at DESC);

-- ---------------------------------------------------------------- broadcasts: product, fee and policy updates to active agents
CREATE TABLE marketing_broadcasts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          VARCHAR(12) NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'fee', 'policy', 'other')),
  subject       VARCHAR(200) NOT NULL,
  body          TEXT NOT NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'cancelled')),
  drafted_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at   TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  recipients    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the delivery timestamp for every agent (the 24-hour duty)
CREATE TABLE marketing_broadcast_deliveries (
  broadcast_id UUID NOT NULL REFERENCES marketing_broadcasts(id),
  agent_id     UUID NOT NULL REFERENCES agents(id),
  sent_to      TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (broadcast_id, agent_id)
);

-- ---------------------------------------------------------------- 7-year retention: no hard deletes
CREATE TRIGGER agent_communications_keep BEFORE DELETE ON agent_communications FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER agent_leads_keep BEFORE DELETE ON agent_leads FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER agent_training_keep BEFORE DELETE ON agent_training_records FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER agent_monitoring_keep BEFORE DELETE ON agent_monitoring_reviews FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER agent_corrective_keep BEFORE DELETE ON agent_corrective_actions FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER marketing_broadcasts_keep BEFORE DELETE ON marketing_broadcasts FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER marketing_broadcast_deliveries_keep BEFORE DELETE ON marketing_broadcast_deliveries FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER agents_keep BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION retention_guard();   -- an agent record is soft-deleted, never removed

-- ---------------------------------------------------------------- the recurring monitoring task
ALTER TABLE coms_tasks DROP CONSTRAINT coms_tasks_type_check;
ALTER TABLE coms_tasks ADD CONSTRAINT coms_tasks_type_check CHECK (type IN (
  'PRISMS_ADD','PRISMS_UPDATE','PRISMS_REMOVE','ASQANET_START','ASQANET_END',
  'WEBSITE_ADD','WEBSITE_REMOVE','S21B_REQUEST','INDUCTION','COMMISSION_REPORT','RENEWAL','MONITORING','GENERAL'));
CREATE UNIQUE INDEX coms_tasks_monitoring_uq ON coms_tasks (agreement_id, trigger_event) WHERE type = 'MONITORING' AND deleted_at IS NULL;
