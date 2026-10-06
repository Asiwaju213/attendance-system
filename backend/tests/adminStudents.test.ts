import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { PoolClient } from "pg";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { resetStudentRegistration } from "../src/services/adminStudentStore";
import {
  boundDeviceHeaders,
  deviceBindingHeader,
  ensureActiveDiscoverableDevice,
} from "./studentSessionTestHelpers";

/**
 * Admin Student Management (list / detail / status / reset-registration)
 * integration tests.
 *
 * These exercise the real HTTP routes, the real transactional services, and the
 * real database constraints. Every fixture lives under the `ASM` namespace so
 * this file can run alongside the other integration suites without collisions.
 */

const TEST_PASSWORD = "asm-student-password";
const NEW_PASSWORD = "asm-new-password-2";
const RUN_ID = Date.now().toString(36).toUpperCase();
const MATRIC_PREFIX = "ASM/STU";

interface StudentFixture {
  userId: number;
  profileId: number;
  matric: string;
}

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturerUserId = 0;

let departmentAId = 0;
let departmentBId = 0;
let level100Id = 0;
let level200Id = 0;
let offeringAId = 0;
let offeringBId = 0;
let attendanceSessionId = 0;

let listActive: StudentFixture;
let listPending: StudentFixture;
let listInactive: StudentFixture;
let listMulti: StudentFixture;
let deactivateTarget: StudentFixture;
let reactivateTarget: StudentFixture;
let pendingActivateTarget: StudentFixture;
let noopTarget: StudentFixture;
let resetTarget: StudentFixture;
let alreadyPendingTarget: StudentFixture;
let resetSmuggleTarget: StudentFixture;
let resetSecretsTarget: StudentFixture;
let resetConcurrencyTarget: StudentFixture;
let lifecycleTarget: StudentFixture;

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

async function patchJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return fetch(baseUrl + path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function errorCode(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

async function patchStatus(
  studentId: number,
  status: string,
  userId = adminUserId
) {
  return patchJson(
    `/api/admin/students/${studentId}/status`,
    { status },
    cookieHeader(userId)
  );
}

async function resetViaApi(studentId: number, userId = adminUserId) {
  return postJson(
    `/api/admin/students/${studentId}/reset-registration`,
    {},
    cookieHeader(userId)
  );
}

async function seedDevice(
  profileId: number,
  credentialId: string,
  status = "ACTIVE"
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, status, discoverable)
     VALUES ($1, $2, $3, 1, $4, TRUE)
     RETURNING id`,
    [profileId, credentialId, Buffer.from([0xde, 0xad, 0xbe, 0xef]), status]
  );
  return Number(result.rows[0].id);
}

async function cleanupFixtures(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASM/%')
        OR session_id IN (
             SELECT id FROM attendance_sessions
             WHERE started_by_lecturer_id IN (
               SELECT id FROM lecturers WHERE staff_id LIKE 'ASM/%'
             )
           )`
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE staff_id LIKE 'ASM/%'
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASM/%')
        OR course_offering_id IN (
             SELECT id FROM course_offerings
             WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ASM-%')
           )`
  );
  await pool.query(
    `DELETE FROM audit_logs
     WHERE user_id IN (
             SELECT id FROM users WHERE name LIKE 'ASM %' OR username LIKE 'ASM_%'
           )
        OR (entity_type = 'users' AND entity_id IN (
              SELECT id FROM users WHERE name LIKE 'ASM %' OR username LIKE 'ASM_%'
            ))`
  );
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASM/%')`
  );
  await pool.query(
    `DELETE FROM student_registration_challenges
     WHERE user_id IN (
       SELECT id FROM users WHERE name LIKE 'ASM %' OR username LIKE 'ASM_%'
     )`
  );
  await pool.query(
    `DELETE FROM student_device_enrollment_grants
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASM/%')`
  );
  await pool.query(
    `DELETE FROM student_devices
     WHERE student_id IN (SELECT id FROM students WHERE matric_number LIKE 'ASM/%')`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ASM-%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ASM-%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ASM-%'`);
  await pool.query(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT id FROM users WHERE name LIKE 'ASM %' OR username LIKE 'ASM_%'
     )`
  );
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'ASM/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'ASM/%'`);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'ASM %' OR username LIKE 'ASM_%'`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ASM-%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ASM-%'`);
}

