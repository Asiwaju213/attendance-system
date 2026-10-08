-- 019_student_sync_identity.sql
--
-- Student cloud -> edge synchronization needs a stable cross-database identity,
-- exactly as migration 013 gave the master data and 012 gave attendance
-- sessions. The cloud's BIGSERIAL `students.id` and the edge's BIGSERIAL
-- `students.id` are independent sequences, so cloud student 42 and edge student
-- 42 are unrelated rows; `sync_id` is the only identifier that means the same
-- thing in both databases.
--
-- Where the identity lives
-- ------------------------
-- On `students`, not on `users`. Two reasons:
--
--   1. It keeps the change as small as possible. `students` already holds the
--      fields the edge needs to replica (matric number, department, level) and
--      already points at `users` for the display name and the account status,
--      so one UUID on that table is enough to address the whole pair.
--
--   2. It follows the boundary migration 013 drew. The edge's `users` table is
--      its own authentication store for local admins and locally-enrolled
--      students; putting the cloud's identity there would mix cloud-owned
--      records into the login store. Migration 013 solved the same problem for
--      lecturers by projecting them instead, and students are mirrored (this
--      task requires the real `users`/`students` rows the attendance queries
--      join) but identified only through `students.sync_id`.
--
-- What this migration deliberately does NOT touch
-- ------------------------------------------------
-- `users.password_hash`, `users.username`, `students.webauthn_user_handle` and
-- every `student_devices` column stay local. None of them is ever selected by
-- the student emitter, so no migration or payload can publish them: the edge
-- creates its synchronized students with `password_hash = NULL` (migration 005
-- made that legal precisely so an unclaimed account holds no credential) and
-- with a locally generated `webauthn_user_handle` from the column default.
--
-- Existing rows
-- -------------
-- NOT NULL DEFAULT gen_random_uuid() gives every pre-existing student - the
-- ones imported before this feature - a UUID in place, with no backfill UPDATE
-- over a table that attendance history references. The cloud's copy of those
-- students still needs to be PUBLISHED into the feed once; that is
-- `scripts/backfillMasterDataFeed.ts`, which is a script, is guarded against
-- production, and is not part of this migration.

ALTER TABLE students
  ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Unique so the edge can find its row by cloud identity without relying on
-- either database's integer sequence, and so two cloud students can never
-- resolve to one local row.
CREATE UNIQUE INDEX idx_students_sync_id
  ON students (sync_id);
