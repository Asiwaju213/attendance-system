-- Reset the K12 edge's sync checkpoint so it replays the rebuilt feed from cursor 0.
--
-- WHY THIS IS A SEPARATE PROCEDURE
-- ---------------------------------
-- The cloud feed rebuild (scripts/rebuildCloudSyncFeed.ts) replaces the cloud's
-- sync_change_events with a clean, dependency-ordered log starting at cursor 1.
-- The edge must reset its cursor to 0 so it replays that feed from the beginning.
-- This script runs on the EDGE (local K12) database, never on the cloud.
--
-- WHAT IT TOUCHES
-- ---------------
-- Only two tables, only for the oou-k12-main consumer:
--   1. sync_processed_events  (idempotency receipts)
--   2. sync_consumer_state     (the cursor)
--
-- It does NOT touch:
--   - Any business tables (attendance_sessions, students, courses, etc.)
--   - sync_outbound_attendance_marks (outbound queue)
--   - Any local sync checkpoints for other consumers
--
-- SAFETY
-- ------
-- Run this ONLY after the cloud feed has been rebuilt. The edge will re-fetch
-- and re-apply every event from cursor 1, so the cloud feed must be complete
-- and correct before this runs.
--
-- Usage (on the edge database):
--   psql "$EDGE_DATABASE_URL" -f backend/scripts/resetEdgeCheckpoint.sql

BEGIN;

DELETE FROM sync_processed_events WHERE consumer_id = 'oou-k12-main';

UPDATE sync_consumer_state
   SET last_cursor = 0,
       updated_at = now()
 WHERE consumer_id = 'oou-k12-main';

COMMIT;