before(async () => {
  await cleanupFixtures();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    [`ASM Faculty ${RUN_ID}`, `ASM-FAC-${RUN_ID}`]
  );
  const facultyId = Number(fac.rows[0].id);

  const depA = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`ASM Department A ${RUN_ID}`, `ASM-DEPA-${RUN_ID}`, facultyId]
  );
  departmentAId = Number(depA.rows[0].id);

  const depB = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`ASM Department B ${RUN_ID}`, `ASM-DEPB-${RUN_ID}`, facultyId]
  );
  departmentBId = Number(depB.rows[0].id);

  const level100 = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level100.rows[0].id);
  const level200 = await pool.query(`SELECT id FROM levels WHERE name = 200`);
  level200Id = Number(level200.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ($1, true) RETURNING id`,
    [`ASM-ACAD-${RUN_ID}`]
  );
  const academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  const semesterId = Number(sem.rows[0].id);

  const courseA = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
     VALUES ($1, 'ASM Course A', $2, $3, 'ACTIVE') RETURNING id`,
    [`ASM-C-A-${RUN_ID}`, facultyId, level100Id]
  );
  const courseAId = Number(courseA.rows[0].id);

  const courseB = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
     VALUES ($1, 'ASM Course B', $2, $3, 'ACTIVE') RETURNING id`,
    [`ASM-C-B-${RUN_ID}`, facultyId, level100Id]
  );
  const courseBId = Number(courseB.rows[0].id);

  const offeringA = await pool.query(
    `INSERT INTO course_offerings
       (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'OPEN') RETURNING id`,
    [courseAId, academicSessionId, semesterId]
  );
  offeringAId = Number(offeringA.rows[0].id);

  const offeringB = await pool.query(
    `INSERT INTO course_offerings
       (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'OPEN') RETURNING id`,
    [courseBId, academicSessionId, semesterId]
  );
  offeringBId = Number(offeringB.rows[0].id);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ASM Admin', $1, 'ADMIN', 'ACTIVE', 'ASM_ADMIN_' || $2) RETURNING id`,
    [passwordHash, RUN_ID]
  );
  adminUserId = Number(admin.rows[0].id);

  const lecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ('ASM Lecturer', $1, 'LECTURER', 'ACTIVE') RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturerUserId, `ASM/LEC/${RUN_ID}`, departmentAId]
  );

  const forbiddenStudent = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ('ASM Forbidden Student', $1, 'STUDENT', 'ACTIVE') RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(forbiddenStudent.rows[0].id);

  const sessionLecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ('ASM Session Lecturer', $1, 'LECTURER', 'ACTIVE') RETURNING id`,
    [passwordHash]
  );
  const sessionLecturerUser = Number(sessionLecturer.rows[0].id);
  const sessionLecturerProfile = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [sessionLecturerUser, `ASM/LEC/S/${RUN_ID}`, departmentAId]
  );
  const sessionId = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2,
             now() - interval '2 hours', now() - interval '1 hour',
             interval '10 minutes', 'ENDED', now() - interval '1 hour')
     RETURNING id`,
    [offeringAId, Number(sessionLecturerProfile.rows[0].id)]
  );
  attendanceSessionId = Number(sessionId.rows[0].id);

  let matricSeq = 0;
  async function makeStudent(
    name: string,
    status: "ACTIVE" | "INACTIVE" | "PENDING",
    departmentId: number,
    levelId: number,
    hasPassword: boolean
  ): Promise<StudentFixture> {
    matricSeq += 1;
    const matric = `${MATRIC_PREFIX}/${RUN_ID}/${String(matricSeq).padStart(2, "0")}`;
    const user = await pool.query(
      `INSERT INTO users (name, password_hash, role, status)
       VALUES ($1, $2, 'STUDENT', $3) RETURNING id`,
      [name, hasPassword ? passwordHash : null, status]
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
    };
  }

  listActive = await makeStudent("ASM List Active", "ACTIVE", departmentAId, level100Id, true);
  listPending = await makeStudent("ASM List Pending", "PENDING", departmentAId, level100Id, false);
  listInactive = await makeStudent("ASM List Inactive", "INACTIVE", departmentBId, level200Id, true);
  listMulti = await makeStudent("ASM List Multi", "ACTIVE", departmentAId, level100Id, true);
  deactivateTarget = await makeStudent("ASM Deactivate Target", "ACTIVE", departmentAId, level100Id, true);
  reactivateTarget = await makeStudent("ASM Reactivate Target", "INACTIVE", departmentAId, level100Id, true);
  pendingActivateTarget = await makeStudent("ASM Pending Activate Target", "PENDING", departmentAId, level100Id, false);
  noopTarget = await makeStudent("ASM Noop Target", "INACTIVE", departmentAId, level100Id, true);
  resetTarget = await makeStudent("ASM Reset Target", "ACTIVE", departmentAId, level100Id, true);
  alreadyPendingTarget = await makeStudent("ASM Already Pending", "PENDING", departmentAId, level100Id, false);
  resetSmuggleTarget = await makeStudent("ASM Reset Smuggle Target", "ACTIVE", departmentAId, level100Id, true);
  resetSecretsTarget = await makeStudent("ASM Reset Secrets Target", "ACTIVE", departmentAId, level100Id, true);
  resetConcurrencyTarget = await makeStudent("ASM Reset Concurrency", "ACTIVE", departmentAId, level100Id, true);
  lifecycleTarget = await makeStudent("ASM Lifecycle Target", "ACTIVE", departmentAId, level100Id, true);

  await seedDevice(listActive.profileId, `asm-dev-active-${RUN_ID}`, "ACTIVE");
  await seedDevice(listMulti.profileId, `asm-dev-revoked-${RUN_ID}`, "REVOKED");
  await seedDevice(deactivateTarget.profileId, `asm-dev-deactivate-${RUN_ID}`, "ACTIVE");
  await seedDevice(resetTarget.profileId, `asm-dev-reset-${RUN_ID}`, "ACTIVE");
  await seedDevice(resetSmuggleTarget.profileId, `asm-dev-smuggle-${RUN_ID}`, "ACTIVE");
  await seedDevice(resetSecretsTarget.profileId, `asm-dev-secrets-${RUN_ID}`, "ACTIVE");
  await seedDevice(resetConcurrencyTarget.profileId, `asm-dev-conc-${RUN_ID}`, "ACTIVE");
  await seedDevice(lifecycleTarget.profileId, `asm-dev-lifecycle-${RUN_ID}`, "ACTIVE");

  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED')`,
    [listActive.profileId, offeringAId]
  );
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED')`,
    [listMulti.profileId, offeringAId]
  );
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED')`,
    [listMulti.profileId, offeringBId]
  );
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED')`,
    [deactivateTarget.profileId, offeringAId]
  );
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED')`,
    [resetTarget.profileId, offeringAId]
  );

  await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status)
     VALUES ($1, $2, 'PRESENT')`,
    [attendanceSessionId, deactivateTarget.profileId]
  );

  await pool.query(
    `INSERT INTO student_registration_challenges (user_id, challenge_token_hash)
     VALUES ($1, $2)`,
    [resetTarget.userId, hashSessionToken(`asm-reg-challenge-${RUN_ID}`)]
  );
  await pool.query(
    `INSERT INTO student_registration_challenges (user_id, challenge_token_hash)
     VALUES ($1, $2)`,
    [resetConcurrencyTarget.userId, hashSessionToken(`asm-reg-conc-${RUN_ID}`)]
  );

  await pool.query(
    `INSERT INTO student_device_enrollment_challenges (student_id, challenge_hash)
     VALUES ($1, $2)`,
    [resetTarget.profileId, hashSessionToken(`asm-dev-challenge-${RUN_ID}`)]
  );

  const userIds = [
    adminUserId,
    studentUserId,
    lecturerUserId,
    listActive.userId,
    listPending.userId,
    listInactive.userId,
    listMulti.userId,
    deactivateTarget.userId,
    reactivateTarget.userId,
    pendingActivateTarget.userId,
    noopTarget.userId,
    resetTarget.userId,
    alreadyPendingTarget.userId,
    resetSmuggleTarget.userId,
    resetSecretsTarget.userId,
    resetConcurrencyTarget.userId,
    lifecycleTarget.userId,
  ];
  for (const userId of userIds) {
    const token = `asm-session-${userId}-${Date.now()}`;
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

function assertNoSensitiveMaterial(raw: string): void {
  for (const forbidden of [
    "password_hash",
    "passwordHash",
    "publicKey",
    "credential_public_key",
    "credentialPublicKey",
    "challenge",
    "challenge_hash",
    "sessionTokenHash",
    "session_token_hash",
    "credential_public_key",
    "token",
  ]) {
    assert.ok(
      !raw.includes(forbidden),
      `payload must not contain secret field "${forbidden}"`
    );
  }
}

// -----------------------------------------------------------------------
// Authorization
// -----------------------------------------------------------------------

test("ASM authorization: anonymous requests are rejected with 401", async () => {
  assert.equal((await getJson("/api/admin/students")).status, 401);
  assert.equal(
    (await getJson(`/api/admin/students/${listActive.profileId}`)).status,
    401
  );
  assert.equal(
    (
      await patchJson(`/api/admin/students/${listActive.profileId}/status`, {
        status: "INACTIVE",
      })
    ).status,
    401
  );
  assert.equal(
    (
      await postJson(
        `/api/admin/students/${listActive.profileId}/reset-registration`,
        {}
      )
    ).status,
    401
  );
});

test("ASM authorization: student and lecturer accounts are rejected with 403", async () => {
  for (const userId of [studentUserId, lecturerUserId]) {
    const list = await getJson("/api/admin/students", cookieHeader(userId));
    assert.equal(list.status, 403);
    assert.equal(errorCode(await list.json()), "FORBIDDEN");

    const detail = await getJson(
      `/api/admin/students/${listActive.profileId}`,
      cookieHeader(userId)
    );
    assert.equal(detail.status, 403);

    const status = await patchStatus(listActive.profileId, "INACTIVE", userId);
    assert.equal(status.status, 403);

    const reset = await resetViaApi(listActive.profileId, userId);
    assert.equal(reset.status, 403);
  }
});

// -----------------------------------------------------------------------
// List
// -----------------------------------------------------------------------

test("ASM list: admin can list students with safe fields", async () => {
  const res = await getJson("/api/admin/students", cookieHeader(adminUserId));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: {
      items: Array<{
        studentId: number;
        userId: number;
        name: string;
        matricNumber: string;
        status: string;
        registeredCourseCount: number;
        hasActiveDevice: boolean;
        createdAt: string;
      }>;
      total: number;
    };
  };
  assert.ok(Array.isArray(body.data.items));
  assert.equal(body.data.total, body.data.items.length);
  assert.ok(body.data.items.length >= 4, "the seeded students must appear");

  const item = body.data.items.find(
    (row) => row.studentId === listActive.profileId
  );
  assert.ok(item);
  assert.ok(item!.userId > 0);
  assert.equal(item!.matricNumber, listActive.matric);
  assert.ok(!Number.isNaN(Date.parse(item!.createdAt)));

  const raw = await (await getJson("/api/admin/students", cookieHeader(adminUserId)))
    .text();
  assertNoSensitiveMaterial(raw);
});

test("ASM list: filters by matric number", async () => {
  const res = await getJson(
    `/api/admin/students?matricNumber=${encodeURIComponent(listActive.matric)}`,
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { items: Array<{ studentId: number }> };
  };
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].studentId, listActive.profileId);
});

test("ASM list: filters by name", async () => {
  const res = await getJson(
    "/api/admin/students?name=ASM List Multi",
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { items: Array<{ studentId: number }> };
  };
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].studentId, listMulti.profileId);
});

test("ASM list: filters by department", async () => {
  const res = await getJson(
    `/api/admin/students?departmentId=${departmentAId}`,
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { items: Array<{ studentId: number }> };
  };
  const ids = body.data.items.map((row) => row.studentId);
  assert.ok(ids.includes(listActive.profileId));
  assert.ok(ids.includes(listMulti.profileId));
  assert.ok(!ids.includes(listInactive.profileId), "dept B student must be excluded");
});

test("ASM list: filters by level", async () => {
  const res = await getJson(
    `/api/admin/students?levelId=${level200Id}`,
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { items: Array<{ studentId: number }> };
  };
  const ids = body.data.items.map((row) => row.studentId);
  assert.ok(ids.includes(listInactive.profileId));
  assert.ok(!ids.includes(listActive.profileId), "level 100 student must be excluded");
});

test("ASM list: filters by status", async () => {
  const res = await getJson(
    "/api/admin/students?status=PENDING",
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { items: Array<{ studentId: number; status: string }>; total: number };
  };
  assert.equal(body.data.total, body.data.items.length);
  const ids = body.data.items.map((row) => row.studentId);
  assert.ok(ids.includes(listPending.profileId));
  assert.ok(ids.includes(pendingActivateTarget.profileId));
  assert.ok(!ids.includes(listActive.profileId));

  const active = await getJson(
    "/api/admin/students?status=ACTIVE",
    cookieHeader(adminUserId)
  );
  const activeIds = ((await active.json()) as {
    data: { items: Array<{ studentId: number }> };
  }).data.items.map((row) => row.studentId);
  assert.ok(activeIds.includes(listActive.profileId));
  assert.ok(activeIds.includes(listMulti.profileId));
  assert.ok(!activeIds.includes(listPending.profileId));

  const inactive = await getJson(
    "/api/admin/students?status=INACTIVE",
    cookieHeader(adminUserId)
  );
  const inactiveIds = ((await inactive.json()) as {
    data: { items: Array<{ studentId: number }> };
  }).data.items.map((row) => row.studentId);
  assert.ok(inactiveIds.includes(listInactive.profileId));
  assert.ok(inactiveIds.includes(noopTarget.profileId));
  assert.ok(!inactiveIds.includes(listActive.profileId));
});

test("ASM list: enrolled-course count only counts ENROLLED registrations", async () => {
  const res = await getJson("/api/admin/students", cookieHeader(adminUserId));
  const body = (await res.json()) as {
    data: { items: Array<{ studentId: number; registeredCourseCount: number }> };
  };
  const byId = new Map(
    body.data.items.map((row) => [row.studentId, row.registeredCourseCount])
  );
  assert.equal(byId.get(listMulti.profileId), 2);
  assert.equal(byId.get(listActive.profileId), 1);
  assert.equal(byId.get(listPending.profileId), 0);
});

test("ASM list: active-device indicator reflects an ACTIVE device", async () => {
  const res = await getJson("/api/admin/students", cookieHeader(adminUserId));
  const body = (await res.json()) as {
    data: { items: Array<{ studentId: number; hasActiveDevice: boolean }> };
  };
  const byId = new Map(
    body.data.items.map((row) => [row.studentId, row.hasActiveDevice])
  );
  assert.equal(byId.get(listActive.profileId), true);
  assert.equal(byId.get(listMulti.profileId), false);
  assert.equal(byId.get(listPending.profileId), false);
});

test("ASM list: no cross-student data leakage", async () => {
  const res = await getJson(
    `/api/admin/students?matricNumber=${encodeURIComponent(listActive.matric)}`,
    cookieHeader(adminUserId)
  );
  const body = (await res.json()) as { data: { items: Array<{ studentId: number }> } };
  const ids = body.data.items.map((row) => row.studentId);
  assert.deepEqual(ids, [listActive.profileId]);
});

// -----------------------------------------------------------------------
// Detail
// -----------------------------------------------------------------------

test("ASM detail: admin can retrieve a student detail with faculty and device", async () => {
  const res = await getJson(
    `/api/admin/students/${listActive.profileId}`,
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: {
      studentId: number;
      userId: number;
      matricNumber: string;
      status: string;
      registeredCourseCount: number;
      hasActiveDevice: boolean;
      faculty: { id: number; name: string; code: string };
      department: { id: number; name: string; code: string };
      level: { id: number; name: number };
      device: { id: number; credentialId: string; status: string } | null;
    };
  };
  assert.equal(body.data.studentId, listActive.profileId);
  assert.equal(body.data.matricNumber, listActive.matric);
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(body.data.registeredCourseCount, 1);
  assert.equal(body.data.hasActiveDevice, true);
  assert.ok(body.data.faculty.id > 0);
  assert.ok(body.data.department.id > 0);
  assert.equal(body.data.level.name, 100);
  assert.ok(body.data.device);
  assert.equal(body.data.device!.status, "ACTIVE");
  assert.ok(body.data.device!.credentialId.length > 0);
});

test("ASM detail: unknown student returns 404", async () => {
  const res = await getJson(
    "/api/admin/students/999999999",
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "NOT_FOUND");
});

test("ASM detail: student and lecturer callers are denied", async () => {
  for (const userId of [studentUserId, lecturerUserId]) {
    const res = await getJson(
      `/api/admin/students/${listActive.profileId}`,
      cookieHeader(userId)
    );
    assert.equal(res.status, 403);
  }
});

test("ASM detail: credential material is never returned", async () => {
  const raw = await (
    await getJson(`/api/admin/students/${listActive.profileId}`, cookieHeader(adminUserId))
  ).text();
  assertNoSensitiveMaterial(raw);
});

// -----------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------

test("ASM status: ACTIVE -> INACTIVE disables the account immediately", async () => {
  const res = await patchStatus(deactivateTarget.profileId, "INACTIVE");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { status: string; studentId: number };
  };
  assert.equal(body.data.studentId, deactivateTarget.profileId);
  assert.equal(body.data.status, "INACTIVE");

  const row = await pool.query(
    `SELECT status FROM users WHERE id = $1`,
    [deactivateTarget.userId]
  );
  assert.equal(row.rows[0].status, "INACTIVE");

  const me = await getJson("/api/auth/me", cookieHeader(deactivateTarget.userId));
  assert.equal(me.status, 401, "a deactivated student must be locked out");
});

test("ASM status: INACTIVE -> ACTIVE restores authentication", async () => {
  const res = await patchStatus(reactivateTarget.profileId, "ACTIVE");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { status: string } };
  assert.equal(body.data.status, "ACTIVE");

  const login = await postJson(
    "/api/auth/student/login",
    {
      matricNumber: reactivateTarget.matric,
      password: TEST_PASSWORD,
    },
    await boundDeviceHeaders(reactivateTarget.matric)
  );
  assert.equal(login.status, 200);
});

test("ASM status: a PENDING student cannot be directly activated", async () => {
  const res = await patchStatus(pendingActivateTarget.profileId, "ACTIVE");
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "ACTIVE_REQUIRES_PASSWORD");

  const row = await pool.query(
    `SELECT status, password_hash FROM users WHERE id = $1`,
    [pendingActivateTarget.userId]
  );
  assert.equal(row.rows[0].status, "PENDING");
  assert.equal(row.rows[0].password_hash, null);
});

test("ASM status: unknown status values are rejected", async () => {
  for (const status of ["DELETED", "PENDING"]) {
    const res = await patchStatus(noopTarget.profileId, status);
    assert.equal(res.status, 400);
    assert.equal(errorCode(await res.json()), "INVALID_REQUEST");
  }
});

test("ASM status: unknown request fields are rejected", async () => {
  const res = await patchJson(
    `/api/admin/students/${listActive.profileId}/status`,
    {
      status: "ACTIVE",
      studentId: resetTarget.profileId,
      userId: resetTarget.userId,
      previousStatus: "PENDING",
      adminId: 1,
      passwordHash: "ignore-me",
    },
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 400);
  assert.equal(errorCode(await res.json()), "INVALID_REQUEST");
});

test("ASM status: a non-student target is rejected", async () => {
  const res = await patchStatus(lecturerUserId, "INACTIVE");
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "NOT_FOUND");
});

test("ASM status: no-op change follows the established no-op convention", async () => {
  const res = await patchStatus(noopTarget.profileId, "INACTIVE");
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "NO_OP_CORRECTION");

  const row = await pool.query(`SELECT status FROM users WHERE id = $1`, [
    noopTarget.userId,
  ]);
  assert.equal(row.rows[0].status, "INACTIVE");
});

test("ASM status: writes a STUDENT_STATUS_CHANGE audit log", async () => {
  const audit = await pool.query(
    `SELECT user_id, action, entity_type, entity_id, description
     FROM audit_logs
     WHERE action = 'STUDENT_STATUS_CHANGE'
       AND entity_type = 'users'
       AND entity_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [deactivateTarget.userId]
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(Number(audit.rows[0].user_id), adminUserId);
  const description = audit.rows[0].description as string;
  assert.ok(description.includes(deactivateTarget.matric));
  assert.ok(description.includes("ASM Deactivate Target"));
  assert.ok(description.includes("ACTIVE"));
  assert.ok(description.includes("INACTIVE"));
});

