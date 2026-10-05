import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { resetStudentDevice } from "../src/services/adminStudentDeviceStore";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createTestAuthenticator,
  type TestAuthenticator,
} from "./webauthnTestHelpers";

/**
 * Admin student-device administration ("reset") integration tests.
 *
 * These exercise the real HTTP routes, the real transactional reset service, the
 * real WebAuthn enrollment/attendance flows, and the real database constraints.
 * Every fixture lives under the `ASD` namespace so this file can run alongside
 * the other integration suites without collisions.
 */

const TEST_PASSWORD = "asd-admin-device-password";
const RUN_ID = Date.now().toString(36).toUpperCase();
const MATRIC_PREFIX = "ASD/STU";

interface StudentFixture {
  userId: number;
  profileId: number;
  matric: string;
  authenticator: TestAuthenticator;
}

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturerUserId = 0;

// Deliberately separate students so each mutation-heavy test starts from a clean,
// known device state without depending on execution order.
let listingActive: StudentFixture;
let listingNone: StudentFixture;
let listingRevoked: StudentFixture;
let resetTarget: StudentFixture;
let identityTarget: StudentFixture;
let rollbackTarget: StudentFixture;
let concurrencyTarget: StudentFixture;
let challengeTarget: StudentFixture;
let lifecycleTarget: StudentFixture;
let concurrentEnrollTarget: StudentFixture;

let offeringId = 0;
const sessionIds: number[] = [];

const sessionTokens: Record<number, string> = {};

function cookieHeader(userId: number): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${sessionTokens[userId]}` };
}

async function getJson(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { method: "GET", headers });
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function errorCode(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

async function seedDevice(
  profileId: number,
  authenticator: TestAuthenticator,
  status = "ACTIVE"
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, status)
     VALUES ($1, $2, $3, 1, $4)
     RETURNING id`,
    [
      profileId,
      isoBase64URL.fromBuffer(authenticator.credentialId),
      Buffer.from(authenticator.credentialPublicKey),
      status,
    ]
  );
  return Number(result.rows[0].id);
}

async function enrollDevice(
  userId: number,
  label?: string
): Promise<TestAuthenticator> {
  const optionsRes = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(userId)
  );
  assert.equal(optionsRes.status, 200, "enrollment options must be issued");
  const optionsBody = (await optionsRes.json()) as {
    data: { challenge: string };
  };

  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: optionsBody.data.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const completeRes = await postJson(
    "/api/student/device/enrollment/complete",
    { credential, label: label ?? null },
    cookieHeader(userId)
  );
  assert.equal(completeRes.status, 201, "device enrollment must succeed");
  return authenticator;
}

async function buildAssertion(
  authenticator: TestAuthenticator,
  challenge: string,
  signCount = 2
) {
  return buildAuthenticationResponse({
    authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount,
  });
}

async function requestDeviceChallenge(
  userId: number
): Promise<{ status: number; challenge: string }> {
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(userId)
  );
  if (res.status !== 200) {
    return { status: res.status, challenge: "" };
  }
  const body = (await res.json()) as { data: { challenge: string } };
  return { status: res.status, challenge: body.data.challenge };
}

async function markAttendance(
  userId: number,
  attendanceSessionId: number,
  challenge: string,
  assertion: Awaited<ReturnType<typeof buildAssertion>>
) {
  return postJson(
    "/api/student/attendance",
    { attendanceSessionId, challenge, assertion },
    cookieHeader(userId)
  );
}

async function resetViaApi(studentId: number, userId = adminUserId) {
  return postJson(
    `/api/admin/students/${studentId}/device/reset`,
    {},
    cookieHeader(userId)
  );
}

