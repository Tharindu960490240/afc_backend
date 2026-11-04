-- 004_agent_self_registration.sql : agents can register themselves from the college website

-- new account states for a registration that is not finished yet
--   unverified       -> registered, email not confirmed yet (cannot sign in)
--   pending_approval -> email confirmed, waiting for the college (cannot sign in)
--   rejected         -> the college did not approve it
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('active','suspended','unverified','pending_approval','rejected'));

-- single-use email confirmation links (only the SHA-256 of the token is stored)
CREATE TABLE email_verifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id);

ALTER TABLE agent_profiles
  ADD COLUMN registered_via     VARCHAR(20) NOT NULL DEFAULT 'invitation'
                                CHECK (registered_via IN ('invitation','website')),
  ADD COLUMN email_verified_at  TIMESTAMPTZ,
  ADD COLUMN decided_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN decided_at         TIMESTAMPTZ,
  ADD COLUMN rejection_reason   TEXT;
