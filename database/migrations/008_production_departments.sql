-- 008_production_departments.sql
-- Migration 008: production department reference data.
--   * ensures the production "Faculty of Engineering" (FENG) exists
--   * seeds the five standard production departments, each ACTIVE
--   * attaches every department to the faculty by code lookup (never by
--     hard-coded numeric id) so this works in any database/environment
--   * is fully idempotent: existing rows are never duplicated, overwritten,
--     or deleted, so running the migration more than once is safe
--
-- `departments.faculty_id` is NOT NULL, so every department is placed under
-- the real production faculty rather than the UNASSIGNED bootstrap faculty.

INSERT INTO faculties (name, code, status)
VALUES ('Faculty of Engineering', 'FENG', 'ACTIVE')
ON CONFLICT (code) DO NOTHING;

INSERT INTO departments (name, code, status, faculty_id)
SELECT v.name, v.code, 'ACTIVE', f.id
FROM (VALUES
  ('Computer Engineering',                 'CPE'),
  ('Mechanical Engineering',               'MEE'),
  ('Civil Engineering',                    'CIE'),
  ('Agricultural Engineering',             'AGE'),
  ('Electrical/Electronics Engineering',   'EEE')
) AS v(name, code)
JOIN faculties f ON f.code = 'FENG'
ON CONFLICT (code) DO NOTHING;