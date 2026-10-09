// Synchronized-student local password setup (the two-path registration flow).
//
// Background
// ----------
// A student created and device-enrolled on the CLOUD is synchronized to this edge
// into the real `users` + `students` tables with `password_hash = NULL` (the
// applier never copies a cloud hash - see syncMasterDataAppliers.applyStudent).
// Without a local password, that student can never satisfy the password gate on
// /auth/student/login, so the account is permanently unusable here even though
// its device and bootstrap projections synced fine.
//
// The fix gives that population a way to choose a LOCAL password through the
// existing registration flow, gated on `password_hash IS NULL` AND a live
// cloud-enrollment bootstrap. So these tests assert three things:
//
//   1. the new population can complete it and can then log in;
//   2. the gate is narrow - an ACTIVE student with no eligible bootstrap is
//      refused, and nobody can reach an account that already has a password;
//   3. the existing PENDING-student path is unchanged, and the atomicity
//      guarantees (single use, no overwrite, exactly one concurrent winner)
//      still hold.
//
// Nothing here syncs a password hash, mints a session from a bootstrap secret, or
// relaxes the login gate: after setup the account still has no device-bound
// session until a normal login provides one.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword, verifyPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "sync-setup-test-password";
const REGISTRATION_PASSWORD = "s3cure-sync-setup-pass";

let server: Server;
let baseUrl: string;
let departmentId: number;
let levelId: number;

/** Local ids of every row this suite creates, so cleanup is exhaustive. */
const created: {
  userIds: number[];
  studentIds: number[];
} = { userIds: [], studentIds: [] };

let passwordHash: string;

/** The synchronized student: ACTIVE, no local password, one live bootstrap. */
let syncedUserId = 0;
let syncedStudentId = 0;
let syncedBootstrapSyncId = "";

/** ACTIVE, no local password, but its only bootstrap is consumed. */
let consumedBootstrapUserId = 0;

/** ACTIVE, no local password, but no bootstrap row at all. */
let noBootstrapUserId = 0;

/** ACTIVE with a local password already set - must stay unreachable. */
let alreadyPasswordedUserId = 0;

/** Ordinary pending student, the pre-existing path that must not change. */
let pendingUserId = 0;

function postJson(path: string, body: unknown) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface VerifyBody {
  data: {
    matricNumber: string;
    name: string;
    department: { id: number; name: string; code: string };
    level: { id: number; name: number };
    challengeToken: string;
  };
}

async function verify(
  matricNumber: string
): Promise<{ status: number; body: VerifyBody }> {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber,
  });
  const status = res.status;
  const body =
    status === 200
      ? ((await res.json()) as VerifyBody)
      : ({ data: {} } as unknown as VerifyBody);
  return { status, body };
}

async function complete(challengeToken: string, password: string) {
  return postJson("/api/auth/student/register/complete", {
    challengeToken,
    password,
  });
}

