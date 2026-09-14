# Database — OOU Attendance System

This directory holds the PostgreSQL schema for the OOU Attendance System. Migrations are plain numbered SQL files; the schema evolves safely by adding new numbered files.

## What the initial migration contains

`migrations/001_create_core_tables.sql` creates these 17 tables:

1. `users` — staff/student/admin accounts (roles: `STUDENT`, `LECTURER`, `ADMIN`). Passwords are stored only as `password_hash`, never plaintext.
2. `students` — links a user to a matric number, department, and level.
3. `lecturers` — links a user to a staff ID and department.
4. `departments` — departments (e.g. Computer Science).
5. `levels` — levels 100, 200, 300, 400, 500 (seeded).
6. `academic_sessions` — e.g. `2026/2027`, with `is_active` flag.
7. `semesters` — `First Semester` / `Second Semester` (seeded).
8. `courses` — course code (unique system-wide), title, owning department and level.
9. `course_offerings` — a course offered in a specific session + semester. One offering can have several lecturers.
10. `course_offering_lecturers` — many-to-many link between offerings and lecturers (no duplicate assignment).
11. `course_registrations` — a student registered for an offering (`UNIQUE(student_id, course_offering_id)`).
12. `attendance_networks` — movable networks (e.g. `NET-001`), never glued to a location/course.
13. `locations` — where a session happened, for reporting only.
14. `attendance_sessions` — a session started by a lecturer for an offering, with chosen end time and late threshold. One `ACTIVE` session per lecturer is enforced.
15. `attendance_records` — only `PRESENT` / `LATE` rows; absence is inferred from missing rows.
16. `student_devices` — secure device credentials; at most one `ACTIVE` device per student; revoked devices are kept.
17. `audit_logs` — important events (creation/deactivation, session start/end, device revocations, etc.).

It also creates a small `set_updated_at()` trigger, useful indexes on foreign keys, and reference seed data (levels and semesters).

Later migrations build on this foundation:
- `003_add_authentication.sql` adds `users.username` (admin logins) and the `sessions` table.
- `004_faculties_and_course_ownership.sql` adds the `faculties` table and supports faculty-wide + department-specific courses (see below).

## Migration 004: faculties and course ownership

`migrations/004_faculties_and_course_ownership.sql` introduces faculty-wide and department-specific courses:

- `faculties` — `id`, `name`, `code` (unique), `status` (`ACTIVE`/`INACTIVE`), timestamps.
- `departments.faculty_id` — `NOT NULL` FK to `faculties(id)` (`ON DELETE RESTRICT`). A department belongs to exactly one faculty. Any pre-existing departments are backfilled onto a bootstrap **"Unassigned Faculty"** (code `UNASSIGNED`) so existing data is never lost; a deployment should later reassign those departments to their real faculty and deactivate/remove the placeholder.
- `courses` now supports two scopes, enforced by the `chk_courses_single_owner` CHECK constraint (no `course_type` column; the nullable ownership columns express scope directly):
  - faculty-wide: `faculty_id` set, `department_id` NULL
  - department-specific: `department_id` set, `faculty_id` NULL
  - a course can never have both set, and can never have neither set
  - `level_id` stays `NOT NULL`; `course_code` stays globally `UNIQUE` across both scopes
- All new foreign keys use restrictive deletes (`ON DELETE RESTRICT`), matching the existing academic tables, so historical course/offering/registration/attendance records are preserved.
- New indexes: `idx_departments_faculty_id`, `idx_courses_faculty_id`, `idx_courses_department_level`, `idx_courses_faculty_level`.

## How to apply the migrations

From the `backend/` directory (the runner uses the same `DATABASE_*` variables as the app):

```bash
cd backend
npm run migrate
```

The runner:
- connects to the database named in `backend/.env` (`DATABASE_NAME=oou_attendance`),
- tracks applied files in a `schema_migrations` table,
- applies each pending `.sql` file (in filename order) inside a single transaction, so a failed migration rolls back cleanly.

You can also apply a file manually with `psql`, wrapping everything in one transaction:

```bash
psql -U <user> -d oou_attendance -1 -f migrations/001_create_core_tables.sql
```

## How to verify the tables were created

List all tables:

```sql
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

Check that every migration ran:

```sql
SELECT filename, applied_at
FROM schema_migrations
ORDER BY filename;
```

Check foreign keys for a table:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'attendance_sessions'::regclass
  AND contype = 'f';
```

## How to write future migrations

- Every migration file lives in `migrations/`.
- Number them sequentially: `002_<short_description>.sql`, `003_<short_description>.sql`, ...
- One logical change per file. The runner sorts files by name and applies them in order.
- Each file should contain only DDL/DML statements (no explicit `BEGIN`/`COMMIT` — the runner wraps each file in a transaction).
- Once applied, a filename is recorded in `schema_migrations` and will not run again. Do not edit an applied file; create a new migration instead.