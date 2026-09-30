// Tests for the read-only student device status endpoint, GET /api/student/device.
//
// The endpoint is a pure read that maps the student's ACTIVE `student_devices` row onto a
// stable UI state, so the tests drive the state matrix by inserting device rows directly rather
// than by running four WebAuthn ceremonies. That keeps every case (no device / discoverable
// TRUE / FALSE / NULL) independent of ceremony mechanics, and lets the read-only guarantees be
// asserted precisely.

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";

const TEST_PASSWORD = "student-device-status-test-password";
const RUN_ID = Date.now().toString(36).toUpperCase();
const DEPARTMENT_CODE = "DEVSTATP";
const FACULTY_CODE = "DEVSTATF";

let server: Server;
let baseUrl: string;
let departmentId: number;
let levelId: number;

interface TestUser {
  role: "STUDENT" | "LECTURER" | "ADMIN";
  userId: number;
  name: string;
}

let noDeviceStudent: TestUser;
let discoverableStudent: TestUser;
let nonDiscoverableStudent: TestUser;
let unknownDiscoverableStudent: TestUser;
let revokedOnlyStudent: TestUser;
let lecturerUser: TestUser;
let adminUser: TestUser;
let inactiveStudentUser: TestUser;

const sessionTokens: Record<number, string> = {};

const cookieHeader = (userId: number): Record<string, string> => ({
  cookie: `${authConfig.cookieName}=${sessionTokens[userId]}`,
});

