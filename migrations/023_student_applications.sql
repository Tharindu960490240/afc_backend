-- Phase 5: student applications (client requirements, 17 November 2026).
-- The portal is the only way an agent submits a student application. The form follows the
-- AFC Application for Enrolment Form - International Students, V3.1. Records are kept 7 years: nothing is deleted.

CREATE SEQUENCE student_application_seq START 1;

CREATE TABLE student_applications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no                TEXT UNIQUE,                       -- SA-2026-0001, set when the agent submits
  agent_id              UUID NOT NULL REFERENCES agents(id),
  created_by            BIGINT REFERENCES users(id),
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','received','under_review','info_requested','decision_made','coe_issued','withdrawn')),
  decision              TEXT CHECK (decision IN ('offer','not_offered')),
  decision_reason       TEXT,
  decided_by            BIGINT REFERENCES users(id),
  decided_at            TIMESTAMPTZ,
  form_version          TEXT NOT NULL DEFAULT 'AFC-AEF-Int V3.1',
  -- the answers, by section; the few fields staff search and sort on are also kept as columns
  data                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  course_id             BIGINT REFERENCES courses(id),
  campus_id             BIGINT REFERENCES campuses(id),
  commencement_date     DATE,
  student_given_names   TEXT,
  student_surname       TEXT,
  student_email         TEXT,
  date_of_birth         DATE,
  nationality           TEXT,
  docs_received_on      DATE,                              -- the day the agent had the student's completed documents (EAA: submit within 24 hours)
  submitted_at          TIMESTAMPTZ,
  late_submission       BOOLEAN NOT NULL DEFAULT FALSE,
  needs_transfer_review BOOLEAN NOT NULL DEFAULT FALSE,    -- National Code Standard 7: student may be inside 12 months of a principal course
  wants_credit          BOOLEAN NOT NULL DEFAULT FALSE,    -- applying for RPL or credit transfer
  assessment_due        DATE,                              -- 5 working days after submission
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ                        -- a draft the agent discarded
);
CREATE INDEX student_applications_agent_idx ON student_applications (agent_id, created_at DESC);
CREATE INDEX student_applications_status_idx ON student_applications (status, assessment_due);

CREATE TABLE application_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES student_applications(id),
  kind             TEXT NOT NULL,
  label            TEXT,
  file_id          UUID NOT NULL REFERENCES coms_files(id),
  status           TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','accepted','needs_update')),
  review_note      TEXT,
  reviewed_by      BIGINT REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ,
  uploaded_by      BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  delete_reason    TEXT
);
CREATE INDEX application_documents_app_idx ON application_documents (application_id) WHERE deleted_at IS NULL;

CREATE TABLE application_status_log (
  id               BIGSERIAL PRIMARY KEY,
  application_id   UUID NOT NULL REFERENCES student_applications(id),
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  actor_id         BIGINT REFERENCES users(id),
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX application_status_log_app_idx ON application_status_log (application_id, id);

-- documents an application needs; staff can change this list
CREATE TABLE application_doc_types (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  required    BOOLEAN NOT NULL DEFAULT FALSE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO application_doc_types (key, label, required, sort_order) VALUES
  ('signed_form',   'Signed enrolment form (signed by the student)', TRUE, 1),
  ('passport',      'Certified passport biodata pages', TRUE, 2),
  ('english',       'Certified evidence of English (IELTS, PTE, TOEFL or other), or evidence of an exemption', TRUE, 3),
  ('transcripts',   'Certified academic transcripts', TRUE, 4),
  ('certificate',   'Certified academic certificate', TRUE, 5),
  ('statement',     'Statement of purpose', TRUE, 6),
  ('gs_form',       'Completed Genuine Student (GS) form', TRUE, 7),
  ('financial',     'Financial evidence', TRUE, 8),
  ('visa',          'Evidence of current Australian visa, if the student has one', FALSE, 9),
  ('current_coe',   'Current CoE, if the student is studying in Australia', FALSE, 10),
  ('other',         'Other supporting document', FALSE, 11);

-- wording and numbers staff can change without a new release
CREATE TABLE student_app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  BIGINT,                              -- no foreign key: settings must survive a user reset
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO student_app_settings (key, value) VALUES
  ('declaration_items', '["I have read and understood AFC fees and refunds, course progress and attendance monitoring, complaints and appeals policy and procedures given on the Student Handbook, the AFC website at www.afcollege.edu.au and/or the Course Brochure.","I understand that I must participate in scheduled classes in accordance with course timetables to make satisfactory course progress, and failing to achieve satisfactory course progress will result in breach of a condition of my visa.","I hereby declare that the information provided is complete, true and correct.","I declare that I am a genuine student and that I have read and understood the Genuine Student requirement for the Student visa (subclass 500) on the Department of Home Affairs website at https://immi.homeaffairs.gov.au/.","I agree to the collection, use and disclosure of my personal information as per the Privacy Notice.","I declare that my signature is true and correct and matches the signature in my passport."]'::jsonb),
  ('privacy_notice', '"The AFC Privacy Notice is printed on page 8 of the enrolment form (AFC-AEF-Int V3.1). AFC will replace this text with the final privacy wording for the portal."'::jsonb),
  ('agent_not_signed_text', '"I confirm that I did not sign this application on the student''s behalf. The student has signed the enrolment form themselves."'::jsonb),
  ('pre_enrolment_text', '"I confirm that the pre-enrolment information pack was sent to the student before they completed this application. (AFC will replace this with its final wording.)"'::jsonb),
  ('docs_deadline_hours', '24'::jsonb),
  ('assessment_working_days', '5'::jsonb);

-- forms AFC wants agents to download (for example the Genuine Student form); staff upload the files
CREATE TABLE student_forms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label       TEXT NOT NULL,
  file_id     UUID NOT NULL REFERENCES coms_files(id),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7-year records: never deleted
CREATE TRIGGER student_applications_keep BEFORE DELETE ON student_applications FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER application_documents_keep BEFORE DELETE ON application_documents FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER application_status_log_keep BEFORE DELETE ON application_status_log FOR EACH ROW EXECUTE FUNCTION retention_guard();
CREATE TRIGGER student_forms_keep BEFORE DELETE ON student_forms FOR EACH ROW EXECUTE FUNCTION retention_guard();

-- ---------------------------------------------------------------- file kinds used by this phase
ALTER TABLE coms_files DROP CONSTRAINT coms_files_kind_check;
ALTER TABLE coms_files ADD CONSTRAINT coms_files_kind_check
  CHECK (kind IN ('referee', 'declaration', 'task_evidence', 'other', 'agent_document', 'marketing_material', 'application_document', 'student_form'));
