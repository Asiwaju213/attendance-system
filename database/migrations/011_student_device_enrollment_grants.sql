-- 011_student_device_enrollment_grants.sql
-- Migration 011: scoped enrollment grants for a student's first device.
--
-- Why this is needed
-- ------------------
-- First-device enrollment is a chicken-and-egg problem. The WebAuthn registration ceremony is
-- self-contained (it proves possession of an authenticator, not of an account), so it does not
-- strictly need a session. But `POST /api/student/device/enrollment/*` sat behind `requireAuth`,
-- so the only way to enroll a first device was to already hold a normal student session.
--
-- The old login endpoint therefore issued a full student session to anyone who presented a
-- matric number and password, on any device. That made "one active device per student" purely a
-- *storage* invariant rather than an access-control one: a second phone obtained a session and
-- could silently replace the first phone's credential through the UPGRADE ceremony.
--
-- This table is the replacement. A matric+password login for a student with NO ACTIVE device
-- yields a short-lived, single-use *enrollment grant* instead of a session. The grant authorizes
-- exactly the three enrollment operations and nothing else; the normal `oou_session` is minted
-- only after the WebAuthn ceremony commits.
--
-- Design notes, mirroring `sessions` and `student_registration_challenges`:
--
--   * the raw grant is a 256-bit cryptographically random token; only its SHA-256 hash is
--     persisted, so a database read cannot be replayed as a credential;
--   * single use: consumption is a conditional `UPDATE ... WHERE status = 'ACTIVE'`, so two
--     concurrent enrollments cannot both win;
--   * `expires_at` is a hard ceiling (~10 minutes) independent of the cookie max-age;
--   * `student_id NOT NULL` makes the grant student-bound by construction. This is the property
--     the login challenges table deliberately lacks, because there the student is unknown until
--     the assertion is verified. Here they are already known, and binding is what makes the
--     grant safe to resolve on an unauthenticated request;
--   * a grant is an *authorization* to enroll, never an identity. The student id is read from
--     the grant row, never from request input, and `requireAuth` does not accept it.
--
-- The UNIQUE constraint on `student_id` is the important one: a student may hold at most one
-- ACTIVE grant, so a new login supersedes any previous (possibly abandoned) attempt instead of
-- accumulating parallel credentials.
CREATE TABLE student_device_enrollment_grants (
  id            BIGSERIAL   PRIMARY KEY,
  student_id    BIGINT      NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  -- SHA-256 (hex) of the opaque token. Never the token itself.
  grant_hash    TEXT        NOT NULL UNIQUE,
  status        TEXT        NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ
);

CREATE TRIGGER student_device_enrollment_grants_set_updated_at
BEFORE UPDATE ON student_device_enrollment_grants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One live grant per student. Grant issuance and resolution are both keyed on student_id, so
-- this index serves every query the application makes.
CREATE UNIQUE INDEX one_active_enrollment_grant_per_student
  ON student_device_enrollment_grants (student_id)
  WHERE status = 'ACTIVE';

-- Expiry sweep for spent/expired rows.
CREATE INDEX idx_student_device_enrollment_grants_expires_at
  ON student_device_enrollment_grants (expires_at);

COMMENT ON TABLE student_device_enrollment_grants IS
  'Short-lived, single-use authorization to complete a first-device WebAuthn enrollment. Issued '
  'in place of a normal student session when a matric number + password login is performed by a '
  'browser with no device binding. Authorizes only the device enrollment operations; it is never '
  'accepted by requireAuth and can never reach a normal student API. Store only the SHA-256 hash '
  'of the token.';
