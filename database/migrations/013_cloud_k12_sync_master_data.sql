-- 013_cloud_k12_sync_master_data.sql
--
-- Task 2: cloud -> local master-data synchronization.
--
-- Task 1 made attendance sessions synchronize, but wrote them to the dedicated
-- `sync_attendance_sessions` projection because `attendance_sessions` has foreign
-- keys to tables that did not exist locally. This migration lands the reference
-- data those foreign keys need, so the edge can resolve them.
--
-- Identity boundary (agreed scope for Task 2)
-- ------------------------------------------
-- Reference data that the edge has no reason to author is mirrored into the REAL
-- local tables, so local queries, joins and foreign keys work normally:
--
--   faculties, departments, levels, courses, academic_sessions, semesters,
--   course_offerings, locations, attendance_networks
--
-- Identity is deliberately NOT mirrored. `lecturers.user_id` points at `users`,
-- and the edge's `users` table doubles as its own authentication store for local
-- admins and locally-enrolled students. Writing cloud identity into that table
-- would put cloud-owned identity records into the edge's login store and risk
-- collisions on `username`.
--
-- So lecturers are mirrored into a `sync_lecturers` projection that carries a
-- denormalized display name. Nothing in this migration copies `users`, and
-- `password_hash`, `username` and `students.webauthn_user_handle` are never
-- synchronized. Deciding how an edge-authenticated lecturer maps to a cloud
-- identity is Task 6's job, not this task's.

-- ---------------------------------------------------------------------------
-- Stable cross-database identity
-- ---------------------------------------------------------------------------
-- Every mirrored table gets the same UUID identity that `attendance_sessions`
-- already has. Cloud and local BIGSERIAL sequences are independent, so cloud id
-- 42 and local id 42 are unrelated rows; `sync_id` is what events reference and
-- what the edge upserts against.
--
-- `levels` and `semesters` are static lookup tables (levels.name is a smallint
-- restricted to 100..500, semesters.name to two literals). They still need a
-- UUID so a level or semester can be referenced by a synchronized entity.

ALTER TABLE faculties          ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE departments        ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE levels             ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE courses            ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE academic_sessions  ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE semesters          ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE course_offerings   ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE locations          ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE attendance_networks ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE lecturers          ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Unique so the edge can find its row by cloud identity without relying on
-- either database's integer sequence.
CREATE UNIQUE INDEX idx_faculties_sync_id           ON faculties (sync_id);
CREATE UNIQUE INDEX idx_departments_sync_id         ON departments (sync_id);
CREATE UNIQUE INDEX idx_levels_sync_id              ON levels (sync_id);
CREATE UNIQUE INDEX idx_courses_sync_id             ON courses (sync_id);
CREATE UNIQUE INDEX idx_academic_sessions_sync_id   ON academic_sessions (sync_id);
CREATE UNIQUE INDEX idx_semesters_sync_id           ON semesters (sync_id);
CREATE UNIQUE INDEX idx_course_offerings_sync_id    ON course_offerings (sync_id);
CREATE UNIQUE INDEX idx_locations_sync_id           ON locations (sync_id);
CREATE UNIQUE INDEX idx_attendance_networks_sync_id ON attendance_networks (sync_id);
CREATE UNIQUE INDEX idx_lecturers_sync_id           ON lecturers (sync_id);

-- ---------------------------------------------------------------------------
-- Lecturer projection (identity is not mirrored - see the note above)
-- ---------------------------------------------------------------------------
-- No foreign keys on purpose. `cloud_department_sync_id` points at the cloud's
-- department, which the edge stores under the same UUID in its own
-- `departments` table, but the edge must not be made to fail a lecturer event
-- because a department has not been mirrored yet.
CREATE TABLE sync_lecturers (
  cloud_sync_id            UUID        PRIMARY KEY,
  cloud_lecturer_id        BIGINT      NOT NULL,
  staff_id                 TEXT        NOT NULL,
  -- Denormalized from `users.name` so a synchronized attendance session can be
  -- displayed without the edge ever holding a row in `users`.
  display_name             TEXT        NOT NULL,
  cloud_user_id            BIGINT      NOT NULL,
  cloud_department_sync_id UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_sync_lecturers_cloud_id
  ON sync_lecturers (cloud_lecturer_id);

-- ---------------------------------------------------------------------------
-- Lecturer display data on the session projection
-- ---------------------------------------------------------------------------
-- Task 1's payload carried only `cloudLecturerId`, so the edge could show a
-- session but not who owns it. Carrying the name on the session itself means the
-- local "sessions running now" screen needs no join into a table the edge does
-- not have yet.
ALTER TABLE sync_attendance_sessions
  ADD COLUMN lecturer_display_name TEXT,
  ADD COLUMN lecturer_staff_id     TEXT;

-- ---------------------------------------------------------------------------
-- Indexes that make the local read paths usable
-- ---------------------------------------------------------------------------
-- The edge lists active sessions by window and filters closed course offerings
-- out of lecturer-facing pickers, which is why status is indexed per table.
CREATE INDEX idx_sync_lecturers_department ON sync_lecturers (cloud_department_sync_id);

-- Foreign-key lookups the edge performs when resolving a synchronized parent.
-- `courses` is filtered by status in admin listings; `course_offerings` is
-- joined on course and academic session when building a lecturer's schedule.
CREATE INDEX idx_courses_status            ON courses (status);
CREATE INDEX idx_course_offerings_course   ON course_offerings (course_id);
CREATE INDEX idx_course_offerings_session  ON course_offerings (academic_session_id);
CREATE INDEX idx_course_offerings_semester ON course_offerings (semester_id);
CREATE INDEX idx_departments_faculty       ON departments (faculty_id);
CREATE INDEX idx_courses_department        ON courses (department_id);
CREATE INDEX idx_courses_faculty           ON courses (faculty_id);
CREATE INDEX idx_courses_level             ON courses (level_id);
CREATE INDEX idx_lecturers_department      ON lecturers (department_id);
CREATE INDEX idx_lecturers_user            ON lecturers (user_id);