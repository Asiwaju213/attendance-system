-- ---------------------------------------------------------------------------
-- CLOUD -> LOCAL K12 EDGE SYNCHRONIZATION (change feed + edge consumer state)
-- ---------------------------------------------------------------------------
-- Application-level synchronization. The cloud database and the local K12 edge
-- database are two independent PostgreSQL databases. Nothing replicates between
-- them at the storage layer, and the edge never opens a connection to the cloud.
-- The edge asks the cloud's sync API for an ordered batch of changes, applies
-- them in one local transaction, and advances a local cursor.
--
-- The same migration is applied to both sides, because both sides run this
-- application. A side simply ignores the tables it does not use: the cloud only
-- writes SYNC_CHANGE_EVENTS, the edge only reads it over HTTP and writes the
-- consumer tables.
--
-- Ordering is by the monotonically increasing SYNC_CHANGE_EVENTS.CURSOR column,
-- never by a timestamp. Timestamps are wall-clock and can move backwards or
-- collide, so they are recorded for humans but never used to decide what an
-- edge has already seen. This is what replaces "SELECT ... WHERE updated_at > ?".
--
-- Sync IDs are UUIDs because the BIGSERIAL ids on the two databases are
-- independent sequences. A cloud id of 42 and a local id of 42 are unrelated
-- rows, so no cloud numeric id is ever treated as a local identity.

-- ---------------------------------------------------------------------------
-- ATTENDANCE_SESSIONS.SYNC_ID
-- A synchronization-safe identity for an attendance session.
--
-- The existing BIGSERIAL primary key cannot cross databases: it only identifies
-- a row within the database that issued it. SYNC_ID is generated on the cloud
-- and carried to the edge unchanged, which is what lets the edge upsert the
-- same session across repeated deliveries.
--
-- NOT NULL DEFAULT gen_random_uuid() is deliberate. Roughly two dozen test
-- fixtures and the E2E seeder insert attendance sessions directly without
-- naming this column, so a default (rather than a nullable column backfilled by
-- the application) keeps every existing writer correct without being touched.
-- ---------------------------------------------------------------------------
ALTER TABLE attendance_sessions
  ADD COLUMN sync_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX idx_attendance_sessions_sync_id
  ON attendance_sessions (sync_id);

