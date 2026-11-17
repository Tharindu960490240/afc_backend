-- When the certificate of appointment was last emailed to the agent.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS certificate_sent_at TIMESTAMPTZ;
