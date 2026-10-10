-- 025_sync_outbound_claim.sql
--
-- Task 5: the outbound uploader claims its work instead of a plain read.
--
-- Task 4's drain reads PENDING rows and sends them. That is fine for one worker,
-- but it gives the uploader no way to express "these rows are being sent RIGHT
-- NOW". Two consequences were unacceptable once uploads could fail at any point:
--
--   * two overlapping drains (a slow HTTP request overlapping the next tick, an
--     operator script running while the worker uploads) could both select the
--     same PENDING rows and both send them. The cloud's receipt table absorbs the
--     duplicate today, but the send itself is wasted work and the duplicate only
--     becomes visible on the cloud.
--
--   * a drain that dies mid-request leaves its rows PENDING forever, silently
--     retried on every tick - never lost, but impossible to distinguish from a
--     queue the edge has forgotten.
--
-- The claim fixes both by adding a transitory IN_FLIGHT state with a lease:
--
--   * the uploader marks its batch IN_FLIGHT (claimed_by the worker id, at
--     claimed_at now()) before it sends anything;
--
--   * any other claimer skips locked rows, so no row is ever sent twice
--     concurrently (FOR UPDATE SKIP LOCKED);
--
--   * a claim older than the lease timeout is reclaimed by the NEXT drain, so a
--     dead worker's batch returns to the queue in its original position instead
--     of being uploaded by the same stalled process forever.
--
-- The lease is a claim on SHARED rows, so nothing here anchors to a cloud
-- identity: QUEUE_ID, SESSION_SYNC_ID and MATRIC_NUMBER stay exactly as they were
-- in migration 014. REJECTED and SENT remain terminal; IN_FLIGHT is the only
-- state that can expire back into PENDING, because it is the only state that
-- means "work in progress rather than a verdict".

ALTER TABLE sync_outbound_attendance_marks
  DROP CONSTRAINT sync_outbound_attendance_marks_status_check;

ALTER TABLE sync_outbound_attendance_marks
  ADD CONSTRAINT sync_outbound_attendance_marks_status_check
  CHECK (status IN ('PENDING', 'IN_FLIGHT', 'SENT', 'REJECTED'));

-- When the claim was taken, and by which worker. CLAIMED_BY is the consumer id
-- (SYNC_EDGE_ID) for diagnosability only: it is never sent anywhere and is not an
-- authentication credential.
ALTER TABLE sync_outbound_attendance_marks
  ADD COLUMN claimed_at TIMESTAMPTZ;

ALTER TABLE sync_outbound_attendance_marks
  ADD COLUMN claimed_by  TEXT;

-- The reclaim path is the ONLY thing that reads IN_FLIGHT rows, and it always
-- scans by age, so the partial index is on exactly (claimed_at) for the rows a
-- drain will reclaim. Rows whose lease has not expired are not matched.
CREATE INDEX idx_sync_outbound_attendance_marks_inflight
  ON sync_outbound_attendance_marks (claimed_at)
  WHERE status = 'IN_FLIGHT';