async function getStatus(
  userId: number | null
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(baseUrl + "/api/student/device", {
    method: "GET",
    headers: userId === null ? {} : cookieHeader(userId),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function studentRowId(userId: number): Promise<number> {
  const res = await pool.query(`SELECT id FROM students WHERE user_id = $1 LIMIT 1`, [
    userId,
  ]);
  return Number(res.rows[0].id);
}

/**
 * Insert an ACTIVE device row for a student with an explicit `discoverable` value. Using the
 * column directly is the point of these tests: the endpoint must report FALSE and NULL
 * differently even though both mean "upgrade", and that distinction is invisible if the value is
 * always produced by a real ceremony.
 */
async function insertActiveDevice(
  userId: number,
  options: { discoverable: boolean | null; label?: string | null }
): Promise<string> {
  const credentialId = `status-cred-${userId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, cred_type, label,
        discoverable, status)
     VALUES ($1, $2, $3, 0, 'public-key', $4, $5, 'ACTIVE')`,
    [
      await studentRowId(userId),
      credentialId,
      Buffer.from([0xa0, 0x01]),
      options.label ?? null,
      options.discoverable,
    ]
  );
  return credentialId;
}

async function cleanupFixtures(): Promise<void> {
  const userIds = (
    await pool.query(
      `SELECT id FROM users
       WHERE name LIKE 'Device Status %'
          OR id IN (
            SELECT user_id FROM students
            WHERE department_id IN (SELECT id FROM departments WHERE code = $1)
          )`,
      [DEPARTMENT_CODE]
    )
  ).rows.map((row: { id: unknown }) => Number(row.id));

  const studentIds = (
    await pool.query(`SELECT id FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds])
  ).rows.map((row: { id: unknown }) => Number(row.id));

  await pool.query(
    `DELETE FROM audit_logs
      WHERE user_id = ANY($1::BIGINT[])
         OR (entity_type = 'student_devices' AND entity_id IN (
              SELECT id FROM student_devices WHERE student_id = ANY($2::BIGINT[])
            ))`,
    [userIds, studentIds]
  );
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges WHERE student_id = ANY($1::BIGINT[])`,
    [studentIds]
  );
  await pool.query(`DELETE FROM student_devices WHERE student_id = ANY($1::BIGINT[])`, [
    studentIds,
  ]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
}

before(async () => {
  await cleanupFixtures();

  await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Device Status Test Faculty', $1)
     ON CONFLICT (code) DO NOTHING`,
    [FACULTY_CODE]
  );
  const faculty = await pool.query(`SELECT id FROM faculties WHERE code = $1`, [FACULTY_CODE]);
  const facultyId = Number(faculty.rows[0].id);

  await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Device Status Test Department', $1, $2)
     ON CONFLICT (code) DO NOTHING`,
    [DEPARTMENT_CODE, facultyId]
  );
  const department = await pool.query(
    `SELECT id FROM departments WHERE code = $1`,
    [DEPARTMENT_CODE]
  );
  departmentId = Number(department.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelId = Number(level.rows[0].id);

  const passwordHash = await hashPassword(TEST_PASSWORD);

  async function insertUser(
    name: string,
    role: string,
    status: string,
    withStudentRow: boolean
  ): Promise<TestUser> {
    const username = role === "ADMIN" ? `devstatus-${RUN_ID}` : null;
    const userRes = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, passwordHash, role, status, username]
    );
    const userId = Number(userRes.rows[0].id);
    if (withStudentRow) {
      await pool.query(
        `INSERT INTO students (user_id, matric_number, department_id, level_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, `DEVST/${RUN_ID}/${userId}`, departmentId, levelId]
      );
    }
    return { role: role as TestUser["role"], userId, name };
  }

  noDeviceStudent = await insertUser("Device Status No Device", "STUDENT", "ACTIVE", true);
  discoverableStudent = await insertUser(
    "Device Status Discoverable",
    "STUDENT",
    "ACTIVE",
    true
  );
  nonDiscoverableStudent = await insertUser(
    "Device Status Non Discoverable",
    "STUDENT",
    "ACTIVE",
    true
  );
  unknownDiscoverableStudent = await insertUser(
    "Device Status Unknown",
    "STUDENT",
    "ACTIVE",
    true
  );
  revokedOnlyStudent = await insertUser(
    "Device Status Revoked Only",
    "STUDENT",
    "ACTIVE",
    true
  );
  lecturerUser = await insertUser("Device Status Lecturer", "LECTURER", "ACTIVE", false);
  adminUser = await insertUser("Device Status Admin", "ADMIN", "ACTIVE", false);
  inactiveStudentUser = await insertUser(
    "Device Status Inactive",
    "STUDENT",
    "INACTIVE",
    true
  );

  for (const user of [
    noDeviceStudent,
    discoverableStudent,
    nonDiscoverableStudent,
    unknownDiscoverableStudent,
    revokedOnlyStudent,
    lecturerUser,
    adminUser,
    inactiveStudentUser,
  ]) {
    const token = `device-status-session-${user.userId}-${Date.now()}`;
    await pool.query(
      `INSERT INTO sessions (user_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [
        user.userId,
        hashSessionToken(token),
        new Date(Date.now() + authConfig.sessionLifetimeMs),
      ]
    );
    sessionTokens[user.userId] = token;
  }

  await insertActiveDevice(discoverableStudent.userId, {
    discoverable: true,
    label: "Personal Phone",
  });
  await insertActiveDevice(nonDiscoverableStudent.userId, {
    discoverable: false,
    label: "Old Laptop",
  });
  await insertActiveDevice(unknownDiscoverableStudent.userId, { discoverable: null });

  // A student whose only device was revoked has no ACTIVE device, so the status must be ENROLL
  // even though a device row still exists for them.
  await insertActiveDevice(revokedOnlyStudent.userId, {
    discoverable: true,
    label: "Retired Phone",
  });
  await pool.query(
    `UPDATE student_devices SET status = 'REVOKED', revoked_at = now()
      WHERE student_id = $1`,
    [await studentRowId(revokedOnlyStudent.userId)]
  );

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

  await cleanupFixtures();
  await pool.query(`DELETE FROM departments WHERE code = $1`, [DEPARTMENT_CODE]);
  await pool.query(`DELETE FROM faculties WHERE code = $1`, [FACULTY_CODE]);
  await pool.end();
});

test("DEVICE status: a student with no device is told to enroll", async () => {
  const { status, body } = await getStatus(noDeviceStudent.userId);
  assert.equal(status, 200);
  assert.equal(body.enrollmentMode, "ENROLL");
  assert.equal(body.discoverable, null);
  assert.equal(body.device, null);
});

test("DEVICE status: a student whose only device is revoked is told to enroll", async () => {
  const { status, body } = await getStatus(revokedOnlyStudent.userId);
  assert.equal(status, 200);
  assert.equal(
    body.enrollmentMode,
    "ENROLL",
    "a REVOKED device is not an ACTIVE device"
  );
  assert.equal(body.device, null);
});

test("DEVICE status: a discoverable device is reported as ACTIVE with its label", async () => {
  const { status, body } = await getStatus(discoverableStudent.userId);
  assert.equal(status, 200);
  assert.equal(body.enrollmentMode, "ACTIVE");
  assert.equal(body.discoverable, true);
  const device = body.device as { enrolledAt: string; label: string | null };
  assert.equal(device.label, "Personal Phone");
  assert.ok(
    !Number.isNaN(Date.parse(device.enrolledAt)),
    "enrolledAt must be a parseable timestamp"
  );
});

test("DEVICE status: a device recorded as non-discoverable is reported as UPGRADE", async () => {
  const { status, body } = await getStatus(nonDiscoverableStudent.userId);
  assert.equal(status, 200);
  assert.equal(body.enrollmentMode, "UPGRADE");
  assert.equal(body.discoverable, false);
  const device = body.device as { label: string | null };
  assert.equal(
    device.label,
    "Old Laptop",
    "the existing device is still described so the student knows what is being replaced"
  );
});

test("DEVICE status: a pre-migration device (discoverable NULL) is reported as UPGRADE but keeps null discoverable", async () => {
  const { status, body } = await getStatus(unknownDiscoverableStudent.userId);
  assert.equal(status, 200);
  assert.equal(
    body.enrollmentMode,
    "UPGRADE",
    "an unknown discoverability must never be treated as usable for device login"
  );
  assert.equal(
    body.discoverable,
    null,
    "NULL means unknown and must not be collapsed into false"
  );
  assert.notEqual(body.device, null);
});

test("DEVICE status: the response exposes no credential internals", async () => {
  const forbiddenKeys = [
    "credentialId",
    "credential_id",
    "credentialPublicKey",
    "credential_public_key",
    "publicKey",
    "counter",
    "aaguid",
    "transports",
    "studentId",
    "matricNumber",
    "webauthnUserHandle",
    "userHandle",
  ];

  for (const user of [
    discoverableStudent,
    nonDiscoverableStudent,
    unknownDiscoverableStudent,
    noDeviceStudent,
  ]) {
    const { body } = await getStatus(user.userId);
    const device = body.device as Record<string, unknown> | null;
    const surfaces: Array<Record<string, unknown> | null> = [body, device];
    for (const surface of surfaces) {
      if (surface === null) {
        continue;
      }
      for (const key of forbiddenKeys) {
        assert.ok(
          !(key in surface),
          `GET /api/student/device must not expose "${key}"`
        );
      }
    }
  }
});

test("DEVICE status: the endpoint is read-only and starts no ceremony", async () => {
  const sid = await studentRowId(nonDiscoverableStudent.userId);

  // Give the student a live challenge first, so we can prove a status read neither consumes it
  // nor creates a second one, and that the device row is untouched.
  const beforeChallenge = await pool.query(
    `SELECT count(*)::int AS total FROM student_device_enrollment_challenges
      WHERE student_id = $1`,
    [sid]
  );
  const beforeDevices = await pool.query(
    `SELECT id, credential_id, discoverable, status, enrolled_at
       FROM student_devices WHERE student_id = $1 ORDER BY id`,
    [sid]
  );

  const opts = await fetch(baseUrl + "/api/student/device/enrollment/options", {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieHeader(nonDiscoverableStudent.userId) },
    body: "{}",
  });
  assert.equal(opts.status, 200);

  const first = await getStatus(nonDiscoverableStudent.userId);
  const second = await getStatus(nonDiscoverableStudent.userId);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(
    first.body,
    second.body,
    "repeated status reads must be identical and stable"
  );

  const afterChallenge = await pool.query(
    `SELECT count(*)::int AS total FROM student_device_enrollment_challenges
      WHERE student_id = $1`,
    [sid]
  );
  assert.equal(
    afterChallenge.rows[0].total,
    beforeChallenge.rows[0].total + 1,
    "only the explicit options call may add a challenge; status reads must add none"
  );

  const activeChallenge = await pool.query(
    `SELECT count(*)::int AS total FROM student_device_enrollment_challenges
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [sid]
  );
  assert.equal(
    activeChallenge.rows[0].total,
    1,
    "status reads must not expire the pending enrollment challenge"
  );

  const afterDevices = await pool.query(
    `SELECT id, credential_id, discoverable, status, enrolled_at
       FROM student_devices WHERE student_id = $1 ORDER BY id`,
    [sid]
  );
  assert.deepEqual(
    afterDevices.rows,
    beforeDevices.rows,
    "status reads must not modify any device row"
  );
});

test("DEVICE status: the reported state agrees with what an enrollment would be allowed to do", async () => {
  // The whole point of the status endpoint is that it must not lie about the ceremony: a
  // student shown ACTIVE must be refused a new ceremony, and a student shown UPGRADE must be
  // offered one.
  const activeRes = await fetch(baseUrl + "/api/student/device/enrollment/options", {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieHeader(discoverableStudent.userId) },
    body: "{}",
  });
  assert.equal(
    activeRes.status,
    409,
    "a device reported as ACTIVE must not be rotatable"
  );
  assert.equal(((await activeRes.json()) as { error: string }).error, "DEVICE_ALREADY_ENROLLED");

  for (const user of [nonDiscoverableStudent, unknownDiscoverableStudent]) {
    const status = await getStatus(user.userId);
    assert.equal(status.body.enrollmentMode, "UPGRADE");
    const res = await fetch(baseUrl + "/api/student/device/enrollment/options", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(user.userId) },
      body: "{}",
    });
    assert.equal(res.status, 200, "a device reported as UPGRADE must be upgradeable");
    const body = (await res.json()) as { enrollmentMode: string };
    assert.equal(
      body.enrollmentMode,
      "UPGRADE",
      "the ceremony mode must match the state the status endpoint reported"
    );
  }
});

test("DEVICE status: anonymous requests are rejected with 401", async () => {
  const { status, body } = await getStatus(null);
  assert.equal(status, 401);
  assert.equal(body.error, "UNAUTHENTICATED");
});

test("DEVICE status: non-student accounts are rejected with 403", async () => {
  for (const user of [lecturerUser, adminUser]) {
    const { status, body } = await getStatus(user.userId);
    assert.equal(status, 403, `${user.role} must not read a student device status`);
    assert.equal(body.error, "FORBIDDEN");
  }
});

test("DEVICE status: an inactive student account is rejected with 401", async () => {
  const { status, body } = await getStatus(inactiveStudentUser.userId);
  assert.equal(status, 401);
  assert.equal(body.error, "UNAUTHENTICATED");
});
