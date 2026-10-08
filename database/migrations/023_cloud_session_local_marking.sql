-- 023_cloud_session_local_marking.sql
--
-- Task 4: let a locally logged-in student mark a CLOUD-created attendance session.
--
-- The cloud's attendance sessions are mirrored on the edge as the
-- `sync_attendance_sessions` projection. Until now the edge had no way to connect
-- one of those projections back to the local master data - the course offering,
-- course and registration that authorize a student to mark it - so a cloud session
-- could be seen but never marked locally.
--
-- 1) Link the projection to its local offering.
--    CLOUD_COURSE_OFFERING_SYNC_ID is the cloud's UUID for the offering
--    (`course_offerings.sync_id`), the only identity that means the same thing on
--    both databases. It is written only by the apply service from the feed; it is
--    never read from a client request, so a student cannot use it to bypass the
--    local eligibility checks. Old events that predate this column apply as NULL,
--    which simply leaves the session invisible locally until it is re-emitted.
ALTER TABLE sync_attendance_sessions
  ADD COLUMN cloud_course_offering_sync_id UUID;

-- The student-facing eligibility query joins the projection to the local
-- `course_offerings` by this column.
CREATE INDEX idx_sync_attendance_sessions_offering_sync
  ON sync_attendance_sessions (cloud_course_offering_sync_id);

-- 2) Allow PENDING queue rows that describe NO local attendance record.
--    A mark against a cloud-created session has no canonical `attendance_records`
--    row on the edge (it is the cloud that owns the canonical record), so the
--    queue row must be able to omit the record reference. The uploader never needs
--    it: the wire shape is (queue_id, session_sync_id, matric_number, status,
--    marked_at). Existing rows all reference a real record and are untouched.
ALTER TABLE sync_outbound_attendance_marks
  ALTER COLUMN attendance_record_id DROP NOT NULL;

-- 3) Exactly-once backstop for cloud-session marks.
--    The existing UNIQUE (attendance_record_id) cannot dedupe rows whose record
--    reference is NULL - NULLs are distinct in PostgreSQL. A student may mark a
--    cloud session once, and only once, no matter how fast the retries come: the
--    second INSERT conflicts on this partial unique index and is absorbed, so a
--    race yields one successful mark and one ALREADY_MARKED, never two.
CREATE UNIQUE INDEX one_cloud_mark_per_student_session
  ON sync_outbound_attendance_marks (student_id, session_sync_id)
  WHERE attendance_record_id IS NULL;