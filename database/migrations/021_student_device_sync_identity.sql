-- 021_student_device_sync_identity.sql
--
-- Device state synchronizes cloud -> edge, and like every other entity that
-- crosses the boundary (attendance sessions from 012, master data from 013,
-- students from 019, registrations from 020) it needs identities that mean the
-- same thing in both databases.
--
-- Two identities are added, and they are deliberately different things:
--
--   `student_devices.sync_id`   the identity OF THIS ROW. It is what
--                               `sync_change_events.entity_id` is addressed by
--                               and what the edge upserts against, exactly like
--                               every other synchronized entity.
--
--   `student_devices.device_ref` the identity OF THIS DEVICE as a device. It is
--                               an opaque, stable UUID the browser may be handed
--                               (as the device-binding cookie value) and the
--                               edge may resolve WITHOUT ever seeing the WebAuthn
--                               credential id. Credential ids stay local to the
--                               database that enrolled them; `device_ref` is the
--                               only device identifier that is safe to let travel.
--                               It is stable for the lifetime of the device row:
--                               a revoked row keeps its `device_ref`, and a
--                               replacement gets a new one.
--
-- What the edge stores: `sync_student_devices`
-- ---------------------------------------------
-- A projection, not a mirror of `student_devices`. The replica holds exactly
-- what a device-state decision needs - which cloud device, for which student,
-- ACTIVE or REVOKED - and nothing else:
--
--   * NO credential id, public key, counter, transports, AAGUID, label,
--     discoverable flag or timestamps of the ceremony. None of it crosses the
--     boundary (see the emitter's explicit column list), so none of it exists
--     here to leak.
--   * NO row in `users`, no password, no session. The replica answers "does this
--     student hold an ACTIVE device binding" - it is not a login credential.
--   * `student_id` is a real foreign key to the edge's `students` row, resolved
--     from `cloud_student_sync_id` by the applier, so a device event whose
--     student has not synchronized yet fails the batch instead of dangling.
--
-- The partial unique index keeps the cloud's one-active-device-per-student rule
-- enforceable on the edge too, so a mis-ordered feed cannot install two active
-- bindings for one student: the applier refuses rather than guessing which one
-- is current.
--
-- What this migration deliberately does NOT touch
-- ------------------------------------------------
-- Every credential column of `student_devices` (credential_id,
-- credential_public_key, counter, transports, cred_type, aaguid, discoverable)
-- and every challenge/grant/session table stay exactly as they are. This
-- migration adds two UUID columns and one projection table; it revokes nothing,
-- rewrites nothing, and backfills nothing by UPDATE - the column defaults give
-- every pre-existing device row both UUIDs in place.
--
-- Existing rows
-- -------------
-- NOT NULL DEFAULT gen_random_uuid() gives every pre-existing device row a
-- `sync_id` and a `device_ref` with no backfill UPDATE over a table attendance
-- verification reads. The cloud's copy of those devices still needs to be
-- PUBLISHED into the feed once; that is `scripts/backfillMasterDataFeed.ts`,
-- which is a script, is guarded against production, and is not part of this
-- migration.

ALTER TABLE student_devices
  ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Unique so the edge can find its row by cloud identity without relying on
-- either database's integer sequence, and so two cloud devices can never
-- resolve to one replica row.
CREATE UNIQUE INDEX idx_student_devices_sync_id
  ON student_devices (sync_id);

ALTER TABLE student_devices
  ADD COLUMN device_ref UUID NOT NULL DEFAULT gen_random_uuid();

-- Unique so one device reference means exactly one device row: the binding
-- lookup resolves it without a table scan, and two devices can never share a
-- reference even after one of them is revoked.
CREATE UNIQUE INDEX idx_student_devices_device_ref
  ON student_devices (device_ref);

-- ---------------------------------------------------------------------------
-- The edge's replica of device state
-- ---------------------------------------------------------------------------
-- A projection like `sync_lecturers` (migration 013), not a mirrored real
-- table: the edge's own `student_devices` rows belong to credentials enrolled
-- LOCALLY, and mixing cloud-owned device rows into that table would make a
-- locally enrolled credential and a cloud enrolled one indistinguishable.
CREATE TABLE sync_student_devices (
  cloud_sync_id           UUID        PRIMARY KEY,
  -- Opaque device identity the cloud issued; the natural key a re-issued
  -- sync_id would adopt, and the value a binding cookie may carry.
  cloud_device_ref        UUID        NOT NULL,
  -- Resolved by the applier from `cloud_student_sync_id`; NOT NULL so a device
  -- can never be stored without an owner.
  student_id              BIGINT      NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  -- Carried for diagnostics and for re-checking the parent without a join; the
  -- authoritative link is `student_id`.
  cloud_student_sync_id   UUID        NOT NULL,
  status                  TEXT        NOT NULL
                                      CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One device reference can only ever describe one replica row, no matter how
-- often the feed re-delivers it.
CREATE UNIQUE INDEX idx_sync_student_devices_device_ref
  ON sync_student_devices (cloud_device_ref);

-- The cloud's `one_active_device_per_student` rule, enforced on the edge: the
-- applier refuses an event that would make a second device ACTIVE for one
-- student, and this index is the database-level backstop if it ever slips.
CREATE UNIQUE INDEX one_active_sync_student_device_per_student
  ON sync_student_devices (student_id)
  WHERE status = 'ACTIVE';

-- The login binding lookup resolves a device reference to a student.
CREATE INDEX idx_sync_student_devices_student
  ON sync_student_devices (student_id);

CREATE TRIGGER sync_student_devices_set_updated_at
BEFORE UPDATE ON sync_student_devices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
