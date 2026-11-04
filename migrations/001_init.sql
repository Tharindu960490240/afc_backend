-- 001_init.sql : users, role profiles, invitations, password resets, audit log

CREATE TABLE users (
  id                    BIGSERIAL PRIMARY KEY,
  email                 VARCHAR(254) NOT NULL,
  password_hash         VARCHAR(100) NOT NULL,
  first_name            VARCHAR(80)  NOT NULL,
  last_name             VARCHAR(80)  NOT NULL,
  phone                 VARCHAR(30),
  role                  VARCHAR(20)  NOT NULL
                        CHECK (role IN ('admin','agent','teacher','student')),
  status                VARCHAR(20)  NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended')),
  profile_image         TEXT,
  -- bump to instantly invalidate every token issued before (password change, suspension)
  token_version         INTEGER      NOT NULL DEFAULT 0,
  failed_login_count    INTEGER      NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  consent_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- case-insensitive uniqueness; the app also lower-cases emails
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE INDEX users_role_idx   ON users (role);
CREATE INDEX users_status_idx ON users (status);

CREATE TABLE agent_profiles (
  user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agency_name     VARCHAR(160) NOT NULL,
  business_number VARCHAR(40)  NOT NULL,
  country         VARCHAR(80)  NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE student_profiles (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth DATE        NOT NULL,
  country       VARCHAR(80) NOT NULL,
  -- the agent who referred the student (null = direct / admin invited)
  agent_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id               BIGSERIAL PRIMARY KEY,
  email            VARCHAR(254) NOT NULL,
  role             VARCHAR(20)  NOT NULL
                   CHECK (role IN ('admin','agent','teacher','student')),
  first_name       VARCHAR(80),
  -- only the SHA-256 of the token is stored; the raw token exists only in the email link
  token_hash       CHAR(64) NOT NULL UNIQUE,
  invited_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  accepted_at      TIMESTAMPTZ,
  accepted_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- at most one open invitation per email
CREATE UNIQUE INDEX invitations_open_email_uq
  ON invitations (lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_invited_by_idx ON invitations (invited_by);

CREATE TABLE password_resets (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40),
  entity_id   VARCHAR(40),
  ip          VARCHAR(64),
  user_agent  VARCHAR(300),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx   ON audit_logs (actor_id);
CREATE INDEX audit_logs_action_idx  ON audit_logs (action, created_at DESC);
