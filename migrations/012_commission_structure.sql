-- Commission structure (EAA Schedule 1): percentages per course type, and when the Accounts email was sent
ALTER TABLE agents
  ADD COLUMN commission_vet_pct    NUMERIC(5,2),
  ADD COLUMN commission_elicos_pct NUMERIC(5,2),
  ADD COLUMN terms_sent_at         TIMESTAMPTZ,
  ADD COLUMN terms_sent_by         BIGINT REFERENCES users(id) ON DELETE SET NULL;

