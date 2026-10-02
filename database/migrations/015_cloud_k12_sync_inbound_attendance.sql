-- 015_cloud_k12_sync_inbound_attendance.sql
--
-- Task 4: local -> cloud attendance marks.
--
-- The cloud is authoritative for the canonical attendance record. A mark recorded
-- on an edge arrives here and is written into the REAL `attendance_records` table,
-- not into a projection, because this is the canonical copy - there is no second
-- authoritative store to reconcile against.
--
-- Idempotency
-- -----------
-- The feed of changes (Task 1) is at-least-once, so an upload is too: the edge
-- cannot tell "the request succeeded" from "the response was lost", and must be
-- able to retry. The edge-generated QUEUE_ID is therefore recorded here on first
-- receipt, and that row is what makes a replay a no-op instead of a second
-- attendance mark.
--
-- This is deliberately a separate table from SYNC_PROCESSED_EVENTS rather than a
-- reuse of it. That table records "this edge applied this feed event at this
-- cursor" and is keyed by consumer; this one records "the cloud has accepted this
-- specific delivery". They have different owners, different lifetimes and
-- different failure modes, and conflating them would mean a cursor reset silently
-- discards delivery receipts.
--
-- FK semantics
-- ------------
-- CLOUD_RECORD_ID is ON DELETE RESTRICT. If an attendance record is ever removed,
-- the receipt must survive: it is the evidence that the edge already believes the
-- mark was accepted, so losing it would let a retry re-create the row.

CREATE TABLE sync_inbound_attendance_receipts (
  queue_id        UUID        PRIMARY KEY,
  cloud_record_id BIGINT      NOT NULL
                               REFERENCES attendance_records(id) ON DELETE RESTRICT,
  -- The edge's matriculation number, kept for operator diagnosis only. It is the
  -- key the mark was resolved by, so it is what makes "why was this rejected or
  -- resolved to that student?" answerable without a feed replay.
  matric_number   TEXT        NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lets an operator answer "which deliveries produced this attendance record?"
CREATE INDEX idx_sync_inbound_attendance_receipts_record
  ON sync_inbound_attendance_receipts (cloud_record_id);