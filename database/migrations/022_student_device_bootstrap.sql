-- 022_student_device_bootstrap.sql
--
-- One-time bootstrap secret: how a browser on the K12 edge binds itself to a
-- device the CLOUD enrolled.
--
-- The problem it solves
-- ---------------------
-- Task 3 syncs device STATE (migration 021): the edge knows which opaque device
-- reference belongs to which student and whether it is ACTIVE. What it cannot
-- know is whether the browser asking for a binding cookie actually owns that
-- device - the WebAuthn credential lives in the cloud's `student_devices` row
-- and never crosses the boundary. Without a proof, any caller who knew a device
-- reference could claim it.
--
-- The proof is a one-time secret minted in the same transaction that commits
-- the enrollment on the cloud, handed to the student exactly once in the
-- enrollment response, and spent by the edge on its first bootstrap:
--
--   * The CLOUD stores only `secret_hash` (SHA-256 hex). The plaintext exists
--     in one HTTP response body and nowhere else - not in either database, not
--     in the feed, not in an audit log.
--   * The hash - never the plaintext - crosses the boundary as a
--     `student_device_bootstrap` change event.
--   * The edge spends it in a single atomic UPDATE that also re-checks the
--     student, the expiry and the device's ACTIVE state, then writes the
--     device-binding cookie. After that the secret is CONSUMED forever.
--
-- The secret authenticates nothing on its own: the edge still requires the
-- student's local password, and the binding cookie it unlocks is checked on
-- every subsequent login exactly as before.
--
-- What the edge stores: `sync_student_device_bootstraps`
-- -----------------------------------------------------
-- A projection like `sync_student_devices` (migration 021), holding exactly
-- what the consume decision needs and nothing else: the cloud identities, the
-- resolved local student, the SHA-256 hash, a status and an expiry. No
-- plaintext secret can be here, because none is ever transmitted. `student_id`
-- is a real foreign key resolved by the applier from `cloud_student_sync_id`,
-- and `cloud_device_ref` is unique so one device can hold at most one bootstrap
-- row however often the feed re-delivers it.
--
-- Status is one-way. PENDING -> CONSUMED happens only in the edge's consume
-- statement; the applier deliberately refuses to regress a CONSUMED row when a
-- re-delivered PENDING event arrives (the cloud only ever publishes PENDING,
-- and it never learns of consumption - sync is one-directional).
--
-- What this migration deliberately does NOT touch
-- ------------------------------------------------
-- No column of `student_devices`, no challenge/grant/session table, no sync
-- identity or projection from migration 021. Two new tables, two indexes and a
-- trigger; nothing is backfilled, because a bootstrap row only ever exists at
-- the moment of an enrollment, and no enrollment predates this migration.

-- ---------------------------------------------------------------------------
-- The cloud's one-time secrets
-- ---------------------------------------------------------------------------
-- `sync_id` is the identity the change event is addressed by, exactly like
-- every other synchronized entity. It has no integer `id`: nothing joins to
-- this table, and the two foreign keys below are the only references it needs.
--
-- The foreign keys cascade because this row is ephemeral credential material,
-- not history: when a device or a student is deleted, a secret that could only
-- ever have bound that device is meaningless - and unlike attendance records,
-- there is nothing here worth preserving against a deletion.
CREATE TABLE student_device_bootstraps (
  sync_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   BIGINT      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  device_id    BIGINT      NOT NULL REFERENCES student_devices(id) ON DELETE CASCADE,
  -- SHA-256 hex of the secret. The plaintext is returned once in the enrollment
  -- response and never stored, logged or synchronized.
  secret_hash  TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'CONSUMED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- At most one live secret per device row: a bootstrap is minted once, when the
-- enrollment commits, and re-running the ceremony creates a NEW device row (a
-- replacement is a new device reference, migration 021) rather than a second
-- secret for the old one.
CREATE UNIQUE INDEX one_pending_student_device_bootstrap
  ON student_device_bootstraps (device_id)
  WHERE status = 'PENDING';

CREATE INDEX idx_student_device_bootstraps_student
  ON student_device_bootstraps (student_id);

-- ---------------------------------------------------------------------------
-- The edge's replica of one bootstrap
-- ---------------------------------------------------------------------------
-- Same shape as the cloud's row plus the resolved local student, and the same
-- deliberate absence: no plaintext secret exists on either side of the
-- boundary in stored form.
CREATE TABLE sync_student_device_bootstraps (
  cloud_sync_id           UUID        PRIMARY KEY,
  -- The opaque device identity the secret is bound to. Unique (below), so the
  -- consume statement's device check and a re-delivered event both resolve to
  -- exactly one row.
  cloud_device_ref        UUID        NOT NULL,
  -- Resolved by the applier from `cloud_student_sync_id`; NOT NULL so a
  -- bootstrap can never be stored without an owner.
  student_id              BIGINT      NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  cloud_student_sync_id   UUID        NOT NULL,
  secret_hash             TEXT        NOT NULL,
  status                  TEXT        NOT NULL
                                      CHECK (status IN ('PENDING', 'CONSUMED')),
  expires_at              TIMESTAMPTZ NOT NULL,
  -- Set by the edge's consume statement when - and only when - the row is
  -- spent. The paired CHECK keeps status and timestamp from ever disagreeing.
  consumed_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL))
);

-- One device reference describes at most one bootstrap, no matter how often
-- the feed re-delivers the event that carried it.
CREATE UNIQUE INDEX idx_sync_student_device_bootstraps_device_ref
  ON sync_student_device_bootstraps (cloud_device_ref);

CREATE INDEX idx_sync_student_device_bootstraps_student
  ON sync_student_device_bootstraps (student_id);

CREATE TRIGGER sync_student_device_bootstraps_set_updated_at
BEFORE UPDATE ON sync_student_device_bootstraps
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
