-- Induction booking details: time, meeting link (online) or place / phone number, and a "did not attend" outcome.
ALTER TABLE agent_inductions ADD COLUMN start_time   TIME;
ALTER TABLE agent_inductions ADD COLUMN meeting_url  TEXT;
ALTER TABLE agent_inductions ADD COLUMN location     TEXT;
ALTER TABLE agent_inductions DROP CONSTRAINT agent_inductions_status_check;
ALTER TABLE agent_inductions ADD CONSTRAINT agent_inductions_status_check CHECK (status IN ('scheduled', 'held', 'cancelled', 'missed'));
