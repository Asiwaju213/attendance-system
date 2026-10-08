-- 020_course_registration_sync_identity.sql
--
-- Course registrations synchronize cloud -> edge, and like every other entity
-- that crosses the boundary (attendance sessions from 012, master data from
-- 013, students from 019) they need a stable cross-database identity. The
-- cloud's BIGSERIAL `course_registrations.id` and the edge's are independent
-- sequences, so cloud registration 42 and edge registration 42 are unrelated
-- rows; `sync_id` is the only identifier that means the same thing in both
-- databases.
--
-- Where the identity lives
-- ------------------------
-- On `course_registrations` itself, not on its two parents. The parents
-- (`students`, `course_offerings`) already carry their own `sync_id` from
-- migrations 019 and 013, and a registration event carries both of those as
-- parent references. What the event still needs is the registration's OWN
-- identity: that is what the edge upserts against (so a re-delivered or
-- re-homed registration resolves to the same local row) and what
-- `sync_change_events.entity_id` is addressed by.
--
-- What this migration deliberately does NOT touch
-- ------------------------------------------------
-- No status value changes: registrations stay `ENROLLED` / `DROPPED` /
-- `COMPLETED` under the existing CHECK constraint. The UNIQUE pair
-- `(student_id, course_offering_id)` stays exactly as migration 001 defined it:
-- one registration per student per offering, enforced by the database on both
-- sides. Authentication material is irrelevant here - a registration row holds
-- no credential, and the emitter selects only the identity, the two parent
-- references and the status.
--
-- Existing rows
-- -------------
-- NOT NULL DEFAULT gen_random_uuid() gives every pre-existing registration a
-- UUID in place, with no backfill UPDATE over a table attendance eligibility
-- reads. The cloud's copy of those rows still needs to be PUBLISHED into the
-- feed once; that is `scripts/backfillMasterDataFeed.ts`, which is a script,
-- is guarded against production, and is not part of this migration.

ALTER TABLE course_registrations
  ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Unique so the edge can find its row by cloud identity without relying on
-- either database's integer sequence, and so two cloud registrations can never
-- resolve to one local row.
CREATE UNIQUE INDEX idx_course_registrations_sync_id
  ON course_registrations (sync_id);
