-- 014_cloud_k12_sync_outbound_queue.sql
--
-- Task 3: the local attendance-marking queue.
--
-- The edge records attendance while it may have no route to the cloud at all. The
-- mark is therefore written locally and queued durably in the SAME transaction,
-- and the upload to the cloud is a separate, retryable concern (Task 4). Nothing in
-- the marking path may consult the cloud or wait on it: an unreachable cloud must
-- not cost a student their attendance.
--
-- Why a durable table and not an in-memory buffer
-- ------------------------------------------------
-- The queue has to survive the thing that causes it to fill up. A PC on a K12 LAN
-- loses its uplink when the router reboots, when the building's link drops, or
-- when it is simply switched off overnight with marks still pending. Anything held
-- in process memory is lost exactly then, and the marks are attendance data -
-- important data that must not be silently discarded.
--
-- Identity on the wire
-- --------------------
-- QUEUE_ID is generated on the edge and is the delivery identity: Task 4 sends it
-- to the cloud as an idempotency key, so a retried upload after a lost response is
-- absorbed by the cloud rather than double-counted. It is not a cloud row id.
--
-- SESSION_SYNC_ID is the cloud's `attendance_sessions.sync_id` UUID, because the
-- cloud's BIGSERIAL session id is meaningless on the edge. MATRIC_NUMBER is carried
-- as well as the local STUDENT_ID because students are deliberately NOT
-- synchronized (migration 013): the edge's student rows are its own, so the only
-- thing both databases agree on is the matriculation number, which is UNIQUE.
-- Nothing here is an authentication credential.
--
-- One row per local attendance record
-- ----------------------------------
-- UNIQUE (ATTENDANCE_RECORD_ID) makes the queue idempotent with respect to the
-- local record: enqueueing the same mark twice is not a second upload, and a later
-- correction re-states the SAME row rather than queueing a second, conflicting
-- claim. Cloud remains authoritative for the canonical attendance record, so a
-- correction is expressed by re-queuing the row with its new status, not by
-- creating a second one.
--
-- REJECTED is a terminal state rather than a retryable one: it means the cloud
-- refused the mark for a reason that retrying cannot fix (unknown session,
-- unresolvable student). Leaving such a row PENDING forever would hide a real
-- configuration problem behind an ever-growing queue, so it is parked where Task 6
-- can surface it.

CREATE TABLE sync_outbound_attendance_marks (
  -- The edge-generated delivery identity, sent to the cloud as an idempotency key.
  queue_id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The local record this upload describes. RESTRICT, not CASCADE: deleting an
  -- attendance record must not silently delete the evidence that it was pending.
  attendance_record_id BIGINT      NOT NULL UNIQUE
                                   REFERENCES attendance_records(id) ON DELETE RESTRICT,

  -- The cloud's identity for the session, resolved from the local session's
  -- sync_id rather than from its local integer id.
  session_sync_id      UUID        NOT NULL,

  -- Local identity plus the one key both databases agree on. Students are not
  -- synchronized, so this is how the cloud resolves which student the mark is for.
  student_id           BIGINT      NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  matric_number        TEXT        NOT NULL,

  -- PRESENT / LATE, mirroring the attendance_records CHECK constraint.
  mark_status          TEXT        NOT NULL CHECK (mark_status IN ('PRESENT', 'LATE')),

status               TEXT        NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING', 'SENT', 'REJECTED')),

  -- MARK_TIME is when the attendance was recorded, taken from
  -- attendance_records.marked_at. It is deliberately NOT queued_at: queued_at only
  -- says when this edge got round to telling the cloud, and for a corrected mark the
  -- two are very different. Sending queued_at as the mark time would make every
  -- correction rewrite the original marking timestamp on the cloud.
  mark_time            TIMESTAMPTZ NOT NULL,

  -- Ordering key for the drain, and the tiebreaker that makes the upload order for a
  -- session reproducible when two marks were queued in the same millisecond.
  queued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts             INTEGER     NOT NULL DEFAULT 0,
  last_attempt_at      TIMESTAMPTZ,
  last_error           TEXT,
  sent_at              TIMESTAMPTZ,
  -- Set when the cloud accepts the mark, so a later operator question ("did the
  -- cloud get this?") is answerable without reading the cloud.
  cloud_record_id      BIGINT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER sync_outbound_attendance_marks_set_updated_at
BEFORE UPDATE ON sync_outbound_attendance_marks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The drain in Task 4 reads PENDING rows in queue order, and nothing else ever
-- scans this table, so the partial index is on exactly that access path.
CREATE INDEX idx_sync_outbound_attendance_marks_pending
  ON sync_outbound_attendance_marks (queued_at, queue_id)
  WHERE status = 'PENDING';

-- Task 6's health surface counts by status and reports the oldest pending mark.
CREATE INDEX idx_sync_outbound_attendance_marks_status
  ON sync_outbound_attendance_marks (status);