test("ASM status: historical registrations, devices, and attendance remain intact", async () => {
  const regs = await pool.query(
    `SELECT count(*)::int AS n FROM course_registrations
     WHERE student_id = $1 AND status = 'ENROLLED'`,
    [deactivateTarget.profileId]
  );
  assert.equal(regs.rows[0].n, 1, "course registrations must survive deactivation");

  const devices = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [deactivateTarget.profileId]
  );
  assert.equal(devices.rows[0].n, 1, "active device must survive deactivation");

  const attendance = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_records
     WHERE student_id = $1`,
    [deactivateTarget.profileId]
  );
  assert.equal(attendance.rows[0].n, 1, "attendance history must survive deactivation");
});

// -----------------------------------------------------------------------
// Registration reset
// -----------------------------------------------------------------------

test("ASM reset: an active student is reset to PENDING with a NULL password", async () => {
  const res = await resetViaApi(resetTarget.profileId);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: {
      ok: boolean;
      studentId: number;
      userId: number;
      name: string;
      matricNumber: string;
      previousStatus: string;
      status: string;
    };
  };
  assert.equal(body.data.ok, true);
  assert.equal(body.data.studentId, resetTarget.profileId);
  assert.equal(body.data.previousStatus, "ACTIVE");
  assert.equal(body.data.status, "PENDING");

  const row = await pool.query(
    `SELECT status, password_hash FROM users WHERE id = $1`,
    [resetTarget.userId]
  );
  assert.equal(row.rows[0].status, "PENDING");
  assert.equal(row.rows[0].password_hash, null, "the password hash must be cleared");
});

test("ASM reset: active registration and device-enrollment challenges are expired", async () => {
  const reg = await pool.query(
    `SELECT status, consumed_at FROM student_registration_challenges
     WHERE challenge_token_hash = $1`,
    [hashSessionToken(`asm-reg-challenge-${RUN_ID}`)]
  );
  assert.equal(reg.rows[0].status, "EXPIRED");
  assert.ok(reg.rows[0].consumed_at);

  const dev = await pool.query(
    `SELECT status, consumed_at FROM student_device_enrollment_challenges
     WHERE challenge_hash = $1`,
    [hashSessionToken(`asm-dev-challenge-${RUN_ID}`)]
  );
  assert.equal(dev.rows[0].status, "EXPIRED");
  assert.ok(dev.rows[0].consumed_at);
});

test("ASM reset: the active WebAuthn device is NOT revoked", async () => {
  const devices = await pool.query(
    `SELECT status, revoked_at FROM student_devices
     WHERE student_id = $1`,
    [resetTarget.profileId]
  );
  assert.equal(devices.rows[0].status, "ACTIVE", "device must stay ACTIVE");
  assert.equal(devices.rows[0].revoked_at, null);
});

test("ASM reset: writes a STUDENT_REGISTRATION_RESET audit log", async () => {
  const audit = await pool.query(
    `SELECT user_id, action, entity_type, entity_id, description
     FROM audit_logs
     WHERE action = 'STUDENT_REGISTRATION_RESET'
       AND entity_type = 'users'
       AND entity_id = $1`,
    [resetTarget.userId]
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(Number(audit.rows[0].user_id), adminUserId);
  const description = audit.rows[0].description as string;
  assert.ok(description.includes(resetTarget.matric));
  assert.ok(description.includes("ASM Reset Target"));
  assert.ok(description.includes("ACTIVE"));
});

test("ASM reset: an already-PENDING student gets a conflict and is untouched", async () => {
  const res = await resetViaApi(alreadyPendingTarget.profileId);
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "ALREADY_PENDING");

  const row = await pool.query(
    `SELECT status, password_hash FROM users WHERE id = $1`,
    [alreadyPendingTarget.userId]
  );
  assert.equal(row.rows[0].status, "PENDING");
  assert.equal(row.rows[0].password_hash, null);

  const audit = await pool.query(
    `SELECT count(*)::int AS n FROM audit_logs
     WHERE action = 'STUDENT_REGISTRATION_RESET'
       AND entity_id = $1`,
    [alreadyPendingTarget.userId]
  );
  assert.equal(audit.rows[0].n, 0, "no audit row may be written for a refused reset");
});

test("ASM reset: unknown student returns 404", async () => {
  const res = await resetViaApi(999999999);
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "NOT_FOUND");
});

test("ASM reset: a non-student target is rejected", async () => {
  const res = await resetViaApi(lecturerUserId);
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "NOT_FOUND");
});

test("ASM reset: two concurrent resets yield exactly one success", async () => {
  const [first, second] = await Promise.all([
    resetViaApi(resetConcurrencyTarget.profileId),
    resetViaApi(resetConcurrencyTarget.profileId),
  ]);

  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);

  const row = await pool.query(
    `SELECT status, password_hash FROM users WHERE id = $1`,
    [resetConcurrencyTarget.userId]
  );
  assert.equal(row.rows[0].status, "PENDING");
  assert.equal(row.rows[0].password_hash, null);

  const audit = await pool.query(
    `SELECT count(*)::int AS n FROM audit_logs
     WHERE action = 'STUDENT_REGISTRATION_RESET'
       AND entity_id = $1`,
    [resetConcurrencyTarget.userId]
  );
  assert.equal(audit.rows[0].n, 1, "exactly one audit entry must survive the race");
});

test("ASM reset: does not acquire a second pool connection during its transaction", async () => {
  // Production connects through a connection string (DATABASE_URL set), where the
  // default pool size is 1. The reset holds that only client inside its
  // transaction, so the admin-name lookup must run on the same client; if it
  // asked the pool for a second connection the checkout would time out
  // ("timeout exceeded when trying to connect"). This instruments the pool to
  // fail such an acquisition and drives the service directly.
  const created = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, $2, 'STUDENT', 'ACTIVE') RETURNING id`,
    [`ASM Reset NoSecondConn ${RUN_ID}`, passwordHash]
  );
  const userId = Number(created.rows[0].id);
  const profile = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, `ASM/STU/NO2CONN-${RUN_ID}`, departmentAId, level100Id]
  );
  const profileId = Number(profile.rows[0].id);

  type Instrumented = {
    connect: (...args: unknown[]) => Promise<PoolClient>;
    query: (...args: unknown[]) => unknown;
  };
  const instrumented = pool as unknown as Instrumented;
  const originalConnect = instrumented.connect.bind(pool);
  const originalQuery = instrumented.query.bind(pool);
  let checkedOut = 0;

  try {
    instrumented.connect = async (...args: unknown[]) => {
      const client = await originalConnect(...args);
      checkedOut += 1;
      const originalRelease = client.release.bind(client);
      client.release = () => {
        checkedOut -= 1;
        originalRelease();
      };
      return client;
    };
    instrumented.query = async (...args: unknown[]) => {
      if (checkedOut > 0) {
        throw new Error(
          "pool.query was called while the reset transaction held the only client"
        );
      }
      return originalQuery(...args);
    };

    const result = await resetStudentRegistration(adminUserId, profileId);
    assert.equal(result.ok, true, "the reset must succeed with a single connection");
    assert.equal(checkedOut, 0, "the transaction client must be released afterwards");
  } finally {
    instrumented.connect = originalConnect;
    instrumented.query = originalQuery;
  }

  const row = await pool.query(
    `SELECT status, password_hash FROM users WHERE id = $1`,
    [userId]
  );
  assert.equal(row.rows[0].status, "PENDING");
  assert.equal(row.rows[0].password_hash, null);
});

