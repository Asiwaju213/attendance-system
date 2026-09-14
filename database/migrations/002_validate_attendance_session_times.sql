-- 002_validate_attendance_session_times.sql
-- Migration 002: adds validation constraints to attendance_sessions.
--   * end_time must come after start_time
--   * late_threshold must not be negative (attendance becomes late at
--     start_time + late_threshold)

ALTER TABLE attendance_sessions
  ADD CONSTRAINT chk_attendance_sessions_end_after_start
  CHECK (end_time > start_time);

ALTER TABLE attendance_sessions
  ADD CONSTRAINT chk_attendance_sessions_late_threshold_nonnegative
  CHECK (late_threshold >= INTERVAL '0');