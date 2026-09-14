-- 004_faculties_and_course_ownership.sql
-- Migration 004: faculty-wide and department-specific courses.
--   * adds a `faculties` table
--   * links every department to exactly one faculty (`departments.faculty_id`)
--   * lets a course be owned by a faculty (faculty-wide) OR by a department
--     (department-specific), enforced by a CHECK constraint (exactly one owner;
--     `level_id` remains required)
--   * keeps `courses.course_code` globally unique across both scope types
--   * all new foreign keys are RESTRICT (no cascading deletes) so historical
--     course/offering/registration/attendance records are never destroyed

----------------------------------------------------------------------------
-- faculties
----------------------------------------------------------------------------
CREATE TABLE faculties (
  id         BIGSERIAL   PRIMARY KEY,
  name       TEXT        NOT NULL,
  code       TEXT        NOT NULL UNIQUE,
  status     TEXT        NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER faculties_set_updated_at
BEFORE UPDATE ON faculties
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

----------------------------------------------------------------------------
-- departments -> faculties (a department belongs to exactly one faculty)
----------------------------------------------------------------------------
-- Departments already exist is some environments, so the column is added
-- NULLable, every pre-existing department is assigned to a bootstrap faculty
-- (no data loss), and the column is then made NOT NULL.
ALTER TABLE departments
  ADD COLUMN faculty_id BIGINT REFERENCES faculties(id) ON DELETE RESTRICT;

-- A bootstrap faculty absorbs any pre-existing departments that do not yet
-- have a faculty assigned. Real deployments should reassign these departments
-- to their actual faculty and retire/disable this placeholder.
INSERT INTO faculties (name, code)
VALUES ('Unassigned Faculty', 'UNASSIGNED')
ON CONFLICT (code) DO NOTHING;

UPDATE departments
SET faculty_id = (SELECT id FROM faculties WHERE code = 'UNASSIGNED')
WHERE faculty_id IS NULL;

ALTER TABLE departments
  ALTER COLUMN faculty_id SET NOT NULL;

CREATE INDEX idx_departments_faculty_id ON departments (faculty_id);

----------------------------------------------------------------------------
-- courses: faculty-wide OR department-specific
----------------------------------------------------------------------------
-- Course scope is expressed by the nullable ownership columns plus a CHECK
-- constraint (no redundant course_type column):
--   * faculty-wide        -> faculty_id set,     department_id NULL
--   * department-specific -> department_id set,  faculty_id NULL
-- Existing courses all have department_id set (the old NOT NULL contract);
-- their faculty_id is NULL, which the CHECK constraint accepts, so historical
-- data stays valid. `level_id` remains NOT NULL and `course_code` stays
-- globally UNIQUE.
ALTER TABLE courses
  ADD COLUMN faculty_id BIGINT REFERENCES faculties(id) ON DELETE RESTRICT;

ALTER TABLE courses
  ALTER COLUMN department_id DROP NOT NULL;

ALTER TABLE courses
  ADD CONSTRAINT chk_courses_single_owner
  CHECK (
    (faculty_id IS NOT NULL AND department_id IS NULL) OR
    (department_id IS NOT NULL AND faculty_id IS NULL)
  );

----------------------------------------------------------------------------
-- Indexes for the new lookup patterns
----------------------------------------------------------------------------
-- Existing single-column indexes (idx_courses_department_id,
-- idx_courses_level_id) stay. Composite indexes cover the two common scopes.
CREATE INDEX idx_courses_faculty_id       ON courses (faculty_id);
CREATE INDEX idx_courses_department_level ON courses (department_id, level_id);
CREATE INDEX idx_courses_faculty_level    ON courses (faculty_id, level_id);