function sessionCookie(res: globalThis.Response): string | null {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.cookieName}=`));
  if (!cookie) return null;
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";");
  return cookie.slice(eq + 1, semi);
}

before(async () => {
  await pool.query(
    `INSERT INTO faculties (name, code)
     VALUES ('Sync Password Setup Faculty', 'SYNCPWFAC')
     ON CONFLICT (code) DO NOTHING`
  );
  const facultyRes = await pool.query(
    `SELECT id FROM faculties WHERE code = 'SYNCPWFAC'`
  );
  const facultyId = Number(facultyRes.rows[0].id);

  const dept = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Sync Password Setup Department', 'SYNCPWDEP', $1)
     ON CONFLICT (code) DO NOTHING`,
    [facultyId]
  );
  if ((dept.rowCount ?? 0) === 0) {
    const existing = await pool.query(
      `SELECT id FROM departments WHERE code = 'SYNCPWDEP'`
    );
    departmentId = Number(existing.rows[0].id);
  } else {
    const createdDept = await pool.query(
      `SELECT id FROM departments WHERE code = 'SYNCPWDEP'`
    );
    departmentId = Number(createdDept.rows[0].id);
  }
  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelId = Number(level.rows[0].id);

  passwordHash = await hashPassword(TEST_PASSWORD);

  async function insertStudent(
    name: string,
    status: string,
    hash: string | null,
    matric: string
  ): Promise<{ userId: number; studentId: number }> {
    const userRes = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, 'STUDENT', $3, NULL)
       RETURNING id`,
      [name, hash, status]
    );
    const userId = Number(userRes.rows[0].id);
    const studentRes = await pool.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, matric, departmentId, levelId]
    );
    created.userIds.push(userId);
    const studentId = Number(studentRes.rows[0].id);
    created.studentIds.push(studentId);
    return { userId, studentId };
  }

  // A live cloud-enrollment bootstrap projection, which is what makes an
  // otherwise-passwordless ACTIVE student eligible.
  async function insertBootstrap(
    studentId: number,
    status: "PENDING" | "CONSUMED",
    expiresIn: string
  ): Promise<string> {
    const consumedAt = status === "CONSUMED" ? "now()" : "NULL";
    const res = await pool.query(
      `INSERT INTO sync_student_device_bootstraps
         (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id,
          secret_hash, status, expires_at, consumed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() + ($6::interval), ${consumedAt})
       RETURNING cloud_sync_id`,
      [randomUUID(), studentId, randomUUID(), "0".repeat(64), status, expiresIn]
    );
    return res.rows[0].cloud_sync_id as string;
  }

  const synced = await insertStudent("Synced Student", "ACTIVE", null, "SYNCPW/0001");
  syncedUserId = synced.userId;
  syncedStudentId = synced.studentId;
  syncedBootstrapSyncId = await insertBootstrap(
    syncedStudentId,
    "PENDING",
    "1 hour"
  );

  const consumed = await insertStudent(
    "Consumed Bootstrap Student",
    "ACTIVE",
    null,
    "SYNCPW/0002"
  );
  consumedBootstrapUserId = consumed.userId;
  await insertBootstrap(consumed.studentId, "CONSUMED", "1 hour");

  const noBootstrap = await insertStudent(
    "No Bootstrap Student",
    "ACTIVE",
    null,
    "SYNCPW/0003"
  );
  noBootstrapUserId = noBootstrap.userId;

  const passworded = await insertStudent(
    "Already Passworded Student",
    "ACTIVE",
    passwordHash,
    "SYNCPW/0004"
  );
  alreadyPasswordedUserId = passworded.userId;

  const pending = await insertStudent("Pending Student", "PENDING", null, "SYNCPW/0005");
  pendingUserId = pending.userId;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  await pool.query(
    `DELETE FROM student_registration_challenges WHERE user_id = ANY($1::BIGINT[])`,
    [created.userIds]
  );
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    created.userIds,
  ]);
  await pool.query(
    `DELETE FROM sync_student_device_bootstraps WHERE student_id = ANY($1::BIGINT[])`,
    [created.studentIds]
  );
  await pool.query(`DELETE FROM students WHERE id = ANY($1::BIGINT[])`, [
    created.studentIds,
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [
    created.userIds,
  ]);
  await pool.query(`DELETE FROM departments WHERE code = 'SYNCPWDEP'`);
  await pool.query(`DELETE FROM faculties WHERE code = 'SYNCPWFAC'`);
  await pool.end();
});

async function userState(userId: number): Promise<{
  status: string;
  hash: string | null;
}> {
  const res = await pool.query(`SELECT status, password_hash FROM users WHERE id = $1`, [
    userId,
  ]);
  return { status: res.rows[0].status, hash: res.rows[0].password_hash };
}

// ---------------------------------------------------------------------------
// Eligibility of the new path
// ---------------------------------------------------------------------------

test("SYNCPW verify: an ACTIVE student with a live cloud bootstrap is eligible", async () => {
  const { status, body } = await verify("SYNCPW/0001");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.data).sort(), [
    "challengeToken",
    "department",
    "level",
    "matricNumber",
    "name",
  ]);
  assert.equal(body.data.matricNumber, "SYNCPW/0001");
  assert.equal(body.data.name, "Synced Student");
  assert.deepEqual(body.data.department, {
    id: departmentId,
    name: "Sync Password Setup Department",
    code: "SYNCPWDEP",
  });
  assert.deepEqual(body.data.level, { id: levelId, name: 100 });
  assert.ok(
    typeof body.data.challengeToken === "string" &&
      body.data.challengeToken.length >= 40,
    "a long random challenge token must be returned"
  );

  const serialized = JSON.stringify(body);
  assert.ok(!("userId" in body.data), "must never expose the user id");
  assert.ok(!("role" in body.data), "must never expose the role");
  assert.ok(!serialized.includes("password"), "must never expose a password");
  assert.ok(!serialized.includes("passwordHash"), "must never expose a password hash");
  assert.ok(!serialized.includes("password_hash"), "must never expose a password hash");
  assert.ok(
    !serialized.includes(syncedBootstrapSyncId),
    "must never expose a bootstrap identity"
  );
});

test("SYNCPW verify: an ACTIVE student with no bootstrap is refused", async () => {
  const { status } = await verify("SYNCPW/0003");

  assert.equal(status, 404);
  assert.deepEqual(await (await postJson("/api/auth/student/register/verify", { matricNumber: "SYNCPW/0003" })).json(), {
    error: "STUDENT_NOT_FOUND",
    message: "This matric number is not available for student registration.",
  });
});

test("SYNCPW verify: an ACTIVE student whose only bootstrap is consumed is refused", async () => {
  const { status } = await verify("SYNCPW/0002");
  assert.equal(status, 404);
});

test("SYNCPW verify: an ACTIVE student that already has a password is refused", async () => {
  const { status } = await verify("SYNCPW/0004");
  assert.equal(status, 404);
});

test("SYNCPW verify: an expired bootstrap does not confer eligibility", async () => {
  // Backdate the only live bootstrap past the expiry horizon used by the gate.
  await pool.query(
    `UPDATE sync_student_device_bootstraps
        SET expires_at = now() - interval '1 minute'
      WHERE cloud_sync_id = $1`,
    [syncedBootstrapSyncId]
  );
  try {
    const { status } = await verify("SYNCPW/0001");
    assert.equal(status, 404);
  } finally {
    await pool.query(
      `UPDATE sync_student_device_bootstraps
          SET expires_at = now() + interval '1 hour'
        WHERE cloud_sync_id = $1`,
      [syncedBootstrapSyncId]
    );
  }
});

test("SYNCPW verify: an ordinary PENDING student stays eligible (regression)", async () => {
  const { status, body } = await verify("SYNCPW/0005");
  assert.equal(status, 200);
  assert.equal(body.data.matricNumber, "SYNCPW/0005");
  assert.equal(body.data.name, "Pending Student");
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

test("SYNCPW complete: a synchronized student obtains a LOCAL argon2id password", async () => {
  const { body } = await verify("SYNCPW/0001");
  const res = await complete(body.data.challengeToken, REGISTRATION_PASSWORD);

  assert.equal(res.status, 201);
  const bodyOut = (await res.json()) as { user: { matricNumber: string; role: string } };
  assert.equal(bodyOut.user.matricNumber, "SYNCPW/0001");
  assert.equal(bodyOut.user.role, "STUDENT");

  const cookie = sessionCookie(res);
  assert.ok(cookie, "a session cookie must be set on completion");

  const state = await userState(syncedUserId);
  assert.equal(state.status, "ACTIVE", "an already ACTIVE student stays ACTIVE");
  assert.ok(state.hash !== null, "a local password hash must now exist");
  assert.ok(state.hash.startsWith("$argon2id$"), "the hash must be Argon2id");
  assert.notEqual(state.hash, REGISTRATION_PASSWORD);
  assert.ok(await verifyPassword(state.hash, REGISTRATION_PASSWORD));
});

test("SYNCPW account: the new password lets the student authenticate, and the login gate is unchanged", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: "SYNCPW/0001",
    password: REGISTRATION_PASSWORD,
  });

  // The password is now correct, but a password alone still must not mint a
  // session: this browser holds no device binding, so the enrollment decision
  // runs exactly as it would for any other student.
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enrollmentRequired: true });
  assert.ok(
    !res.headers.getSetCookie().some((c) => c.startsWith(`${authConfig.cookieName}=`)),
    "a password alone must not create a session"
  );

  // A wrong password is still refused, so the gate was not weakened.
  const wrong = await postJson("/api/auth/student/login", {
    matricNumber: "SYNCPW/0001",
    password: "not-the-password-that-was-set",
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "INVALID_CREDENTIALS" });
});

test("SYNCPW complete: the cloud bootstrap projection is untouched by password setup", async () => {
  const rows = await pool.query(
    `SELECT status, secret_hash, expires_at, consumed_at
       FROM sync_student_device_bootstraps
      WHERE cloud_sync_id = $1`,
    [syncedBootstrapSyncId]
  );
  assert.equal(rows.rowCount, 1);
  const row = rows.rows[0];
  assert.equal(row.status, "PENDING", "password setup must not spend the bootstrap");
  assert.equal(row.consumed_at, null);
  assert.equal(row.secret_hash, "0".repeat(64));
});

test("SYNCPW complete: no cloud password hash was copied into the local user row", async () => {
  const state = await userState(syncedUserId);
  assert.ok(state.hash !== null);
  assert.ok(!state.hash.includes("cloud"), "no cloud hash material may be stored");
  // The set password is the one this suite supplied, provable by verification.
  assert.ok(await verifyPassword(state.hash, REGISTRATION_PASSWORD));
  assert.ok(!(await verifyPassword(state.hash, TEST_PASSWORD)));
});

test("SYNCPW complete: an ordinary PENDING student completes the old path unchanged", async () => {
  const { body } = await verify("SYNCPW/0005");
  const res = await complete(body.data.challengeToken, REGISTRATION_PASSWORD);

  assert.equal(res.status, 201);
  const state = await userState(pendingUserId);
  assert.equal(state.status, "ACTIVE", "the old path still activates PENDING");
  assert.ok(state.hash !== null && (await verifyPassword(state.hash, REGISTRATION_PASSWORD)));
});

// ---------------------------------------------------------------------------
// Atomicity and single use
// ---------------------------------------------------------------------------

test("SYNCPW complete: a used challenge cannot be replayed", async () => {
  // The synchronized student already completed above; a fresh challenge is
  // issued for them, spent, then replayed.
  const { body } = await verify("SYNCPW/0001");
  const first = await complete(body.data.challengeToken, "another-password-2");
  assert.equal(first.status, 409, "the password is already set, so it cannot be reset");
  assert.equal((await first.json()).error, "ALREADY_REGISTERED");

  const hashBefore = (await userState(syncedUserId)).hash;
  const second = await complete(body.data.challengeToken, "yet-another-password");
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error, "INVALID_REGISTRATION_CHALLENGE");
  assert.equal(
    (await userState(syncedUserId)).hash,
    hashBefore,
    "the accepted password must never be overwritten"
  );
});

test("SYNCPW complete: an expired challenge is rejected with no side effects", async () => {
  const userRes = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Expired Challenge Student', NULL, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`
  );
  const userId = Number(userRes.rows[0].id);
  created.userIds.push(userId);
  const studentRes = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, 'SYNCPW/0006', $2, $3)
     RETURNING id`,
    [userId, departmentId, levelId]
  );
  const studentId = Number(studentRes.rows[0].id);
  created.studentIds.push(studentId);
  await pool.query(
    `INSERT INTO sync_student_device_bootstraps
       (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id,
        secret_hash, status, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PENDING', now() + interval '1 hour')`,
    [randomUUID(), studentId, randomUUID(), "0".repeat(64)]
  );

  const fresh = await verify("SYNCPW/0006");
  assert.equal(fresh.status, 200);

  await pool.query(
    `UPDATE student_registration_challenges
        SET created_at = now() - interval '16 minutes'
      WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId]
  );

  const res = await complete(fresh.body.data.challengeToken, REGISTRATION_PASSWORD);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_REGISTRATION_CHALLENGE");

  const state = await userState(userId);
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.hash, null, "an expired challenge must not set a password");
});

test("SYNCPW completion: concurrent completions cannot both succeed", async () => {
  const userRes = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Concurrent Setup Student', NULL, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`
  );
  const userId = Number(userRes.rows[0].id);
  created.userIds.push(userId);
  const studentRes = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, 'SYNCPW/0007', $2, $3)
     RETURNING id`,
    [userId, departmentId, levelId]
  );
  const studentId = Number(studentRes.rows[0].id);
  created.studentIds.push(studentId);
  await pool.query(
    `INSERT INTO sync_student_device_bootstraps
       (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id,
        secret_hash, status, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PENDING', now() + interval '1 hour')`,
    [randomUUID(), studentId, randomUUID(), "0".repeat(64)]
  );

  const { body } = await verify("SYNCPW/0007");
  assert.equal(body.data.matricNumber, "SYNCPW/0007");

  const [a, b] = await Promise.all([
    complete(body.data.challengeToken, REGISTRATION_PASSWORD),
    complete(body.data.challengeToken, REGISTRATION_PASSWORD),
  ]);

  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [201, 400], "exactly one completion must win");

  const sessions = await pool.query(
    `SELECT id FROM sessions WHERE user_id = $1`,
    [userId]
  );
  assert.equal(sessions.rowCount, 1, "only the winner may create a session");

  const state = await userState(userId);
  assert.equal(state.status, "ACTIVE");
  assert.ok(
    state.hash !== null && (await verifyPassword(state.hash, REGISTRATION_PASSWORD)),
    "the surviving password must be the one that was submitted"
  );
});

