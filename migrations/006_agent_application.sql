-- COMS Block 1, Part 1 (completion): the full agent application form.
-- Declarations the applicant makes, and the two referees named on the form.
-- Referee checks (emails, phone calls, outcomes) are built in Part 2 on top of agent_referees.

ALTER TABLE agents
  ADD COLUMN coi_declared              BOOLEAN,       -- conflict-of-interest declaration: true = has a conflict
  ADD COLUMN coi_details               TEXT,
  ADD COLUMN code_of_ethics_ack_at     TIMESTAMPTZ,
  ADD COLUMN information_confirmed_at  TIMESTAMPTZ,   -- "the information in this application is true"
  ADD COLUMN application_submitted_at  TIMESTAMPTZ;

CREATE TABLE agent_referees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name          VARCHAR(120) NOT NULL,
  organisation  VARCHAR(160) NOT NULL,
  email         VARCHAR(254) NOT NULL,
  phone         VARCHAR(30),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at    TIMESTAMPTZ,
  deleted_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  delete_reason TEXT
);
CREATE INDEX agent_referees_agent_idx ON agent_referees (agent_id) WHERE deleted_at IS NULL;