async function cleanupFixtures(): Promise<void> {
  // Deleting by the ASD namespace (not this run's ids) lets an interrupted run be
  // recovered and keeps re-runs deterministic. FK-safe dependency order.
  await pool.query(
    `DELETE FROM attendance_records
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASD/%')
        OR session_id IN (
             SELECT id FROM attendance_sessions
             WHERE started_by_lecturer_id IN (
               SELECT id FROM lecturers WHERE staff_id LIKE 'ASD/%'
             )
           )`
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE staff_id LIKE 'ASD/%'
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASD/%')
        OR course_offering_id IN (
             SELECT id FROM course_offerings
             WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ASD-%')
           )`
  );
  await pool.query(
    `DELETE FROM audit_logs
     WHERE user_id IN (
             SELECT id FROM users WHERE name LIKE 'ASD %' OR username LIKE 'ASD_%'
           )
        OR (entity_type = 'student_devices' AND entity_id IN (
              SELECT id FROM student_devices
              WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASD/%')
            ))`
  );
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASD/%')`
  );
  await pool.query(
    `DELETE FROM student_devices
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASD/%')`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ASD-%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ASD-%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ASD-%'`);
  await pool.query(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT id FROM users WHERE name LIKE 'ASD %' OR username LIKE 'ASD_%'
     )`
  );
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'ASD/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'ASD/%'`);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'ASD %' OR username LIKE 'ASD_%'`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ASD-%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ASD-%'`);
}

before(async () => {
  await cleanupFixtures();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    [`ASD Faculty ${RUN_ID}`, `ASD-FAC-${RUN_ID}`]
  );
  const facultyId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`ASD Department ${RUN_ID}`, `ASD-DEP-${RUN_ID}`, facultyId]
  );
  const departmentId = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  const levelId = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ($1, true) RETURNING id`,
    [`ASD-ACAD-${RUN_ID}`]
  );
  const academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  const semesterId = Number(sem.rows[0].id);

  const course = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
     VALUES ($1, 'ASD Course', $2, $3, 'ACTIVE') RETURNING id`,
    [`ASD-C-${RUN_ID}`, facultyId, levelId]
  );
  const courseId = Number(course.rows[0].id);

  const offering = await pool.query(
    `INSERT INTO course_offerings
       (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'OPEN') RETURNING id`,
    [courseId, academicSessionId, semesterId]
  );
  offeringId = Number(offering.rows[0].id);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ASD Admin', $1, 'ADMIN', 'ACTIVE', 'ASD_ADMIN') RETURNING id`,
    [passwordHash]
  );
  adminUserId = Number(admin.rows[0].id);

  const lecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ('ASD Lecturer', $1, 'LECTURER', 'ACTIVE') RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturerUserId, `ASD/LEC/${RUN_ID}`, departmentId]
  );

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ('ASD Student Account', $1, 'STUDENT', 'ACTIVE') RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);

  let matricSeq = 0;
  async function makeStudent(name: string): Promise<StudentFixture> {
    matricSeq += 1;
    const matric = `${MATRIC_PREFIX}/${RUN_ID}/${String(matricSeq).padStart(2, "0")}`;
    const user = await pool.query(
      `INSERT INTO users (name, password_hash, role, status)
       VALUES ($1, $2, 'STUDENT', 'ACTIVE') RETURNING id`,
      [name, passwordHash]
    );
    const userId = Number(user.rows[0].id);
    const profile = await pool.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, matric, departmentId, levelId]
    );
    return {
      userId,
      profileId: Number(profile.rows[0].id),
      matric,
      authenticator: await createTestAuthenticator(),
    };
  }

  listingActive = await makeStudent("ASD Listing Active");
  listingNone = await makeStudent("ASD Listing None");
  listingRevoked = await makeStudent("ASD Listing Revoked");
  resetTarget = await makeStudent("ASD Reset Target");
  identityTarget = await makeStudent("ASD Identity Target");
  rollbackTarget = await makeStudent("ASD Rollback Target");
  concurrencyTarget = await makeStudent("ASD Concurrency Target");
  challengeTarget = await makeStudent("ASD Challenge Target");
  lifecycleTarget = await makeStudent("ASD Lifecycle Target");
  concurrentEnrollTarget = await makeStudent("ASD Concurrent Enroll Target");

  await seedDevice(listingActive.profileId, listingActive.authenticator, "ACTIVE");
  await seedDevice(listingRevoked.profileId, listingRevoked.authenticator, "REVOKED");
  await seedDevice(resetTarget.profileId, resetTarget.authenticator, "ACTIVE");
  await seedDevice(identityTarget.profileId, identityTarget.authenticator, "ACTIVE");
  await seedDevice(rollbackTarget.profileId, rollbackTarget.authenticator, "ACTIVE");
  await seedDevice(concurrencyTarget.profileId, concurrencyTarget.authenticator, "ACTIVE");
  await seedDevice(challengeTarget.profileId, challengeTarget.authenticator, "ACTIVE");
  await seedDevice(lifecycleTarget.profileId, lifecycleTarget.authenticator, "ACTIVE");

  const fixtures = [
    listingActive,
    listingNone,
    listingRevoked,
    resetTarget,
    identityTarget,
    rollbackTarget,
    concurrencyTarget,
    challengeTarget,
    lifecycleTarget,
    concurrentEnrollTarget,
  ];
  for (const fixture of fixtures) {
    await pool.query(
      `INSERT INTO course_registrations (student_id, course_offering_id, status)
       VALUES ($1, $2, 'ENROLLED')`,
      [fixture.profileId, offeringId]
    );
  }

  // Only one ACTIVE session may exist per lecturer, so each session needs its own.
  for (let i = 0; i < 4; i++) {
    const sessionLecturer = await pool.query(
      `INSERT INTO users (name, password_hash, role, status)
       VALUES ($1, $2, 'LECTURER', 'ACTIVE') RETURNING id`,
      [`ASD Session Lecturer ${i}`, passwordHash]
    );
    const sessionLecturerUser = Number(sessionLecturer.rows[0].id);
    const sessionLecturerProfile = await pool.query(
      `INSERT INTO lecturers (user_id, staff_id, department_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [sessionLecturerUser, `ASD/LEC/S${i}/${RUN_ID}`, departmentId]
    );
    sessionIds.push(
      Number(
        (
          await pool.query(
            `INSERT INTO attendance_sessions
               (course_offering_id, started_by_lecturer_id, start_time, end_time, late_threshold, status)
             VALUES ($1, $2,
                     now() - interval '1 minute', now() + interval '60 minutes',
                     interval '10 minutes', 'ACTIVE')
             RETURNING id`,
            [offeringId, Number(sessionLecturerProfile.rows[0].id)]
          )
        ).rows[0].id
      )
    );
  }

  // Give every user a session cookie directly (mirrors the login mechanism).
  const userIds = [
    adminUserId,
    studentUserId,
    lecturerUserId,
    ...fixtures.map((fixture) => fixture.userId),
  ];
  for (const userId of userIds) {
    const token = `asd-session-${userId}-${Date.now()}`;
    await pool.query(
      `INSERT INTO sessions (user_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [
        userId,
        hashSessionToken(token),
        new Date(Date.now() + authConfig.sessionLifetimeMs),
      ]
    );
    sessionTokens[userId] = token;
  }

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
  await pool.end();
});

