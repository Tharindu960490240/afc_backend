-- 008_application_form_v2.sql : AFC "Education Agent Application Form V2.0" and the "Processing Agent Application" procedure.

-- ---------------------------------------------------------------- form sections 1-11
ALTER TABLE agents
  ADD COLUMN gst_registered     BOOLEAN,                 -- 1d
  ADD COLUMN owner_name         VARCHAR(160),            -- 1h Chief Executive Officer / Owner
  ADD COLUMN staff_count        INTEGER,                 -- 1i
  ADD COLUMN years_in_business  INTEGER,                 -- 1k
  -- sections 1l-1o, 2, 3, 4, 5, 6, 7, 8 (lists and long answers), validated by the API
  ADD COLUMN application_extra  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN privacy_agreed_at  TIMESTAMPTZ,             -- 10 / 11 privacy notice
  ADD COLUMN declaration_name   VARCHAR(160),            -- 11 name of the person making the declaration
  ADD COLUMN declaration_at     TIMESTAMPTZ,
  -- procedure step 2 (contact created in the student management system) and step 6 (commission and bonus)
  ADD COLUMN sms_contact_at     TIMESTAMPTZ,
  ADD COLUMN sms_contact_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN commission_terms   TEXT,
  ADD COLUMN bonus_terms        TEXT,
  ADD COLUMN terms_recorded_at  TIMESTAMPTZ,
  ADD COLUMN terms_recorded_by  BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- 9: contact person position
ALTER TABLE agent_referees ADD COLUMN position VARCHAR(120);

-- ---------------------------------------------------------------- the agent folder (procedure step 1)
ALTER TABLE coms_files DROP CONSTRAINT coms_files_kind_check;
ALTER TABLE coms_files ADD CONSTRAINT coms_files_kind_check
  CHECK (kind IN ('referee','declaration','task_evidence','other','agent_document'));

CREATE TABLE agent_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind         VARCHAR(24) NOT NULL CHECK (kind IN
                 ('business_registration','agency_profile','mara_certificate','application_form','other')),
  label        VARCHAR(160),                              -- free description, mainly for 'other'
  file_id      UUID NOT NULL REFERENCES coms_files(id),
  status       VARCHAR(14) NOT NULL DEFAULT 'received' CHECK (status IN ('received','accepted','needs_update')),
  review_note  TEXT,
  reviewed_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  uploaded_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_agent BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  deleted_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  delete_reason TEXT
);
CREATE INDEX agent_documents_agent_idx ON agent_documents (agent_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- tasks (procedure step 6)
ALTER TABLE coms_tasks DROP CONSTRAINT coms_tasks_type_check;
ALTER TABLE coms_tasks ADD CONSTRAINT coms_tasks_type_check CHECK (type IN (
  'PRISMS_ADD','PRISMS_UPDATE','PRISMS_REMOVE','ASQANET_START','ASQANET_END',
  'WEBSITE_ADD','WEBSITE_REMOVE','S21B_REQUEST','INDUCTION','COMMISSION_REPORT','GENERAL'));
