-- 003_agreement_signing.sql : agreements are generated from a template and signed inside the portal

-- ---------- templates (every edit is a new version, the newest active one is used) ----------
CREATE TABLE agreement_templates (
  id          BIGSERIAL PRIMARY KEY,
  name        VARCHAR(160) NOT NULL,
  body        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT false,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agreement_templates_one_active ON agreement_templates (is_active) WHERE is_active;

-- Sample wording so the flow works straight away. The college must have its own text
-- reviewed by a lawyer and then paste it in from Admin > Agreements > Edit template.
INSERT INTO agreement_templates (name, body, version, is_active) VALUES (
  'Education Agent Agreement',
$tpl$# Education Agent Agreement

This Agreement is made between {{college_name}} (CRICOS Provider {{college_cricos}}, RTO {{college_rto}}) (the College) and {{agency_name}}, business number {{business_number}}, of {{country}}, represented by {{agent_name}} ({{agent_email}}) (the Agent).

## 1. Appointment
The College appoints the Agent, on a non-exclusive basis, to recruit prospective international students for the College's courses. The Agent is an independent contractor and is not an employee, partner or legal representative of the College. The Agent must not make any promise or commitment on behalf of the College.

## 2. Term
This Agreement starts on {{effective_date}} and continues until {{expiry_date}} unless it is ended earlier under clause 8. It may be renewed in writing by the College.

## 3. The Agent's responsibilities
The Agent must act honestly, ethically and professionally, and must comply with the Education Services for Overseas Students Act 2000, the National Code of Practice for Providers of Education and Training to Overseas Students, and all other laws that apply to the recruitment of students.

The Agent must give prospective students accurate and current information about the College and its courses, fees, entry requirements and refund policies, and must not guarantee admission, visa outcomes, employment or migration outcomes.

The Agent must submit complete and truthful applications, must not submit false or altered documents, and must not collect tuition fees on behalf of the College unless the College has agreed in writing.

## 4. The College's responsibilities
The College will provide the Agent with accurate course and fee information, process applications that the Agent submits through the portal, and tell the Agent the outcome of each application. The College decides whether to accept any student and may refuse an application at its discretion.

## 5. Commission
Commission is payable only on students who the Agent referred, who enrolled and who paid the fees required, and in the amounts set out in the commission schedule that the College provides to the Agent. The College may change the schedule for future students by giving the Agent written notice.

## 6. Privacy and confidentiality
Each party must handle personal information in line with the Privacy Act 1988 (Cth) and must keep confidential any non-public information that it receives from the other party. The Agent may use student information only to carry out this Agreement.

## 7. Use of the College's name
The Agent may use the College's name and logo only in material that the College has approved in writing, and must stop using them when this Agreement ends.

## 8. Ending this Agreement
Either party may end this Agreement by giving 30 days' written notice. The College may end it immediately if the Agent breaches this Agreement, acts dishonestly or damages the College's reputation. The Agent must stop acting for the College when this Agreement ends, and commission remains payable on students who had already enrolled and paid before that date.

## 9. General
This Agreement is the whole agreement between the parties on its subject. It is governed by the laws of Tasmania, Australia, and the parties submit to the courts of that State. The parties agree that this Agreement may be signed electronically and that an electronic signature has the same effect as a handwritten one.$tpl$,
  1, true
);

-- ---------- what was sent, and who signed it ----------
ALTER TABLE agreements
  ADD COLUMN template_id           BIGINT REFERENCES agreement_templates(id) ON DELETE SET NULL,
  -- the exact wording sent to the agent (only the effective/expiry dates are still open)
  ADD COLUMN body_snapshot         TEXT,
  ADD COLUMN body_sha256           CHAR(64),
  ADD COLUMN agent_sig_name        VARCHAR(120),
  ADD COLUMN agent_sig_image       BYTEA,
  ADD COLUMN agent_signed_at       TIMESTAMPTZ,
  ADD COLUMN agent_signed_ip       VARCHAR(64),
  ADD COLUMN admin_sig_name        VARCHAR(120),
  ADD COLUMN admin_sig_position    VARCHAR(120),
  ADD COLUMN admin_sig_image       BYTEA,
  ADD COLUMN admin_signed_at       TIMESTAMPTZ,
  ADD COLUMN admin_signed_ip       VARCHAR(64);

-- the finished, fully signed PDF is stored as a file of kind 'final'
ALTER TABLE agreement_files DROP CONSTRAINT agreement_files_kind_check;
ALTER TABLE agreement_files
  ADD CONSTRAINT agreement_files_kind_check
  CHECK (kind IN ('template','signed_by_agent','countersigned','final'));
