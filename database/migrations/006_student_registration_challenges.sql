-- 006_student_registration_challenges.sql
-- Migration 006: student self-registration foundation.
--
-- Students are bulk imported by an administrator as:
--   users.role = 'STUDENT', users.status = 'PENDING', users.password_hash = NULL
-- with a matching students row. The student then claims that identity through
-- the registration flow. This migration adds a table for the short-lived,
-- one-time-use registration challenge that proves the right to complete the
-- registration without the client ever supplying name/department/level/role.
--
-- Security properties (mirroring the server-side session pattern):
--   * the raw challenge token is never persisted; only its SHA-256 hash
--   * a challenge is bound to exactly one user_id (the pending student)
--   * only a single ACTIVE challenge may exist per user
--   * challenges are short-lived and are consumed on use (one-time use)

CREATE TABLE student_registration_challenges (
  id                   BIGSERIAL   PRIMARY KEY,
  user_id              BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  challenge_token_hash TEXT        NOT NULL UNIQUE,
  status               TEXT        NOT NULL DEFAULT 'ACTIVE'
                                    CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at          TIMESTAMPTZ
);

-- At most one live challenge per student.
CREATE UNIQUE INDEX one_active_registration_challenge_per_user
  ON student_registration_challenges (user_id)
  WHERE status = 'ACTIVE';

CREATE INDEX idx_student_registration_challenges_user_id
  ON student_registration_challenges (user_id);