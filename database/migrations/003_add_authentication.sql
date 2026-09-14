-- 003_add_authentication.sql
-- Migration 003: authentication foundation.
--   * adds a nullable, unique `username` column to users (used for ADMIN login)
--   * ADMIN users must have a username; non-admin users may keep it NULL
--   * creates the `sessions` table for server-side session storage
--     (only a hash of the session token is stored; revoked/expired rows are
--     retained for audit history)

----------------------------------------------------------------------------
-- users.username
----------------------------------------------------------------------------
-- Unique when present (PostgreSQL UNIQUE allows multiple NULLs).
ALTER TABLE users
  ADD COLUMN username TEXT UNIQUE;

-- Admins must log in with a username.
ALTER TABLE users
  ADD CONSTRAINT chk_users_admin_requires_username
  CHECK (role <> 'ADMIN' OR username IS NOT NULL);

----------------------------------------------------------------------------
-- sessions
----------------------------------------------------------------------------
-- One row per issued session. The raw token is never persisted; only its
-- SHA-256 hash (session_token_hash) is stored. Revoked sessions are kept
-- for history instead of being deleted.
CREATE TABLE sessions (
  id                 BIGSERIAL   PRIMARY KEY,
  user_id            BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_token_hash TEXT        NOT NULL UNIQUE,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ
);

-- Look up sessions for a user (also serves revocation/audit queries).
CREATE INDEX idx_sessions_user_id ON sessions (user_id);

-- Identify sessions that have passed their expiry date.
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);