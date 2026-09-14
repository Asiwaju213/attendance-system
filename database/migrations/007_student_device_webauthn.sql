-- 007_student_device_webauthn.sql
-- Migration 007: bring `student_devices` up to the WebAuthn / passkey model and add
-- a dedicated table for device-enrollment challenges.
--
-- The original `student_devices` table (001) carried a single opaque `device_credential`
-- TEXT blob. WebAuthn credential storage needs discrete fields (credential ID, COSE
-- public-key bytes, signature counter, transports, authenticator metadata), and each
-- credential ID must be globally unique across the RP so one authenticator can never be
-- enrolled twice. The old blob column cannot express any of that, so it is replaced.
--
-- The table has no production rows yet (enrollment is not implemented until this task),
-- so restructuring in place is safe. Historical/revoked devices are preserved: rows are
-- never deleted, they just move to 'REVOKED'.
--
-- Challenge storage mirrors the `student_registration_challenges` / `sessions` pattern:
--   * only a SHA-256 hash of the challenge is persisted (never the raw value)
--   * a challenge is bound to exactly one student
--   * only a single ACTIVE challenge may exist per student
--   * challenges are short-lived and consumed on successful (or concurrent) use

------------------------------------------------------------------------
-- student_devices: restructure for WebAuthn credential storage
------------------------------------------------------------------------
ALTER TABLE student_devices
  DROP COLUMN device_credential;

ALTER TABLE student_devices
  ADD COLUMN credential_id TEXT NOT NULL UNIQUE;

-- Raw COSE-encoded public key bytes, as returned by the authenticator.
ALTER TABLE student_devices
  ADD COLUMN credential_public_key BYTEA NOT NULL;

-- WebAuthn signature counter. Stored and updated on each future assertion to help
-- detect cloned authenticators. Starts at the value reported at enrollment time.
ALTER TABLE student_devices
  ADD COLUMN counter BIGINT NOT NULL DEFAULT 0;

-- How the browser can talk to this credential's authenticator (display metadata only,
-- 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid' | 'smart-card' | 'cable'). Nullable.
ALTER TABLE student_devices
  ADD COLUMN transports TEXT[];

-- WebAuthn credential type; only 'public-key' exists today but the column is explicit.
ALTER TABLE student_devices
  ADD COLUMN cred_type TEXT NOT NULL DEFAULT 'public-key'
            CHECK (cred_type IN ('public-key'));

-- AAGUID of the authenticator that created the credential, for audit only.
ALTER TABLE student_devices
  ADD COLUMN aaguid TEXT;

-- Optional human-readable label supplied by the student. Display metadata ONLY;
-- never treated as an identity or security field.
ALTER TABLE student_devices
  ADD COLUMN label TEXT;

ALTER TABLE student_devices
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TRIGGER student_devices_set_updated_at
BEFORE UPDATE ON student_devices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- At most one ACTIVE device per student remains enforced (index was created in 001).
-- `credential_id` above is UNIQUE table-wide, which backstops the application-level
-- "credential already in use" check.

------------------------------------------------------------------------
-- student_device_enrollment_challenges
------------------------------------------------------------------------
CREATE TABLE student_device_enrollment_challenges (
  id             BIGSERIAL   PRIMARY KEY,
  student_id     BIGINT      NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  challenge_hash TEXT        NOT NULL UNIQUE,
  status         TEXT        NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX one_active_device_enrollment_challenge
  ON student_device_enrollment_challenges (student_id)
  WHERE status = 'ACTIVE';

CREATE INDEX idx_student_device_enrollment_challenges_student
  ON student_device_enrollment_challenges (student_id);