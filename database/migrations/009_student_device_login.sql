-- 009_student_device_login.sql
-- Migration 009: groundwork for device-identified student login.
--
-- Three changes:
--
--  1. `students.webauthn_user_handle` — an opaque, cryptographically random WebAuthn user
--     handle. The ceremony previously sent `String(students.id)` as the WebAuthn `user.id`,
--     which publishes a sequential, guessable database identifier to every browser and
--     authenticator (and, for synced passkeys, to third-party password managers). Handles
--     are 256 bits of `gen_random_uuid()` output and are never derived from the student id
--     or the matric number. `gen_random_uuid()` is core from PostgreSQL 13 and is drawn from
--     a cryptographic RNG.
--
--  2. `student_device_login_challenges` — pre-authentication WebAuthn challenges for the
--     student login ceremony. This deliberately does NOT reuse
--     `student_device_enrollment_challenges`: that table keys its challenges on
--     `student_id NOT NULL` with a partial unique index on `student_id`, which is exactly
--     what a login challenge cannot have, because the student is not identified until their
--     assertion has been verified.
--
--  3. `student_devices.credential_id` uniqueness narrowed from table-wide to ACTIVE-only.
--     With a table-wide UNIQUE, an admin device reset permanently burned the credential: the
--     row moved to 'REVOKED' but the credential ID could then never be enrolled by anyone
--     again, so a platform authenticator that re-emits the same credential ID (normal
--     behaviour for synced passkeys) could never be re-enrolled, locking the student out for
--     good. Scoping uniqueness to ACTIVE rows keeps the invariant that actually matters — a
--     credential can never be actively enrolled by two students — while allowing
--     re-enrollment after an explicit admin reset.

------------------------------------------------------------------------
-- 1. Opaque WebAuthn user handle
------------------------------------------------------------------------
ALTER TABLE students
  ADD COLUMN webauthn_user_handle TEXT;

-- Backfill every existing student. Two `gen_random_uuid()` calls are concatenated so the
-- handle carries 256 bits of entropy rendered as 64 lowercase hex characters. The
-- expression is evaluated once per row, so every student receives a distinct value.
UPDATE students
   SET webauthn_user_handle =
         replace(gen_random_uuid()::text, '-', '')
         || replace(gen_random_uuid()::text, '-', '');

-- The same expression becomes the column default, so students created later by imports,
-- seeds, or any future code path receive a handle without an application change. The
-- UNIQUE constraint below still guarantees handles never collide.
ALTER TABLE students
  ALTER COLUMN webauthn_user_handle
  SET DEFAULT (
    replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '')
  );

ALTER TABLE students
  ALTER COLUMN webauthn_user_handle SET NOT NULL;

ALTER TABLE students
  ADD CONSTRAINT students_webauthn_user_handle_key UNIQUE (webauthn_user_handle);

------------------------------------------------------------------------
-- 2. Pre-authentication student login challenges
------------------------------------------------------------------------
-- Mirrors the challenge pattern used by `sessions`, `student_registration_challenges` and
-- `student_device_enrollment_challenges`:
--   * only a SHA-256 hash of the challenge is persisted, never the raw value
--   * a challenge is single-use and short-lived (`expires_at`, enforced in SQL here rather
--     than only in application code)
--   * a second, independent `binding_token_hash` ties the challenge to the single browser
--     flow that requested it, so an assertion captured from one issuance cannot be replayed
--     against a different one
--
-- There is intentionally no `student_id` column: the student is unknown until the assertion
-- is verified, and the credential in the assertion is the only thing that resolves it.
CREATE TABLE student_device_login_challenges (
  id                 BIGSERIAL   PRIMARY KEY,
  challenge_hash     TEXT        NOT NULL UNIQUE,
  binding_token_hash TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'ACTIVE'
                                   CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ
);

CREATE TRIGGER student_device_login_challenges_set_updated_at
BEFORE UPDATE ON student_device_login_challenges
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Challenge lookup at verification time is served by the unique index that the
-- `challenge_hash` UNIQUE constraint already created; a second index would be redundant.
--
-- Active/unconsumed accounting.
CREATE INDEX idx_student_device_login_challenges_active
  ON student_device_login_challenges (created_at)
  WHERE status = 'ACTIVE';

-- Expiry sweep for spent/expired rows.
CREATE INDEX idx_student_device_login_challenges_expires_at
  ON student_device_login_challenges (expires_at);

-- A binding token may back at most one challenge.
CREATE UNIQUE INDEX one_binding_token_per_login_challenge
  ON student_device_login_challenges (binding_token_hash);

------------------------------------------------------------------------
-- 3. Credential ID uniqueness scoped to ACTIVE devices
------------------------------------------------------------------------
-- The partial unique index created in 001 (`one_active_device_per_student`) is left
-- untouched: a student still holds at most one ACTIVE device.
ALTER TABLE student_devices
  DROP CONSTRAINT student_devices_credential_id_key;

-- One credential can never be ACTIVE for two students. Revoked rows keep their credential ID
-- as an audit record and no longer block a deliberate re-enrollment.
CREATE UNIQUE INDEX one_active_credential_id
  ON student_devices (credential_id)
  WHERE status = 'ACTIVE';
