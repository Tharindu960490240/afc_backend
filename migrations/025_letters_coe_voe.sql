-- Phase 5 step 3: Letter of Offer, payment confirmation, CoE record and Verification of Enrolment.
-- The wording is a starting point. AFC edits it on the Application settings screen and ticks "confirmed" before any letter can be issued.

CREATE TABLE letters_of_offer (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES student_applications(id),
  version          INT  NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','superseded')),
  body             TEXT NOT NULL,
  tuition_fee      NUMERIC(10,2),
  material_fee     NUMERIC(10,2),
  enrolment_fee    NUMERIC(10,2),
  prepared_by      BIGINT REFERENCES users(id),
  issued_by        BIGINT REFERENCES users(id),
  issued_at        TIMESTAMPTZ,
  file_id          UUID REFERENCES coms_files(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX letters_of_offer_one_live_idx ON letters_of_offer (application_id) WHERE status IN ('draft','issued');
CREATE TRIGGER letters_of_offer_keep BEFORE DELETE ON letters_of_offer FOR EACH ROW EXECUTE FUNCTION retention_guard();

ALTER TABLE student_applications
  ADD COLUMN payment_confirmed_at TIMESTAMPTZ,
  ADD COLUMN payment_confirmed_by BIGINT REFERENCES users(id),
  ADD COLUMN payment_note         TEXT,
  ADD COLUMN coe_number           TEXT,
  ADD COLUMN coe_issued_on        DATE,
  ADD COLUMN coe_recorded_by      BIGINT REFERENCES users(id),
  ADD COLUMN coe_file_id          UUID REFERENCES coms_files(id),
  ADD COLUMN voe_issued_at        TIMESTAMPTZ,
  ADD COLUMN voe_issued_by        BIGINT REFERENCES users(id),
  ADD COLUMN voe_file_id          UUID REFERENCES coms_files(id);

ALTER TABLE coms_files DROP CONSTRAINT coms_files_kind_check;
ALTER TABLE coms_files ADD CONSTRAINT coms_files_kind_check
  CHECK (kind IN ('referee', 'declaration', 'task_evidence', 'other', 'agent_document', 'marketing_material', 'application_document', 'student_form',
                  'letter_of_offer', 'coe_confirmation', 'voe'));

INSERT INTO student_app_settings (key, value) VALUES
  ('loo_template', to_jsonb($t$Dear {{student_name}},

[Placeholder wording until AFC supplies its Letter of Offer.] Australian Federation College is pleased to offer you a place in {{course}} at our {{campus}} campus.

Course: {{course}}
CRICOS course code: {{cricos_code}}
Campus: {{campus}}
Course start date: {{start_date}}
Duration: {{duration_weeks}} weeks

Tuition fee: {{tuition_fee}}
Material fee: {{material_fee}}
Enrolment fee (non-refundable): {{enrolment_fee}}
Total: {{total_fee}}

Conditions of this offer:
{{conditions}}

Please read this letter carefully with the AFC fees and refund policy and the Student Handbook. Your agent will help you accept the offer.

Yours sincerely,
{{signer_name}}
{{signer_title}}$t$::text)),
  ('loo_conditions', to_jsonb('[Placeholder] The offer depends on the student meeting the entry requirements and providing true and complete documents.'::text)),
  ('loo_signer_name', to_jsonb('Authorised officer'::text)),
  ('loo_signer_title', to_jsonb('Australian Federation College'::text)),
  ('voe_template', to_jsonb($t$VERIFICATION OF ENROLMENT

[Placeholder wording until AFC supplies its form.] This is to confirm that {{student_name}} (date of birth {{date_of_birth}}, passport {{passport_number}}) is enrolled in {{course}} at the {{campus}} campus of Australian Federation College, CRICOS provider 03846G.

Confirmation of Enrolment number: {{coe_number}}
Course start date: {{start_date}}
Issued on: {{date}}

{{signer_name}}
{{signer_title}}$t$::text)),
  ('letters_confirmed', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