test("ASM reset: never exposes secrets in the response", async () => {
  const smuggleRes = await resetViaApi(resetSecretsTarget.profileId);
  assert.equal(smuggleRes.status, 200);
  const raw = await smuggleRes.text();
  assertNoSensitiveMaterial(raw);
});

test("ASM reset: client-supplied identity fields cannot override the route identity", async () => {
  const res = await postJson(
    `/api/admin/students/${resetSmuggleTarget.profileId}/reset-registration`,
    {
      studentId: listActive.profileId,
      userId: listActive.userId,
      password: "should-not-be-set",
      challengeToken: "should-not-exist",
    },
    cookieHeader(adminUserId)
  );
  assert.equal(res.status, 200);

  const targetRow = await pool.query(
    `SELECT status FROM users WHERE id = $1`,
    [resetSmuggleTarget.userId]
  );
  assert.equal(targetRow.rows[0].status, "PENDING", "route identity must win");

  const spoofed = await pool.query(
    `SELECT status FROM users WHERE id = $1`,
    [listActive.userId]
  );
  assert.equal(spoofed.rows[0].status, "ACTIVE", "the unrelated student must be untouched");
});

// -----------------------------------------------------------------------
// Lifecycle: reset -> re-register -> login
// -----------------------------------------------------------------------