// -----------------------------------------------------------------------
// Authorization
// -----------------------------------------------------------------------

test("ASD authorization: anonymous requests are rejected with 401", async () => {
  assert.equal((await getJson("/api/admin/student-devices")).status, 401);
  assert.equal(
    (await getJson(`/api/admin/students/${listingActive.profileId}/device`)).status,
    401
  );
  assert.equal(
    (
      await postJson(
        `/api/admin/students/${listingActive.profileId}/device/reset`,
        {}
      )
    ).status,
    401
  );
});

test("ASD authorization: student and lecturer accounts are rejected with 403", async () => {
  for (const userId of [studentUserId, lecturerUserId]) {
    const list = await getJson("/api/admin/student-devices", cookieHeader(userId));
    assert.equal(list.status, 403);
    assert.equal(errorCode(await list.json()), "FORBIDDEN");

    const status = await getJson(
      `/api/admin/students/${listingActive.profileId}/device`,
      cookieHeader(userId)
    );
    assert.equal(status.status, 403);

    const reset = await resetViaApi(listingActive.profileId, userId);
    assert.equal(reset.status, 403);
  }
});

test("ASD authorization: an admin can list student devices", async () => {
  const res = await getJson("/api/admin/student-devices", cookieHeader(adminUserId));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[] };
  assert.ok(Array.isArray(body.data));
});

// -----------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------

