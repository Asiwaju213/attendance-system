-- Drop the standalone attendance-network and location tables.
--
-- Migration 017 already removed the only columns that referenced them
-- (attendance_sessions.attendance_network_id / attendance_sessions.location_id),
-- which leaves both tables holding nothing that any code reads or writes. The
-- admin CRUD that managed them existed only to populate those session columns,
-- and the student-facing pinning they were built for is gone: a student signs in
-- on any device in the school with WebAuthn, with no network or room to be
-- matched against. Keeping empty tables would be schema without a feature.
--
-- This is deliberately a follow-up migration rather than an edit to 017, because
-- 017 has already been applied to some databases; rewriting an applied migration
-- would leave those databases and the files permanently disagreeing.
--
-- Historical rows in sync_change_events with entity_type 'attendance_network' or
-- 'location' are left untouched: the feed is append-only and entity_type has no
-- check constraint. The edge retires them as it drains them past its cursor.

DROP TRIGGER IF EXISTS attendance_networks_set_updated_at ON attendance_networks;
DROP TRIGGER IF EXISTS locations_set_updated_at ON locations;

DROP TABLE IF EXISTS attendance_networks;
DROP TABLE IF EXISTS locations;