-- ---------------------------------------------------------------------------
-- SYNC_CHANGE_EVENTS
-- The cloud's append-only change feed. This is the durable transfer log.
--
-- Durability: rows live in the same database as the business data they
-- describe, so restarting Render cannot lose an event. A row is written inside
-- the same transaction as the business change, so either both are visible or
-- neither is.
--
-- Append-only: CURSOR is a BIGSERIAL, which PostgreSQL assigns in row order under
-- the locking rules of a single inserting sequence. It is never updated and
-- never reused, so "give me everything after N" is stable forever and does not
-- require a full-table scan against a mutable column.
--
-- ENTITY_ID is the entity's SYNC_ID (a UUID, stored as text) rather than its
-- BIGSERIAL id, for the reason given above. There is deliberately NO foreign key
-- from this table to attendance_sessions: the feed must outlive the rows it
-- describes, and an FK would break the test fixtures and E2E seeder that delete
-- and insert attendance sessions directly. The payload carries the full state,
-- so an event remains replayable even if its entity row is gone.
--
-- OPERATION currently admits CREATED / UPDATED / CLOSED. UPDATED is present
-- because the event model is generic, but the application has no endpoint that
-- edits attendance-session fields, so nothing emits it yet; see
-- docs/cloud-k12-sync.md.
--
-- PAYLOAD holds only what the edge needs to reproduce the session. It
-- deliberately contains no student rows, no password hashes, no session data,
-- no WebAuthn credential material and no device credential ids.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_change_events (
  cursor        BIGSERIAL   PRIMARY KEY,
  event_id      UUID        NOT NULL UNIQUE,
  entity_type   TEXT        NOT NULL,
  entity_id     TEXT        NOT NULL,
  operation     TEXT        NOT NULL
                            CHECK (operation IN ('CREATED', 'UPDATED', 'CLOSED')),
  payload       JSONB       NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An edge reads a strictly increasing cursor range every poll, so this is the
-- index that keeps the feed read cheap as the log grows.
CREATE INDEX idx_sync_change_events_cursor
  ON sync_change_events (cursor);

-- Supports "what does the cloud currently know about this entity?" without
-- scanning the whole log.
CREATE INDEX idx_sync_change_events_entity
  ON sync_change_events (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- SYNC_CONSUMER_STATE
-- The local checkpoint: one row per edge, holding the cursor it has durably
-- applied through.
--
-- The cursor is updated in the SAME transaction that applies the events it
-- describes. That is the whole correctness argument for the design: there is no
-- window in which events are applied but the cursor does not reflect it, so a
-- crash can only ever cause events to be replayed (which idempotency absorbs),
-- never skipped.
--
-- CONSUMER_ID is the SYNC_EDGE_ID of the K12 PC. A single configured edge is
-- supported today; the column exists so adding more later is a provisioning
-- change rather than a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_consumer_state (
  consumer_id   TEXT        PRIMARY KEY,
  last_cursor   BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- SYNC_PROCESSED_EVENTS
-- The edge's durable record of which events it has already applied.
--
-- The feed is at-least-once: a request that succeeds but whose response is lost
-- in transit is re-requested, and a restart re-reads from the stored cursor.
-- Re-applying must therefore be harmless, and this table is what makes it so.
-- The primary key is the idempotency guarantee - a second attempt to apply the
-- same event violates it and is skipped rather than double-applied.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_processed_events (
  consumer_id   TEXT        NOT NULL,
  event_id      UUID        NOT NULL,
  cursor        BIGINT      NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, event_id)
);

-- ---------------------------------------------------------------------------
-- SYNC_ATTENDANCE_SESSIONS
-- The edge's local copy of a cloud attendance session.
--
-- This is a separate projection rather than a row in the local
-- attendance_sessions table, for a reason that is a dependency rather than a
-- preference: attendance_sessions has foreign keys to course_offerings,
-- lecturers, attendance_networks and locations, and none of those entities are
-- synchronized yet. Writing into the real table would fail on a missing parent
-- row until Task 2 lands, which would make this task unshippable on its own.
--
-- The cloud numeric ids are stored under explicitly cloud-prefixed column names
-- so it is never ambiguous that they are not local identities. They are retained
-- because the edge needs them to join to those entities once Task 2
-- synchronizes them.
--
-- COURSE_CODE / COURSE_TITLE are transitional denormalized labels, included so
-- a student on the K12 network can see which session is running. They become
-- redundant (and will be reconciled) when courses are synchronized properly.
--
-- SOURCE_EVENT_CURSOR records which feed position last wrote this row, which
-- makes "what state did the cloud put here" answerable without a full log replay.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_attendance_sessions (
  cloud_sync_id               UUID        PRIMARY KEY,
  cloud_session_id            BIGINT      NOT NULL,
  cloud_course_offering_id    BIGINT      NOT NULL,
  cloud_lecturer_id           BIGINT      NOT NULL,
  cloud_attendance_network_id BIGINT      NOT NULL,
  cloud_location_id           BIGINT      NOT NULL,
  course_code                 TEXT        NOT NULL,
  course_title                TEXT        NOT NULL,
  start_time                  TIMESTAMPTZ NOT NULL,
  end_time                    TIMESTAMPTZ NOT NULL,
  late_threshold_minutes      INTEGER     NOT NULL,
  status                      TEXT        NOT NULL
                                         CHECK (status IN ('ACTIVE', 'ENDED')),
  ended_at                    TIMESTAMPTZ,
  source_event_cursor         BIGINT      NOT NULL,
  last_synced_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The local student-facing question is "is a session running right now?", so the
-- edge reads this projection by status and window.
CREATE INDEX idx_sync_attendance_sessions_active_window
  ON sync_attendance_sessions (status, start_time, end_time);