test("ASD list: exposes safe summary fields and never key/challenge material", async () => {
  const res = await getJson("/api/admin/student-devices", cookieHeader(adminUserId));
  assert.equal(res.status, 200);
  const raw = await res.text();
  for (const forbidden of [
    "credential_public_key",
    "credentialPublicKey",
    "publicKey",
    "challenge",
    "challenge_hash",
    "private",
  ]) {
    assert.ok(
      !raw.includes(forbidden),
      `list payload must not contain secret field "${forbidden}"`
    );
  }

  const body = JSON.parse(raw) as {
    data: Array<{
      studentId: number;
      device: Record<string, unknown> | null;
      hasActiveDevice: boolean;
    }>;
  };

  const active = body.data.find((row) => row.studentId === listingActive.profileId);
  assert.ok(active);
  assert.equal(active!.hasActiveDevice, true);
  assert.equal(active!.device?.status, "ACTIVE");
  assert.ok(!("credential_public_key" in (active!.device ?? {})));

  const none = body.data.find((row) => row.studentId === listingNone.profileId);
  assert.ok(none);
  assert.equal(none!.device, null);
  assert.equal(none!.hasActiveDevice, false);

  const revoked = body.data.find((row) => row.studentId === listingRevoked.profileId);
  assert.ok(revoked);
  assert.equal(revoked!.device?.status, "REVOKED");
  assert.equal(revoked!.hasActiveDevice, false);
});

test("ASD list: filters by matric number, name, and device status", async () => {
  const byMatric = await getJson(
    `/api/admin/student-devices?matricNumber=${encodeURIComponent(listingActive.matric)}`,
    cookieHeader(adminUserId)
  );
  assert.equal(byMatric.status, 200);
  let rows = (await byMatric.json()).data as Array<{ studentId: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].studentId, listingActive.profileId);

  const byName = await getJson(
    "/api/admin/student-devices?studentName=ASD Listing Revoked",
    cookieHeader(adminUserId)
  );
  assert.equal(byName.status, 200);
  rows = (await byName.json()).data as Array<{ studentId: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].studentId, listingRevoked.profileId);

  const activeOnly = await getJson(
    "/api/admin/student-devices?status=ACTIVE",
    cookieHeader(adminUserId)
  );
  assert.equal(activeOnly.status, 200);
  const activeIds = ((await activeOnly.json()).data as Array<{ studentId: number }>).map(
    (row) => row.studentId
  );
  assert.ok(activeIds.includes(listingActive.profileId));
  assert.ok(!activeIds.includes(listingNone.profileId));
  assert.ok(!activeIds.includes(listingRevoked.profileId));

  const revokedOnly = await getJson(
    "/api/admin/student-devices?status=REVOKED",
    cookieHeader(adminUserId)
  );
  assert.equal(revokedOnly.status, 200);
  const revokedIds = (
    (await revokedOnly.json()).data as Array<{ studentId: number }>
  ).map((row) => row.studentId);
  assert.ok(revokedIds.includes(listingRevoked.profileId));
  assert.ok(!revokedIds.includes(listingActive.profileId));

  const noneOnly = await getJson(
    "/api/admin/student-devices?status=NO_DEVICE",
    cookieHeader(adminUserId)
  );
  assert.equal(noneOnly.status, 200);
  const noneIds = ((await noneOnly.json()).data as Array<{ studentId: number }>).map(
    (row) => row.studentId
  );
  assert.ok(noneIds.includes(listingNone.profileId));
  assert.ok(!noneIds.includes(listingActive.profileId));
});

test("ASD list: an invalid status filter is rejected with 400", async () => {
  const res = await getJson(
    "/api/admin/student-devices?status=DELETED",
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 400);
  assert.equal(errorCode(await res.json()), "INVALID_REQUEST");
});

// -----------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------

test("ASD status: reflects active, missing, and revoked device states", async () => {
  const active = await getJson(
    `/api/admin/students/${listingActive.profileId}/device`,
    cookieHeader(adminUserId)
  );
  assert.equal(active.status, 200);
  const activeBody = (await active.json()).data as {
    studentId: number;
    hasActiveDevice: boolean;
    device: { status: string } | null;
  };
  assert.equal(activeBody.studentId, listingActive.profileId);
  assert.equal(activeBody.hasActiveDevice, true);
  assert.equal(activeBody.device?.status, "ACTIVE");

  const none = await getJson(
    `/api/admin/students/${listingNone.profileId}/device`,
    cookieHeader(adminUserId)
  );
  assert.equal(none.status, 200);
  const noneBody = (await none.json()).data as { device: unknown; hasActiveDevice: boolean };
  assert.equal(noneBody.device, null);
  assert.equal(noneBody.hasActiveDevice, false);

  const revoked = await getJson(
    `/api/admin/students/${listingRevoked.profileId}/device`,
    cookieHeader(adminUserId)
  );
  assert.equal(revoked.status, 200);
  const revokedBody = (await revoked.json()).data as {
    hasActiveDevice: boolean;
    device: { status: string } | null;
  };
  assert.equal(revokedBody.device?.status, "REVOKED");
  assert.equal(revokedBody.hasActiveDevice, false);
});