test("ASM lifecycle: reset -> PENDING -> reject login -> re-register -> ACTIVE on the same device", async () => {
  const staleCredentialId = await ensureActiveDiscoverableDevice(lifecycleTarget.matric);
  const beforeLogin = await postJson(
    "/api/auth/student/login",
    {
      matricNumber: lifecycleTarget.matric,
      password: TEST_PASSWORD,
    },
    deviceBindingHeader(staleCredentialId)
  );
  assert.equal(beforeLogin.status, 200, "the active student can log in before reset");

  const reset = await resetViaApi(lifecycleTarget.profileId);
  assert.equal(reset.status, 200);

  // The reset returns the account to PENDING, so the enrolled device can no longer be used to
  // sign in. The revoked credential id is reused deliberately: asking the shared helper for an
  // ACTIVE device here would silently create a fresh one and hide the regression.
  const staleDeviceLogin = await postJson(
    "/api/auth/student/login",
    {
      matricNumber: lifecycleTarget.matric,
      password: TEST_PASSWORD,
    },
    deviceBindingHeader(staleCredentialId)
  );
  assert.notEqual(
    staleDeviceLogin.status,
    200,
    "the revoked device must not be able to log in after a reset"
  );

  const rejectedLogin = await postJson("/api/auth/student/login", {
    matricNumber: lifecycleTarget.matric,
    password: TEST_PASSWORD,
  });
  assert.equal(rejectedLogin.status, 401, "the reset student cannot log in");

  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: lifecycleTarget.matric,
  });
  assert.equal(verify.status, 200);
  const verifyBody = (await verify.json()) as { data: { challengeToken: string } };
  assert.ok(verifyBody.data.challengeToken.length > 0);

  const complete = await postJson("/api/auth/student/register/complete", {
    challengeToken: verifyBody.data.challengeToken,
    password: NEW_PASSWORD,
  });
  assert.equal(complete.status, 201, "the reset student can re-register");

  const row = await pool.query(
    `SELECT status, password_hash FROM users WHERE id = $1`,
    [lifecycleTarget.userId]
  );
  assert.equal(row.rows[0].status, "ACTIVE");
  assert.ok(
    row.rows[0].password_hash !== null && row.rows[0].password_hash !== "",
    "the new password hash must be set"
  );

  const newLogin = await postJson(
    "/api/auth/student/login",
    {
      matricNumber: lifecycleTarget.matric,
      password: NEW_PASSWORD,
    },
    deviceBindingHeader(staleCredentialId)
  );
  assert.equal(newLogin.status, 200, "the new password must work on the enrolled device");
  const newLoginBody = (await newLogin.json()) as { user: Record<string, unknown> };
  assert.equal(newLoginBody.user.matricNumber, lifecycleTarget.matric);

  // A registration reset returns the account to the unclaimed state; it is not a device reset.
  // The enrolled device therefore stays authoritative, and re-registering must not become a way
  // to mint a session from a different device.
  const unboundAfterReregister = await postJson("/api/auth/student/login", {
    matricNumber: lifecycleTarget.matric,
    password: NEW_PASSWORD,
  });
  assert.equal(
    unboundAfterReregister.status,
    409,
    "re-registering must not bypass the enrolled device"
  );
  const unboundBody = (await unboundAfterReregister.json()) as { error: string };
  assert.equal(unboundBody.error, "DEVICE_ALREADY_ENROLLED");

  const oldLogin = await postJson("/api/auth/student/login", {
    matricNumber: lifecycleTarget.matric,
    password: TEST_PASSWORD,
  });
  assert.equal(oldLogin.status, 401, "the old password must no longer work");
});