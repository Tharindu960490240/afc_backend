-- "Authorised staff" flag, set by the CEO or an administrator (used later for bonus approval and overrides)
ALTER TABLE users ADD COLUMN is_authorised_staff BOOLEAN NOT NULL DEFAULT false;
