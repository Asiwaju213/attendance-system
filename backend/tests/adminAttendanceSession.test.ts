import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-session-test-password";
const ADMIN_USERNAME = "ADMSessTest_ADMIN";
const STUDENT_MATRIC = "ADMSessTest/STU";
const LECTURER1_STAFF_ID = "ADMSessTest/LEC1";
const LECTURER2_STAFF_ID = "ADMSessTest/LEC2";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturer1UserId = 0;
let lecturer2UserId = 0;

let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;

let facId = 0;
let depId = 0;
let level100Id = 0;

let acadSession1Id = 0;
let acadSession2Id = 0;
let firstSemesterId = 0;
let secondSemesterId = 0;

let course1Id = 0;
let course2Id = 0;

let offering1Id = 0;
let offering2Id = 0;
let offering3Id = 0;

let network1Id = 0;
let network2Id = 0;
let location1Id = 0;
let location2Id = 0;

let sessionActiveId = 0;
let sessionExpiredId = 0;
let sessionEndedId = 0;
let sessionEnded2Id = 0;

function userIds(): number[] {
  return [adminUserId, studentUserId, lecturer1UserId, lecturer2UserId];
}

function cookieFrom(res: globalThis.Response): string | null {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.cookieName}=`));
  if (!cookie) return null;
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";");
  return cookie.slice(eq + 1, semi);
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${token}` };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

function assertInvalidRequest(body: unknown): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, "INVALID_REQUEST");
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

async function cleanupScopedData(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records
     WHERE session_id IN (
       SELECT id FROM attendance_sessions
       WHERE started_by_lecturer_id IN (
         SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
       )
     )`,
    [userIds()]
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
     )`,
    [userIds()]
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMSessTest%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMSessTest%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ADMSessTest%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMSessTest%'`);
  await pool.query(
    `DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`,
    [userIds()]
  );
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'ADMSessTest%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'ADMSessTest%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMSessTest%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMSessTest%'`);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMSessTest Admin', $1, 'ADMIN', 'ACTIVE', $2) RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('ADMSessTest Faculty', 'ADMSessTest-FAC') RETURNING id`
  );
  facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('ADMSessTest Department', 'ADMSessTest-DEP', $1) RETURNING id`,
    [facId]
  );
  depId = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acad1 = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('ADMSessTest-ACAD1', true) RETURNING id`
  );
  acadSession1Id = Number(acad1.rows[0].id);

  const acad2 = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('ADMSessTest-ACAD2', false) RETURNING id`
  );
  acadSession2Id = Number(acad2.rows[0].id);

  const sem1 = await pool.query(`SELECT id FROM semesters WHERE name = 'First Semester'`);
  firstSemesterId = Number(sem1.rows[0].id);

  const sem2 = await pool.query(`SELECT id FROM semesters WHERE name = 'Second Semester'`);
  secondSemesterId = Number(sem2.rows[0].id);

  const course1 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('ADMSessTest-CS101', 'ADMSessTest Course One', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course1Id = Number(course1.rows[0].id);

  const course2 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('ADMSessTest-CS102', 'ADMSessTest Course Two', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course2Id = Number(course2.rows[0].id);

  const off1 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course1Id, acadSession1Id, firstSemesterId]
  );
  offering1Id = Number(off1.rows[0].id);

  const off2 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course2Id, acadSession1Id, firstSemesterId]
  );
  offering2Id = Number(off2.rows[0].id);

  const off3 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course1Id, acadSession2Id, secondSemesterId]
  );
  offering3Id = Number(off3.rows[0].id);

  const net1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('ADMSessTest-NET1', 'ADMSessTest Network One') RETURNING id`
  );
  network1Id = Number(net1.rows[0].id);

  const net2 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('ADMSessTest-NET2', 'ADMSessTest Network Two') RETURNING id`
  );
  network2Id = Number(net2.rows[0].id);

  const loc1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('ADMSessTest-LOC1') RETURNING id`
  );
  location1Id = Number(loc1.rows[0].id);

  const loc2 = await pool.query(
    `INSERT INTO locations (name) VALUES ('ADMSessTest-LOC2') RETURNING id`
  );
  location2Id = Number(loc2.rows[0].id);

  const stu = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMSessTest Student', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(stu.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [studentUserId, STUDENT_MATRIC, depId, level100Id]
  );

  const l1u = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMSessTest Lecturer1', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  lecturer1UserId = Number(l1u.rows[0].id);
  const l1p = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [lecturer1UserId, LECTURER1_STAFF_ID, depId]
  );
  lecturer1ProfileId = Number(l1p.rows[0].id);

  const l2u = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMSessTest Lecturer2', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  lecturer2UserId = Number(l2u.rows[0].id);
  const l2p = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [lecturer2UserId, LECTURER2_STAFF_ID, depId]
  );
  lecturer2ProfileId = Number(l2p.rows[0].id);

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2), ($3, $4), ($5, $6)`,
    [offering1Id, lecturer1ProfileId, offering2Id, lecturer1ProfileId, offering3Id, lecturer2ProfileId]
  );

  // Session A: ACTIVE (lecturer1) - end_time in the future
  const sessA = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status)
     VALUES ($1, $2, $3, $4, now() - interval '10 minutes', now() + interval '50 minutes',
             '5 minutes', 'ACTIVE')
     RETURNING id`,
    [offering1Id, lecturer1ProfileId, network1Id, location1Id]
  );
  sessionActiveId = Number(sessA.rows[0].id);

  // Session B: EXPIRED (lecturer2) - end_time in the past, still ACTIVE in DB
  const sessB = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status)
     VALUES ($1, $2, $3, $4, now() - interval '3 hours', now() - interval '2 hours',
             '10 minutes', 'ACTIVE')
     RETURNING id`,
    [offering3Id, lecturer2ProfileId, network2Id, location1Id]
  );
  sessionExpiredId = Number(sessB.rows[0].id);

  // Session C: ENDED (lecturer1)
  const sessC = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4, now() - interval '5 hours', now() - interval '4 hours',
             '0', 'ENDED', now() - interval '4 hours')
     RETURNING id`,
    [offering2Id, lecturer1ProfileId, network1Id, location2Id]
  );
  sessionEndedId = Number(sessC.rows[0].id);

  // Session D: ENDED (lecturer2) - older for ordering tests
  const sessD = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 day' + interval '1 hour',
             '15 minutes', 'ENDED', now() - interval '1 day' + interval '1 hour')
     RETURNING id`,
    [offering3Id, lecturer2ProfileId, network2Id, location2Id]
  );
  sessionEnded2Id = Number(sessD.rows[0].id);

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
  await cleanupScopedData();
  await pool.end();
});