test("ASD status: rejects malformed ids and unknown students", async () => {
  const malformed = await getJson(
    "/api/admin/students/not-a-number/device",
    cookieHeader(adminUserId)
  );
  assert.equal(malformed.status, 400);
  assert.equal(errorCode(await malformed.json()), "INVALID_REQUEST");

  const unknown = await getJson(
    "/api/admin/students/999999999/device",
    cookieHeader(adminUserId)
  );
  assert.equal(unknown.status, 404);
  assert.equal(errorCode(await unknown.json()), "NOT_FOUND");
});

test("ASD status: a non-student user id is not treated as a student", async () => {
  const res = await getJson(
    `/api/admin/students/${lecturerUserId}/device`,
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "NOT_FOUND");
});

// -----------------------------------------------------------------------
// Reset
// -----------------------------------------------------------------------

test("ASD reset: revokes the active device and writes a safe audit entry", async () => {
  const res = await resetViaApi(resetTarget.profileId);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: {
      ok: boolean;
      previousStatus: string;
      device: { id: number; status: string; revoked_at: string | null };
    };
  };
  assert.equal(body.data.ok, true);
  assert.equal(body.data.previousStatus, "ACTIVE");
  assert.equal(body.data.device.status, "REVOKED");
  const deviceId = body.data.device.id;

  const row = await pool.query(
    `SELECT status, revoked_at FROM student_devices WHERE id = $1`,
    [deviceId]
  );
  assert.equal(row.rows[0].status, "REVOKED");
  assert.ok(row.rows[0].revoked_at, "revoked_at must be stamped");

  const activeCount = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [resetTarget.profileId]
  );
  assert.equal(activeCount.rows[0].n, 0, "no ACTIVE device may remain");

  const retained = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices WHERE student_id = $1`,
    [resetTarget.profileId]
  );
  assert.ok(retained.rows[0].n >= 1, "historical device rows must be retained");

  const audit = await pool.query(
    `SELECT user_id, action, entity_type, entity_id, description
     FROM audit_logs
     WHERE action = 'STUDENT_DEVICE_RESET'
       AND entity_type = 'student_devices'
       AND entity_id = $1`,
    [deviceId]
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(Number(audit.rows[0].user_id), adminUserId);
  const description = audit.rows[0].description as string;
  assert.ok(description.includes(resetTarget.matric), "audit must name the student");
  assert.ok(description.includes("previous status ACTIVE"));
  assert.ok(
    !description.includes(
      isoBase64URL.fromBuffer(resetTarget.authenticator.credentialId)
    ),
    "audit must not contain the raw credential id"
  );
  assert.ok(
    !description.includes(
      isoBase64URL.fromBuffer(resetTarget.authenticator.credentialPublicKey)
    ),
    "audit must not contain public key material"
  );
});

test("ASD reset: a student with no active device cannot be reset again", async () => {
  const repeat = await resetViaApi(resetTarget.profileId);
  assert.equal(repeat.status, 409);
  assert.equal(errorCode(await repeat.json()), "CONFLICT");

  const none = await resetViaApi(listingNone.profileId);
  assert.equal(none.status, 409);
  assert.equal(errorCode(await none.json()), "CONFLICT");
});

test("ASD reset: unknown and malformed student ids are rejected", async () => {
  const unknown = await resetViaApi(999999999);
  assert.equal(unknown.status, 404);
  assert.equal(errorCode(await unknown.json()), "NOT_FOUND");

  const malformed = await postJson(
    "/api/admin/students/abc/device/reset",
    {},
    cookieHeader(adminUserId)
  );
  assert.equal(malformed.status, 400);
  assert.equal(errorCode(await malformed.json()), "INVALID_REQUEST");
});

test("ASD reset: client-supplied identity fields cannot override the route identity", async () => {
  const res = await postJson(
    `/api/admin/students/${identityTarget.profileId}/device/reset`,
    {
      studentId: listingActive.profileId,
      adminId: studentUserId,
      previousStatus: "REVOKED",
      status: "ACTIVE",
    },
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { device: { id: number } } };

  const targetRow = await pool.query(
    `SELECT status FROM student_devices WHERE id = $1`,
    [body.data.device.id]
  );
  assert.equal(targetRow.rows[0].status, "REVOKED");

  // The unrelated student named in the body must be untouched.
  const spoofed = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [listingActive.profileId]
  );
  assert.equal(spoofed.rows[0].n, 1, "route identity must win over body identity");
});

test("ASD reset: rolls back entirely when the audit insert fails", async () => {
  await assert.rejects(
    () => resetStudentDevice(999999999, rollbackTarget.profileId),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23503"
  );

  const row = await pool.query(
    `SELECT status, revoked_at FROM student_devices WHERE student_id = $1`,
    [rollbackTarget.profileId]
  );
  assert.equal(row.rows[0].status, "ACTIVE", "rollback must leave the device active");
  assert.equal(row.rows[0].revoked_at, null);

  const audit = await pool.query(
    `SELECT count(*)::int AS n FROM audit_logs
     WHERE action = 'STUDENT_DEVICE_RESET'
       AND entity_id IN (
         SELECT id FROM student_devices WHERE student_id = $1
       )`,
    [rollbackTarget.profileId]
  );
  assert.equal(audit.rows[0].n, 0, "no audit row may survive a rolled-back reset");
});

test("ASD reset: two concurrent resets yield exactly one success", async () => {
  const [first, second] = await Promise.all([
    resetViaApi(concurrencyTarget.profileId),
    resetViaApi(concurrencyTarget.profileId),
  ]);

  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);

  const counts = await pool.query(
    `SELECT status, count(*)::int AS n FROM student_devices
     WHERE student_id = $1 GROUP BY status`,
    [concurrencyTarget.profileId]
  );
  const byStatus = new Map<string, number>(
    counts.rows.map((row) => [row.status as string, row.n as number])
  );
  assert.equal(byStatus.get("ACTIVE") ?? 0, 0, "no ACTIVE device may remain");
  assert.equal(byStatus.get("REVOKED") ?? 0, 1, "exactly one device is revoked");
});

// -----------------------------------------------------------------------
// Challenge invalidation
// -----------------------------------------------------------------------

test("ASD reset: invalidates an outstanding attendance challenge", async () => {
  const { status, challenge } = await requestDeviceChallenge(challengeTarget.userId);
  assert.equal(status, 200);

  const stored = await pool.query(
    `SELECT status FROM student_device_enrollment_challenges
     WHERE student_id = $1 AND challenge_hash = $2`,
    [challengeTarget.profileId, hashSessionToken(challenge)]
  );
  assert.equal(stored.rows[0].status, "ACTIVE");

  const reset = await resetViaApi(challengeTarget.profileId);
  assert.equal(reset.status, 200);

  const afterReset = await pool.query(
    `SELECT status, consumed_at FROM student_device_enrollment_challenges
     WHERE student_id = $1 AND challenge_hash = $2`,
    [challengeTarget.profileId, hashSessionToken(challenge)]
  );
  assert.equal(afterReset.rows[0].status, "EXPIRED");
  assert.ok(afterReset.rows[0].consumed_at);

  const assertion = await buildAssertion(challengeTarget.authenticator, challenge, 2);
  const mark = await markAttendance(
    challengeTarget.userId,
    sessionIds[0],
    challenge,
    assertion
  );
  assert.equal(mark.status, 409);
  assert.equal(errorCode(await mark.json()), "DEVICE_NOT_ACTIVE");

  const records = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_records
     WHERE session_id = $1 AND student_id = $2`,
    [sessionIds[0], challengeTarget.profileId]
  );
  assert.equal(records.rows[0].n, 0, "the revoked device must not mark attendance");
});

