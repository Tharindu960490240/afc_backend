-- Phase 3: agent induction (who ran it, when, notes), scheduling and reminders.
-- agents.induction_recorded_at stays the single milestone that BR-02 checks; each held induction sets it.
CREATE TABLE agent_inductions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(id),
  status         TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'held', 'cancelled')),
  mode           TEXT NOT NULL DEFAULT 'online' CHECK (mode IN ('online', 'in_person', 'phone')),
  scheduled_for  DATE,
  held_on        DATE,
  conducted_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  attendees      TEXT,
  notes          TEXT,
  cancel_reason  TEXT,
  reminder_sent_at  TIMESTAMPTZ,
  followup_sent_at  TIMESTAMPTZ,
  created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'held' OR held_on IS NOT NULL),
  CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL)
);
CREATE INDEX agent_inductions_agent_idx ON agent_inductions (agent_id, created_at DESC);
CREATE INDEX agent_inductions_due_idx ON agent_inductions (scheduled_for) WHERE status = 'scheduled';

-- the due-soon reminder on the induction task is sent once
ALTER TABLE coms_tasks ADD COLUMN reminded_at TIMESTAMPTZ;

-- backfill: inductions already recorded before this change become "held" records
INSERT INTO agent_inductions (agent_id, status, held_on, notes, created_by, created_at)
SELECT id, 'held', induction_recorded_at::date, 'Recorded before induction details were kept', NULL, induction_recorded_at
FROM agents WHERE induction_recorded_at IS NOT NULL;