async function adminToken(): Promise<string> {
  const login = await postJson("/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token, "admin login should issue a session cookie");
  return token;
}

async function studentToken(): Promise<string> {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token);
  return token;
}

async function lecturerToken(): Promise<string> {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER1_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token);
  return token;
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated request → rejected
// ---------------------------------------------------------------------------

test("unauthenticated request to list sessions is rejected with 401", async () => {
  const res = await get("/api/admin/attendance-sessions");
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("unauthenticated request to get session by ID is rejected with 401", async () => {
  const res = await get(`/api/admin/attendance-sessions/${sessionActiveId}`);
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// 2. Student request → rejected
// ---------------------------------------------------------------------------

test("student request to list sessions is rejected with 403", async () => {
  const token = await studentToken();
  const res = await get("/api/admin/attendance-sessions", cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 3. Lecturer request → rejected
// ---------------------------------------------------------------------------

test("lecturer request to list sessions is rejected with 403", async () => {
  const token = await lecturerToken();
  const res = await get("/api/admin/attendance-sessions", cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 4. Admin can list sessions
// ---------------------------------------------------------------------------

test("admin can list sessions", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/attendance-sessions", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 4, "should contain at least the 4 seeded sessions");

  const ids = body.data.map((s) => s.id);
  assert.ok(ids.includes(sessionActiveId));
  assert.ok(ids.includes(sessionExpiredId));
  assert.ok(ids.includes(sessionEndedId));
  assert.ok(ids.includes(sessionEnded2Id));
});

// ---------------------------------------------------------------------------
// 5. Admin can retrieve a session by ID
// ---------------------------------------------------------------------------

test("admin can retrieve a session by ID with full joined data", async () => {
  const token = await adminToken();
  const res = await get(`/api/admin/attendance-sessions/${sessionActiveId}`, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  const d = body.data;

  assert.equal(d.id, sessionActiveId);
  assert.equal(d.courseOfferingId, offering1Id);
  assert.equal(d.courseCode, "ADMSessTest-CS101");
  assert.equal(d.courseTitle, "ADMSessTest Course One");
  assert.equal(d.lecturerId, lecturer1ProfileId);
  assert.equal(d.lecturerStaffId, LECTURER1_STAFF_ID);
  assert.equal(d.lecturerName, "ADMSessTest Lecturer1");
  assert.equal(d.attendanceNetworkId, network1Id);
  assert.equal(d.attendanceNetworkCode, "ADMSessTest-NET1");
  assert.equal(d.attendanceNetworkName, "ADMSessTest Network One");
  assert.equal(d.locationId, location1Id);
  assert.equal(d.locationName, "ADMSessTest-LOC1");
  assert.equal(d.academicSessionId, acadSession1Id);
  assert.equal(d.academicSessionName, "ADMSessTest-ACAD1");
  assert.equal(d.semesterId, firstSemesterId);
  assert.equal(d.semesterName, "First Semester");
  assert.equal(d.status, "ACTIVE");
  assert.equal(d.lateThresholdMinutes, 5);
  assert.equal(typeof d.startTime, "string");
  assert.equal(typeof d.endTime, "string");
  assert.equal(typeof d.createdAt, "string");
  assert.equal(d.endedAt, null);
});

// ---------------------------------------------------------------------------
// 6. Missing session → correct not-found response
// ---------------------------------------------------------------------------

test("missing session returns SESSION_NOT_FOUND", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/attendance-sessions/999999", cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

test("invalid session ID (non-numeric) returns INVALID_REQUEST", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/attendance-sessions/abc", cookieHeader(token));
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

// ---------------------------------------------------------------------------
// 7. Filtering by course offering
// ---------------------------------------------------------------------------

test("filtering by courseOfferingId returns only matching sessions", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions?courseOfferingId=${offering1Id}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((s) => s.courseOfferingId === offering1Id));
  assert.ok(body.data.some((s) => s.id === sessionActiveId));
});

// ---------------------------------------------------------------------------
// 8. Filtering by lecturer
// ---------------------------------------------------------------------------

test("filtering by lecturerId returns only matching sessions", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions?lecturerId=${lecturer1ProfileId}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length >= 2);
  assert.ok(body.data.every((s) => s.lecturerId === lecturer1ProfileId));
  assert.ok(body.data.some((s) => s.id === sessionActiveId));
  assert.ok(body.data.some((s) => s.id === sessionEndedId));
});

// ---------------------------------------------------------------------------
// 9. Filtering by network
// ---------------------------------------------------------------------------

test("filtering by attendanceNetworkId returns only matching sessions", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions?attendanceNetworkId=${network2Id}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((s) => s.attendanceNetworkId === network2Id));
  assert.ok(body.data.some((s) => s.id === sessionExpiredId));
  assert.ok(body.data.some((s) => s.id === sessionEnded2Id));
});

// ---------------------------------------------------------------------------
// 10. Filtering by location
// ---------------------------------------------------------------------------

test("filtering by locationId returns only matching sessions", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions?locationId=${location2Id}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((s) => s.locationId === location2Id));
  assert.ok(body.data.some((s) => s.id === sessionEndedId));
  assert.ok(body.data.some((s) => s.id === sessionEnded2Id));
});

// ---------------------------------------------------------------------------
// 11. Filtering by academic session
// ---------------------------------------------------------------------------

test("filtering by academicSessionId returns only matching sessions", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions?academicSessionId=${acadSession2Id}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((s) => s.academicSessionId === acadSession2Id));
  assert.ok(body.data.some((s) => s.id === sessionExpiredId));
  assert.ok(body.data.some((s) => s.id === sessionEnded2Id));
});

// ---------------------------------------------------------------------------
// 12. Filtering by semester
// ---------------------------------------------------------------------------

test("filtering by semesterId returns only matching sessions", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions?semesterId=${secondSemesterId}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((s) => s.semesterId === secondSemesterId));
  assert.ok(body.data.some((s) => s.id === sessionExpiredId));
  assert.ok(body.data.some((s) => s.id === sessionEnded2Id));
});

