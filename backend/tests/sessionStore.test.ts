import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import {
  cleanupExpiredSessions,
  createSession,
  findSessionByTokenHash,
  isSessionActive,
  revokeSession,
  updateLastSeen,
} from "../src/services/sessionStore";

let testUserId: number;

before(async () => {
  const passwordHash = await hashPassword("test-password");
  const result = await pool.query(
    `INSERT INTO users (name, password_hash, role, username)
     VALUES ('Session Store Test User', $1, 'ADMIN', 'session_store_test')
     RETURNING id`,
    [passwordHash]
  );
  testUserId = Number(result.rows[0].id);
});

after(async () => {
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [testUserId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  await pool.end();
});

function futureExpiry(): Date {
  return new Date(Date.now() + authConfig.sessionLifetimeMs);
}

test("createSession stores a hash, never the raw token", async () => {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);

  const session = await createSession(testUserId, tokenHash, futureExpiry());

  assert.equal(session.session_token_hash, tokenHash);
  assert.notEqual(session.session_token_hash, token, "raw token must not be stored");

  const stored = await pool.query(
    `SELECT session_token_hash FROM sessions WHERE id = $1`,
    [session.id]
  );
  assert.equal(stored.rows[0].session_token_hash, tokenHash);

  const found = await findSessionByTokenHash(tokenHash);
  assert.ok(found, "session should be findable by its hash");
});

test("an active session is returned as active", async () => {
  const tokenHash = hashSessionToken(generateSessionToken());
  const session = await createSession(testUserId, tokenHash, futureExpiry());

  assert.equal(isSessionActive(session), true);
});

test("revoked sessions are rejected but remain in the database", async () => {
  const tokenHash = hashSessionToken(generateSessionToken());
  const session = await createSession(testUserId, tokenHash, futureExpiry());

  await revokeSession(session.id);

  const stored = await pool.query(`SELECT * FROM sessions WHERE id = $1`, [
    session.id,
  ]);
  assert.equal(stored.rows.length, 1, "revoked session must remain for audit history");
  assert.ok(stored.rows[0].revoked_at, "revoked_at should be set");

  const found = await findSessionByTokenHash(tokenHash);
  assert.ok(found);
  assert.equal(isSessionActive(found), false, "revoked session must be rejected");
});

test("expired sessions are rejected", async () => {
  const tokenHash = hashSessionToken(generateSessionToken());
  const alreadyExpired = new Date(Date.now() - 1000);
  const session = await createSession(testUserId, tokenHash, alreadyExpired);

  assert.equal(isSessionActive(session), false, "expired session must be rejected");
});

test("updateLastSeen refreshes last_seen_at", async () => {
  const tokenHash = hashSessionToken(generateSessionToken());
  const session = await createSession(testUserId, tokenHash, futureExpiry());

  const beforeUpdate = await pool.query(
    `SELECT last_seen_at FROM sessions WHERE id = $1`,
    [session.id]
  );

  await updateLastSeen(session.id);

  const afterUpdate = await pool.query(
    `SELECT last_seen_at FROM sessions WHERE id = $1`,
    [session.id]
  );

  assert.ok(
    afterUpdate.rows[0].last_seen_at >= beforeUpdate.rows[0].last_seen_at,
    "last_seen_at should not move backwards"
  );
});

test("cleanupExpiredSessions removes expired, keeps revoked, and never touches active", async () => {
  const expiredHash = hashSessionToken(generateSessionToken());
  await createSession(testUserId, expiredHash, new Date(Date.now() - 1000));

  const revokedHash = hashSessionToken(generateSessionToken());
  const revoked = await createSession(testUserId, revokedHash, futureExpiry());
  await revokeSession(revoked.id);

  const activeHash = hashSessionToken(generateSessionToken());
  await createSession(testUserId, activeHash, futureExpiry());

  await cleanupExpiredSessions();

  const expiredGone = await pool.query(
    `SELECT id FROM sessions WHERE session_token_hash = $1`,
    [expiredHash]
  );
  assert.equal(expiredGone.rows.length, 0, "expired sessions should be cleaned up");

  const revokedStillThere = await pool.query(
    `SELECT revoked_at FROM sessions WHERE id = $1`,
    [revoked.id]
  );
  assert.equal(revokedStillThere.rows.length, 1, "revoked sessions are audit history");
  assert.ok(revokedStillThere.rows[0].revoked_at);
});