-- 005_student_import_previews.sql
-- Migration 005: bulk student import foundation.
--   * `users.password_hash` becomes nullable so an administrator can preload
--     legitimate student identities WITHOUT creating a password. A student
--     who has not yet claimed/registered their account simply has
--     `password_hash = NULL`; the later registration flow sets a real hash.
--     No fake or default passwords are ever stored.
--   * `users.status` gains a `PENDING` value: imported students who have not
--     been claimed/onboarded yet. `requireAuth`/login already reject anything
--     that is not `ACTIVE`, so this state is safe by construction.
--   * a `student_import_previews` table stores short-lived, server-side
--     preview snapshots so the confirming import cannot be tricked into
--     inserting an arbitrary list sent by the client.

----------------------------------------------------------------------------
-- users.password_hash nullable
----------------------------------------------------------------------------
ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

----------------------------------------------------------------------------
-- users.status gains PENDING
-- The original inline CHECK was auto-named users_status_check.
----------------------------------------------------------------------------
ALTER TABLE users
  DROP CONSTRAINT users_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE', 'PENDING'));

----------------------------------------------------------------------------
-- student_import_previews
-- A preview result is tied to a random server-side token, is one-time use,
-- and expires shortly after it is created. The confirming import replays the
-- exact rows captured at preview time; the client never resends student data.
----------------------------------------------------------------------------
CREATE TABLE student_import_previews (
  id             BIGSERIAL   PRIMARY KEY,
  token          TEXT        NOT NULL UNIQUE,
  department_id  BIGINT      NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  level_id       BIGINT      NOT NULL REFERENCES levels(id)      ON DELETE RESTRICT,
  status         TEXT        NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  total_rows     INTEGER     NOT NULL,
  valid_rows     INTEGER     NOT NULL,
  invalid_rows   INTEGER     NOT NULL,
  rows           JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at    TIMESTAMPTZ
);

CREATE INDEX idx_student_import_previews_token ON student_import_previews (token);
CREATE INDEX idx_student_import_previews_expiry ON student_import_previews (created_at);