// ---------------------------------------------------------------------------
// 13. Filtering by status
// ---------------------------------------------------------------------------

test("filtering by status ACTIVE returns only ACTIVE sessions", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?status=ACTIVE",
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.every((s) => s.status === "ACTIVE"));
  const ids = body.data.map((s) => s.id);
  assert.ok(ids.includes(sessionActiveId));
  assert.ok(ids.includes(sessionExpiredId));
  assert.ok(!ids.includes(sessionEndedId));
  assert.ok(!ids.includes(sessionEnded2Id));
});

test("filtering by status ENDED returns only ENDED sessions", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?status=ENDED",
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.every((s) => s.status === "ENDED"));
  const ids = body.data.map((s) => s.id);
  assert.ok(!ids.includes(sessionActiveId));
  assert.ok(!ids.includes(sessionExpiredId));
  assert.ok(ids.includes(sessionEndedId));
  assert.ok(ids.includes(sessionEnded2Id));
});

// ---------------------------------------------------------------------------
// 14. Filtering by date range
// ---------------------------------------------------------------------------

test("filtering by from/to date range returns sessions within range", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?from=2020-01-01T00:00:00.000Z&to=2020-12-31T23:59:59.999Z",
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length === 0, "no sessions should exist in 2020");
});

test("filtering by from only returns sessions starting at or after from", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?from=2030-01-01T00:00:00.000Z",
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length === 0, "no sessions should exist after 2030");
});