test("ASD reset: invalidates an outstanding enrollment challenge", async () => {
  // Re-enroll so the student holds a new ACTIVE device before the second reset.
  await enrollDevice(challengeTarget.userId, "second device");

  const staleChallenge = `asd-stale-enrollment-${RUN_ID}-${Date.now()}`;
  await pool.query(
    `INSERT INTO student_device_enrollment_challenges (student_id, challenge_hash)
     VALUES ($1, $2)`,
    [challengeTarget.profileId, hashSessionToken(staleChallenge)]
  );

  const reset = await resetViaApi(challengeTarget.profileId);
  assert.equal(reset.status, 200);

  const staleRow = await pool.query(
    `SELECT status FROM student_device_enrollment_challenges
     WHERE challenge_hash = $1`,
    [hashSessionToken(staleChallenge)]
  );
  assert.equal(staleRow.rows[0].status, "EXPIRED");

  const freshAuthenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator: freshAuthenticator,
    challenge: staleChallenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const complete = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(challengeTarget.userId)
  );
  assert.equal(complete.status, 400);
  assert.equal(errorCode(await complete.json()), "INVALID_CHALLENGE");

  const activeCount = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [challengeTarget.profileId]
  );
  assert.equal(activeCount.rows[0].n, 0, "the stale challenge must not enroll a device");
});

