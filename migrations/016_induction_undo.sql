-- A held induction recorded by mistake can be undone (by a director or administrator, with a reason). The record stays for the audit trail.
ALTER TABLE agent_inductions DROP CONSTRAINT agent_inductions_status_check;
ALTER TABLE agent_inductions ADD CONSTRAINT agent_inductions_status_check CHECK (status IN ('scheduled', 'held', 'cancelled', 'missed', 'voided'));