// ---------------------------------------------------------------------------
// 15. Invalid ID filter rejected
// ---------------------------------------------------------------------------

test("invalid ID filters are rejected with 400", async () => {
  const token = await adminToken();
  const badFilters = [
    "courseOfferingId=0",
    "courseOfferingId=-5",
    "courseOfferingId=abc",
    "lecturerId=0",
    "attendanceNetworkId=-1",
    "locationId=not-a-number",
    "academicSessionId=1.5",
  ];
  for (const q of badFilters) {
    const res = await get(`/api/admin/attendance-sessions?${q}`, cookieHeader(token));
    assert.equal(res.status, 400, `expected 400 for ?${q}`);
    assertInvalidRequest(await res.json());
  }
});

// ---------------------------------------------------------------------------
// 16. Invalid status rejected
// ---------------------------------------------------------------------------

test("invalid status value is rejected with 400", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?status=PAUSED",
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("lowercase status is accepted (normalized to uppercase)", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?status=active",
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.every((s) => s.status === "ACTIVE"));
});

// ---------------------------------------------------------------------------
// 17. Invalid date rejected
// ---------------------------------------------------------------------------

test("invalid date string is rejected with 400", async () => {
  const token = await adminToken();
  const badDates = [
    "from=not-a-date",
    "to=2020-13-45T99:99:99Z",
    "from=2025-01-01",
  ];
  for (const q of badDates) {
    const res = await get(`/api/admin/attendance-sessions?${q}`, cookieHeader(token));
    assert.equal(res.status, 400, `expected 400 for ?${q}`);
    assertInvalidRequest(await res.json());
  }
});

// ---------------------------------------------------------------------------
// 18. from > to rejected
// ---------------------------------------------------------------------------

test("from > to is rejected with 400", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?from=2025-06-30T00:00:00.000Z&to=2025-06-01T00:00:00.000Z",
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("from equal to is accepted", async () => {
  const token = await adminToken();
  const res = await get(
    "/api/admin/attendance-sessions?from=2025-06-15T00:00:00.000Z&to=2025-06-15T00:00:00.000Z",
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// 19. Results are ordered newest first
// ---------------------------------------------------------------------------

test("results are ordered by start_time DESC, id DESC", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/attendance-sessions", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  const sessions = body.data;
  assert.ok(sessions.length >= 4);

  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1];
    const curr = sessions[i];
    const prevStart = new Date(prev.startTime as string).getTime();
    const currStart = new Date(curr.startTime as string).getTime();
    assert.ok(
      prevStart > currStart || (prevStart === currStart && (prev.id as number) > (curr.id as number)),
      `session at index ${i - 1} should come before index ${i} by start_time DESC, id DESC`
    );
  }
});

// ---------------------------------------------------------------------------
// 20. currentState is correctly derived
// ---------------------------------------------------------------------------

test("currentState is ACTIVE when status=ACTIVE and current time <= endTime", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions/${sessionActiveId}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(body.data.currentState, "ACTIVE");
});

test("currentState is EXPIRED when status=ACTIVE and current time > endTime", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions/${sessionExpiredId}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(body.data.currentState, "EXPIRED");
});

test("currentState is ENDED when status=ENDED", async () => {
  const token = await adminToken();
  const res = await get(
    `/api/admin/attendance-sessions/${sessionEndedId}`,
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "ENDED");
  assert.equal(body.data.currentState, "ENDED");
});