// -----------------------------------------------------------------------
// Lifecycle: reset -> re-enroll -> attendance
// -----------------------------------------------------------------------

test("ASD reset: a re-enrolled device works while the old device stays revoked", async () => {
  const reset = await resetViaApi(lifecycleTarget.profileId);
  assert.equal(reset.status, 200);

  const newAuthenticator = await enrollDevice(lifecycleTarget.userId, "new phone");

  const { status, challenge } = await requestDeviceChallenge(lifecycleTarget.userId);
  assert.equal(status, 200);

  const assertion = await buildAssertion(newAuthenticator, challenge, 2);
  const mark = await markAttendance(
    lifecycleTarget.userId,
    sessionIds[1],
    challenge,
    assertion
  );
  assert.equal(mark.status, 201);
  const markBody = (await mark.json()) as { data: { status: string } };
  assert.equal(markBody.data.status, "PRESENT");

  const devices = await pool.query(
    `SELECT id, status FROM student_devices WHERE student_id = $1 ORDER BY id`,
    [lifecycleTarget.profileId]
  );
  assert.equal(devices.rowCount, 2, "historical device must be retained");
  assert.equal(devices.rows[0].status, "REVOKED");
  assert.equal(devices.rows[1].status, "ACTIVE");
});

// -----------------------------------------------------------------------
// Concurrency
// -----------------------------------------------------------------------

test("ASD enrollment: concurrent enrollment after reset leaves one active device", async () => {
  const [first, second] = await Promise.all([
    postJson(
      "/api/student/device/enrollment/options",
      {},
      cookieHeader(concurrentEnrollTarget.userId)
    ),
    postJson(
      "/api/student/device/enrollment/options",
      {},
      cookieHeader(concurrentEnrollTarget.userId)
    ),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const firstChallenge = ((await first.json()) as { data: { challenge: string } }).data
    .challenge;
  const secondChallenge = ((await second.json()) as { data: { challenge: string } }).data
    .challenge;

  const firstAuth = await createTestAuthenticator();
  const secondAuth = await createTestAuthenticator();
  const firstCredential = await buildRegistrationResponse({
    authenticator: firstAuth,
    challenge: firstChallenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const secondCredential = await buildRegistrationResponse({
    authenticator: secondAuth,
    challenge: secondChallenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const [firstComplete, secondComplete] = await Promise.all([
    postJson(
      "/api/student/device/enrollment/complete",
      { credential: firstCredential },
      cookieHeader(concurrentEnrollTarget.userId)
    ),
    postJson(
      "/api/student/device/enrollment/complete",
      { credential: secondCredential },
      cookieHeader(concurrentEnrollTarget.userId)
    ),
  ]);

  const successes = [firstComplete.status, secondComplete.status].filter(
    (status) => status === 201
  );
  assert.equal(successes.length, 1, "exactly one concurrent enrollment may succeed");

  const activeCount = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [concurrentEnrollTarget.profileId]
  );
  assert.equal(activeCount.rows[0].n, 1, "the DB must enforce a single ACTIVE device");
});

test("ASD schema: a second ACTIVE device is rejected at the database level", async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO student_devices (student_id, credential_id, credential_public_key)
         VALUES ($1, $2, $3)`,
        [
          listingActive.profileId,
          `asd-second-active-${RUN_ID}`,
          Buffer.from([0xde, 0xad, 0xbe, 0xef]),
        ]
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
  );
});
