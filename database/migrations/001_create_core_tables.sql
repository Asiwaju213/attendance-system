-- 001_create_core_tables.sql
-- Initial schema for the OOU Attendance System.
-- Migration 001: creates the 17 core tables, constraints, indexes, and seeds reference data.
-- Applied by the project's migration runner, which wraps each file in a transaction.

-- ---------------------------------------------------------------------------
-- Helper: automatically refresh updated_at on row updates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            BIGSERIAL   PRIMARY KEY,
  name          TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('STUDENT', 'LECTURER', 'ADMIN')),
  status        TEXT        NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- DEPARTMENTS
-- ---------------------------------------------------------------------------
CREATE TABLE departments (
  id         BIGSERIAL   PRIMARY KEY,
  name       TEXT        NOT NULL,
  code       TEXT        NOT NULL UNIQUE,
  status     TEXT        NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER departments_set_updated_at
BEFORE UPDATE ON departments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- LEVELS
-- ---------------------------------------------------------------------------
CREATE TABLE levels (
  id         BIGSERIAL   PRIMARY KEY,
  name       SMALLINT    NOT NULL UNIQUE CHECK (name IN (100, 200, 300, 400, 500)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO levels (name) VALUES (100), (200), (300), (400), (500);

-- ---------------------------------------------------------------------------
-- ACADEMIC_SESSIONS
-- ---------------------------------------------------------------------------
CREATE TABLE academic_sessions (
  id         BIGSERIAL   PRIMARY KEY,
  name       TEXT        NOT NULL UNIQUE,
  is_active  BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- SEMESTERS
-- ---------------------------------------------------------------------------
CREATE TABLE semesters (
  id         BIGSERIAL   PRIMARY KEY,
  name       TEXT        NOT NULL UNIQUE
                         CHECK (name IN ('First Semester', 'Second Semester')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO semesters (name) VALUES ('First Semester'), ('Second Semester');

-- ---------------------------------------------------------------------------
-- STUDENTS
-- ---------------------------------------------------------------------------
CREATE TABLE students (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      NOT NULL UNIQUE REFERENCES users(id)    ON DELETE RESTRICT,
  matric_number TEXT        NOT NULL UNIQUE,
  department_id BIGINT      NOT NULL REFERENCES departments(id)     ON DELETE RESTRICT,
  level_id      BIGINT      NOT NULL REFERENCES levels(id)          ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER students_set_updated_at
BEFORE UPDATE ON students
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- LECTURERS
-- ---------------------------------------------------------------------------
CREATE TABLE lecturers (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      NOT NULL UNIQUE REFERENCES users(id)    ON DELETE RESTRICT,
  staff_id      TEXT        NOT NULL UNIQUE,
  department_id BIGINT      NOT NULL REFERENCES departments(id)     ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER lecturers_set_updated_at
BEFORE UPDATE ON lecturers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- COURSES
-- ---------------------------------------------------------------------------
CREATE TABLE courses (
  id            BIGSERIAL   PRIMARY KEY,
  course_code   TEXT        NOT NULL UNIQUE,
  title         TEXT        NOT NULL,
  department_id BIGINT      NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  level_id      BIGINT      NOT NULL REFERENCES levels(id)      ON DELETE RESTRICT,
  status        TEXT        NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER courses_set_updated_at
BEFORE UPDATE ON courses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- COURSE_OFFERINGS
-- A course is offered once per academic session and semester.
-- One offering may have many lecturers (course_offering_lecturers).
-- ---------------------------------------------------------------------------
CREATE TABLE course_offerings (
  id                  BIGSERIAL   PRIMARY KEY,
  course_id           BIGINT      NOT NULL REFERENCES courses(id)          ON DELETE RESTRICT,
  academic_session_id BIGINT      NOT NULL REFERENCES academic_sessions(id) ON DELETE RESTRICT,
  semester_id         BIGINT      NOT NULL REFERENCES semesters(id)         ON DELETE RESTRICT,
  status              TEXT        NOT NULL DEFAULT 'OPEN'
                                  CHECK (status IN ('OPEN', 'CLOSED')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, academic_session_id, semester_id)
);

CREATE TRIGGER course_offerings_set_updated_at
BEFORE UPDATE ON course_offerings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- COURSE_OFFERING_LECTURERS
-- Many-to-many: one offering can have several lecturers; a lecturer can
-- teach several offerings. Duplicate assignments are prevented.
-- ---------------------------------------------------------------------------
CREATE TABLE course_offering_lecturers (
  id                 BIGSERIAL   PRIMARY KEY,
  course_offering_id BIGINT      NOT NULL REFERENCES course_offerings(id) ON DELETE RESTRICT,
  lecturer_id        BIGINT      NOT NULL REFERENCES lecturers(id)        ON DELETE RESTRICT,
  assigned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_offering_id, lecturer_id)
);

-- ---------------------------------------------------------------------------
-- COURSE_REGISTRATIONS
-- One student may register for an offering once (UNIQUE pair).
-- Unregistering is an application-level rule; the table is structured normally.
-- ---------------------------------------------------------------------------
CREATE TABLE course_registrations (
  id                 BIGSERIAL   PRIMARY KEY,
  student_id         BIGINT      NOT NULL REFERENCES students(id)         ON DELETE RESTRICT,
  course_offering_id BIGINT      NOT NULL REFERENCES course_offerings(id) ON DELETE RESTRICT,
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT        NOT NULL DEFAULT 'ENROLLED'
                                 CHECK (status IN ('ENROLLED', 'DROPPED', 'COMPLETED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, course_offering_id)
);

CREATE TRIGGER course_registrations_set_updated_at
BEFORE UPDATE ON course_registrations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ATTENDANCE_NETWORKS
-- Networks are movable and are intentionally NOT linked to a location or
-- course. A session records which network was used at the time.
-- ---------------------------------------------------------------------------
CREATE TABLE attendance_networks (
  id           BIGSERIAL   PRIMARY KEY,
  network_code TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER attendance_networks_set_updated_at
BEFORE UPDATE ON attendance_networks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- LOCATIONS
-- Locations record where a session happened; they are NOT permanently tied
-- to a course or network.
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id          BIGSERIAL   PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT,
  status      TEXT        NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER locations_set_updated_at
BEFORE UPDATE ON locations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ATTENDANCE_SESSIONS
-- A lecturer may have at most one ACTIVE session at a time (enforced below).
-- end_time is the lecturer-chosen scheduled end; ended_at records the actual
-- end once the session is closed. Attendance statuses are PRESENT / LATE.
-- ---------------------------------------------------------------------------
CREATE TABLE attendance_sessions (
  id                     BIGSERIAL   PRIMARY KEY,
  course_offering_id     BIGINT      NOT NULL REFERENCES course_offerings(id)  ON DELETE RESTRICT,
  started_by_lecturer_id BIGINT      NOT NULL REFERENCES lecturers(id)         ON DELETE RESTRICT,
  attendance_network_id  BIGINT      NOT NULL REFERENCES attendance_networks(id) ON DELETE RESTRICT,
  location_id            BIGINT      NOT NULL REFERENCES locations(id)         ON DELETE RESTRICT,
  start_time             TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_time               TIMESTAMPTZ NOT NULL,
  late_threshold         INTERVAL    NOT NULL DEFAULT INTERVAL '0',
  status                 TEXT        NOT NULL DEFAULT 'ACTIVE'
                                    CHECK (status IN ('ACTIVE', 'ENDED')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ
);

CREATE UNIQUE INDEX one_active_session_per_lecturer
  ON attendance_sessions (started_by_lecturer_id)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- ATTENDANCE_RECORDS
-- A row exists only for students who marked attendance (PRESENT or LATE).
-- Absence is inferred when a registered student has no row for a session.
-- Attendance percentages are calculated, never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE attendance_records (
  id         BIGSERIAL   PRIMARY KEY,
  session_id BIGINT      NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  student_id BIGINT      NOT NULL REFERENCES students(id)            ON DELETE RESTRICT,
  status     TEXT        NOT NULL CHECK (status IN ('PRESENT', 'LATE')),
  marked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, student_id)
);

-- ---------------------------------------------------------------------------
-- STUDENT_DEVICES
-- Stores a secure cryptographic credential (mechanism added later). No IP,
-- MAC, user-agent, or fingerprint is used as the device identity. Replaced
-- devices are revoked, not deleted, preserving audit history.
-- ---------------------------------------------------------------------------
CREATE TABLE student_devices (
  id                BIGSERIAL   PRIMARY KEY,
  student_id        BIGINT      NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  device_credential TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'ACTIVE'
                                  CHECK (status IN ('ACTIVE', 'REVOKED')),
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ
);

-- Enforce at most one ACTIVE device per student.
CREATE UNIQUE INDEX one_active_device_per_student
  ON student_devices (student_id)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- AUDIT_LOGS
-- Records important events (creation/deactivation, session start/end,
-- device resets/revocations, etc.). user_id is kept NULLable so a log
-- survives even if the acting user record is ever removed.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   BIGINT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes for foreign keys and common lookups
-- ---------------------------------------------------------------------------
CREATE INDEX idx_students_department_id        ON students (department_id);
CREATE INDEX idx_students_level_id             ON students (level_id);

CREATE INDEX idx_lecturers_department_id       ON lecturers (department_id);

CREATE INDEX idx_courses_department_id         ON courses (department_id);
CREATE INDEX idx_courses_level_id              ON courses (level_id);

CREATE INDEX idx_course_offerings_course_id    ON course_offerings (course_id);
CREATE INDEX idx_course_offerings_session_id   ON course_offerings (academic_session_id);
CREATE INDEX idx_course_offerings_semester_id  ON course_offerings (semester_id);

CREATE INDEX idx_col_lecturer_id               ON course_offering_lecturers (lecturer_id);

CREATE INDEX idx_course_regs_student_id        ON course_registrations (student_id);
CREATE INDEX idx_course_regs_offering_id       ON course_registrations (course_offering_id);
CREATE INDEX idx_course_regs_status            ON course_registrations (status);

CREATE INDEX idx_sessions_course_offering_id   ON attendance_sessions (course_offering_id);
CREATE INDEX idx_sessions_network_id           ON attendance_sessions (attendance_network_id);
CREATE INDEX idx_sessions_location_id          ON attendance_sessions (location_id);
CREATE INDEX idx_sessions_start_time           ON attendance_sessions (start_time);

CREATE INDEX idx_records_student_id            ON attendance_records (student_id);
CREATE INDEX idx_records_status                ON attendance_records (status);

CREATE INDEX idx_devices_student_id            ON student_devices (student_id);
CREATE INDEX idx_devices_status                ON student_devices (status);

CREATE INDEX idx_audit_logs_user_id            ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_entity             ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at         ON audit_logs (created_at);