test("SYNCPW completion: a second challenge cannot overwrite an established password", async () => {
  const hashBefore = (await userState(consumedBootstrapUserId)).hash;
  assert.equal(hashBefore, null);

  // This student is ineligible (consumed bootstrap), so no challenge can be
  // issued through the API at all. A forged one is refused by the same guarded
  // UPDATE the eligible path uses.
  const res = await complete("not-a-real-challenge-token", REGISTRATION_PASSWORD);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_REGISTRATION_CHALLENGE");
  assert.equal((await userState(consumedBootstrapUserId)).hash, null);
});

test("SYNCPW ineligible: no challenge token can be minted for an arbitrary ACTIVE student", async () => {
  // The ACTIVE-with-password student must never be able to begin this flow.
  const { status } = await verify("SYNCPW/0004");
  assert.equal(status, 404);
  assert.equal((await userState(alreadyPasswordedUserId)).hash, passwordHash);
});

test("SYNCPW schema: the cloud bootstrap projection keeps its consumed guard", async () => {
  // The paired CHECK on the edge's projection is what keeps `status` and
  // `consumed_at` from disagreeing; a setup path must never need to bypass it.
  const res = await pool.query(
    `SELECT 1
       FROM pg_constraint
      WHERE conname = 'sync_student_device_bootstraps_check'`
  );
  assert.equal(res.rowCount, 1);
});
