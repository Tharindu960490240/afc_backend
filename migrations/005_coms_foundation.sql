-- 005_coms_foundation.sql : COMS Block 1, Part 1
--   staff roles, public-holiday calendar, audit before/after, agent register
--   (agents, people, status history). Existing agent users are back-filled.

-- ---------------------------------------------------------------- roles
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'admin','agent','teacher','student',
  'ceo','director','marketing_officer','admissions','coe_admin','accounts','compliance'));

ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (role IN (
  'admin','agent','teacher','student',
  'ceo','director','marketing_officer','admissions','coe_admin','accounts','compliance'));

-- ---------------------------------------------------------------- audit log
-- before/after values for every change; rows cannot be edited or removed early (NF-04, BR-19)
ALTER TABLE audit_logs ADD COLUMN before JSONB, ADD COLUMN after JSONB;
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);

CREATE FUNCTION audit_logs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- the only allowed change: the foreign key blanks the actor when a user account is removed
    IF NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
       AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_logs rows cannot be changed';
  END IF;
  -- delete: only after the 7-year retention period (developers can set afc.allow_audit_purge=on)
  IF OLD.created_at > now() - interval '7 years'
     AND coalesce(current_setting('afc.allow_audit_purge', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'audit_logs rows are kept for 7 years';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_guard BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_guard();

-- ---------------------------------------------------------------- calendar
CREATE TABLE public_holidays (
  id           BIGSERIAL PRIMARY KEY,
  holiday_date DATE         NOT NULL,
  name         VARCHAR(120) NOT NULL,
  jurisdiction VARCHAR(3)   NOT NULL CHECK (jurisdiction IN ('TAS','VIC')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (holiday_date, jurisdiction)
);

-- Sources: business.vic.gov.au and fairwork.gov.au (checked 3 Nov 2026). Only days that fall on weekdays matter.
-- Not seeded (not yet announced / not statewide): Friday before the 2027 AFL Grand Final, Launceston show and cup days.
INSERT INTO public_holidays (holiday_date, name, jurisdiction) VALUES
 ('2026-01-01','New Year''s Day','TAS'), ('2026-01-26','Australia Day','TAS'),
 ('2026-03-09','Eight Hours Day','TAS'), ('2026-04-03','Good Friday','TAS'),
 ('2026-04-06','Easter Monday','TAS'),   ('2026-06-08','King''s Birthday','TAS'),
 ('2026-11-02','Recreation Day (northern Tasmania)','TAS'),
 ('2026-12-25','Christmas Day','TAS'),   ('2026-12-28','Boxing Day','TAS'),
 ('2027-01-01','New Year''s Day','TAS'), ('2027-01-26','Australia Day','TAS'),
 ('2027-03-08','Eight Hours Day','TAS'), ('2027-03-26','Good Friday','TAS'),
 ('2027-03-29','Easter Monday','TAS'),   ('2027-06-14','King''s Birthday','TAS'),
 ('2027-11-01','Recreation Day (northern Tasmania)','TAS'),
 ('2027-12-27','Christmas Day (additional day)','TAS'), ('2027-12-28','Boxing Day (additional day)','TAS'),

 ('2026-01-01','New Year''s Day','VIC'), ('2026-01-26','Australia Day','VIC'),
 ('2026-03-09','Labour Day','VIC'),      ('2026-04-03','Good Friday','VIC'),
 ('2026-04-06','Easter Monday','VIC'),   ('2026-06-08','King''s Birthday','VIC'),
 ('2026-09-25','Friday before the AFL Grand Final','VIC'),
 ('2026-11-03','Melbourne Cup','VIC'),
 ('2026-12-25','Christmas Day','VIC'),   ('2026-12-28','Boxing Day (additional day)','VIC'),
 ('2027-01-01','New Year''s Day','VIC'), ('2027-01-26','Australia Day','VIC'),
 ('2027-03-08','Labour Day','VIC'),      ('2027-03-26','Good Friday','VIC'),
 ('2027-03-29','Easter Monday','VIC'),   ('2027-06-14','King''s Birthday','VIC'),
 ('2027-11-02','Melbourne Cup','VIC'),
 ('2027-12-27','Christmas Day (additional day)','VIC'), ('2027-12-28','Boxing Day (additional day)','VIC');

-- ---------------------------------------------------------------- agent register
CREATE TABLE agents (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name                VARCHAR(200) NOT NULL,
  trading_names             TEXT[]       NOT NULL DEFAULT '{}',
  abn_acn                   VARCHAR(40),
  country                   VARCHAR(80)  NOT NULL,
  is_body_corporate         BOOLEAN      NOT NULL DEFAULT false,
  principal_address         TEXT,
  registered_office_address TEXT,
  postal_address            TEXT,
  phone                     VARCHAR(30),
  email                     VARCHAR(254) NOT NULL,
  website                   VARCHAR(300),
  marn                      VARCHAR(20),

  status                    VARCHAR(20)  NOT NULL DEFAULT 'prospect'
                            CHECK (status IN ('prospect','applied','due_diligence','approved','onboarding','active',
                                              'under_review','suspended','expired','terminated','rejected')),
  status_changed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  source                    VARCHAR(20)  NOT NULL DEFAULT 'eoi'
                            CHECK (source IN ('eoi','website','invitation','staff','import')),

  -- portfolio (account manager, tier, risk, contact cadence)
  account_manager_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  tier                      VARCHAR(10) CHECK (tier IN ('strategic','growth','standard','dormant')),
  risk_rating               VARCHAR(10) CHECK (risk_rating IN ('low','medium','high')),
  risk_override_reason      TEXT,
  contact_cadence_days      SMALLINT    NOT NULL DEFAULT 30 CHECK (contact_cadence_days BETWEEN 1 AND 365),
  last_contact_at           TIMESTAMPTZ,

  -- SLA clock (business days, see calendarService)
  application_received_at   TIMESTAMPTZ,
  ack_sent_at               TIMESTAMPTZ,
  ack_due_date              DATE,
  decision_due_date         DATE,

  -- onboarding evidence needed before Active (BR-02)
  prisms_recorded_at        TIMESTAMPTZ,
  induction_recorded_at     TIMESTAMPTZ,

  xero_contact_id           VARCHAR(60),
  axcelerate_agent_id       VARCHAR(60),
  rejection_reason          TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at   TIMESTAMPTZ,
  deleted_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  delete_reason TEXT
);
CREATE UNIQUE INDEX agents_email_uq ON agents (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX agents_status_idx  ON agents (status) WHERE deleted_at IS NULL;
CREATE INDEX agents_manager_idx ON agents (account_manager_id);
CREATE INDEX agents_country_idx ON agents (country);

CREATE TABLE agent_persons (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name                    VARCHAR(120) NOT NULL,
  email                   VARCHAR(254) NOT NULL,
  role                    VARCHAR(12)  NOT NULL DEFAULT 'staff' CHECK (role IN ('director','staff','sub_agent')),
  marn                    VARCHAR(20),
  is_director             BOOLEAN NOT NULL DEFAULT false,
  involved_in_enrolments  BOOLEAN NOT NULL DEFAULT false,
  is_primary_contact      BOOLEAN NOT NULL DEFAULT false,
  location                VARCHAR(160),           -- sub-agents / branches
  portal_user_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  training_completed_at   TIMESTAMPTZ,
  active                  BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at   TIMESTAMPTZ,
  deleted_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  delete_reason TEXT
);
CREATE INDEX agent_persons_agent_idx ON agent_persons (agent_id);
CREATE UNIQUE INDEX agent_persons_portal_uq ON agent_persons (portal_user_id) WHERE portal_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE agent_status_history (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status   VARCHAR(20) NOT NULL,
  reason      TEXT,
  changed_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_status_history_agent_idx ON agent_status_history (agent_id, changed_at DESC);

-- an invitation can belong to an agent record created from an expression of interest
ALTER TABLE invitations ADD COLUMN agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- back-fill existing agents
-- Everyone already approved becomes "approved" (not "active"): PRISMS and induction are not recorded yet (BR-02).
DO $$
DECLARE r RECORD; new_id UUID;
BEGIN
  FOR r IN
    SELECT u.id AS user_id, u.email, u.first_name, u.last_name, u.phone, u.status AS user_status, u.created_at,
           ap.agency_name, ap.country, ap.business_number, ap.registered_via, ap.decided_at, ap.rejection_reason
    FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
    WHERE u.role = 'agent'
  LOOP
    INSERT INTO agents (legal_name, abn_acn, country, email, phone, status, source,
                        application_received_at, ack_sent_at, rejection_reason, created_at)
    VALUES (r.agency_name, NULLIF(r.business_number, ''), r.country, r.email, r.phone,
            CASE r.user_status WHEN 'active' THEN 'approved' WHEN 'suspended' THEN 'suspended'
                               WHEN 'rejected' THEN 'rejected' WHEN 'unverified' THEN 'prospect' ELSE 'applied' END,
            CASE WHEN r.registered_via = 'website' THEN 'website' ELSE 'invitation' END,
            r.created_at, r.created_at, r.rejection_reason, r.created_at)
    RETURNING id INTO new_id;

    INSERT INTO agent_persons (agent_id, name, email, role, is_primary_contact, portal_user_id)
    VALUES (new_id, trim(r.first_name || ' ' || r.last_name), r.email, 'staff', true, r.user_id);

    INSERT INTO agent_status_history (agent_id, from_status, to_status, reason)
    SELECT new_id, NULL, status, 'Imported from the existing agent account' FROM agents WHERE id = new_id;
  END LOOP;
END $$;
