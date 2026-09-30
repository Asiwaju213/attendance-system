-- 010_student_device_credential_discoverability.sql
-- Migration 010: record whether an enrolled student credential is a *discoverable*
-- credential (a resident key / passkey).
--
-- Why this is needed
-- ------------------
-- The device-identified student login ceremony is usernameless: it calls
-- navigator.credentials.get() with NO allowCredentials, so the authenticator only ever
-- returns a credential it can find by itself. A non-discoverable (server-side) credential
-- cannot be returned by such a call at all, so a credential enrolled before the
-- `residentKey: "required"` policy existed is unusable for that login even though it
-- works perfectly well for attendance (which does name the credential).
--
-- Nothing in the existing schema records whether a given credential is discoverable, and
-- it cannot be recovered after the fact: the flag lives in the authenticator's attested
-- credential data at registration time and is never sent again. Guessing from
-- `enrolled_at` against a code-change date would be unreliable, so the fact is recorded
-- from now on.
--
-- The safe default
-- ----------------
-- Existing rows are left NULL, meaning "unknown". NULL and FALSE are treated identically:
-- the credential is NOT accepted for usernameless login, and the student is offered the
-- authenticated upgrade flow instead. So a mis-detection can only ever be inconvenient
-- (one extra re-enrolment), never permissive.

ALTER TABLE student_devices
  ADD COLUMN discoverable BOOLEAN;

COMMENT ON COLUMN student_devices.discoverable IS
  'TRUE when the credential was created as a discoverable (resident) credential and may '
  'therefore be used for usernameless device-identified login. NULL means unknown: every row '
  'that predates this column, plus any credential whose authenticator did not report the '
  'creds extension. NULL/FALSE are treated as non-discoverable and routed through the '
  'authenticated upgrade flow; the existing device keeps working for attendance either way.';

-- ---------------------------------------------------------------------------
-- No new index.
-- discoverable is only ever read together with a student_id or credential_id lookup, both of
-- which already have indexes (one_active_device_per_student, one_active_credential_id), so a
-- standalone index here would not be used by any query in the codebase.
-- ---------------------------------------------------------------------------
