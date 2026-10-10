-- 024_sync_feed_publication_state.sql
--
-- Exactly-once marker for publishing the cloud's CURRENT master data.
--
-- Why this exists
-- ---------------
-- Migrations 013, 019, 020 and 021 gave pre-existing rows a `sync_id` UUID
-- generated in place with `gen_random_uuid()`. The cloud and the edge therefore
-- generated INDEPENDENT UUIDs for the same real row, and reconciliation depends
-- on the cloud publishing those rows into the feed exactly once, so the edge can
-- adopt the cloud identity by natural key (see `applyStudent` and
-- `applyCourseRegistration`).
--
-- Nothing currently guarantees that publication happens. `backfillMasterDataFeed.ts`
-- is a manual, production-guarded script an operator must remember to run, and a
-- skipped run leaves an edge cursor advancing past data it will never receive -
-- the silent "cursor fresh, data missing" failure. This migration stores the
-- "has the feed been seeded" flag so the provider can publish the current state
-- exactly once at startup, in the SAME transaction as the emissions, with no
-- separate bookkeeping table to keep consistent.
--
-- The row is a singleton: `id` is a boolean that must be true, so only one row
-- can exist and it is never ambiguous which row holds the state. The same
-- migration runs on both sides of the boundary, because both sides run this
-- application; the edge never reads this table.
--
-- SEEDED_AT is written by the seeder in the same transaction that emits the
-- events, so "seeded" can never be recorded before the events it stands for have
-- committed. LAST_RECONCILE_AT exists for a future "re-publish rows that were
-- added out of band (a restore, a data migration)" maintenance run; nothing
-- writes it today.

CREATE TABLE sync_feed_publication_state (
  id                BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
  seeded_at         TIMESTAMPTZ,
  last_reconcile_at TIMESTAMPTZ
);

-- The singleton row exists after the migration, seeded_at NULL meaning "never
-- seeded". ON CONFLICT keeps this idempotent if a partial migration replays.
INSERT INTO sync_feed_publication_state (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;