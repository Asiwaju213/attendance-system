import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";

const TEST_PASSWORD = "att-rec-test-pw";
const ADMIN_A_USERNAME = "ADMRecTest_A";
const ADMIN_B_USERNAME = "ADMRecTest_B";
const INACTIVE_ADMIN_USERNAME = "ADMRecTest_Inactive";
const STUDENT_MATRIC = "ADMRecTest/STU";
const VICTIM_MATRIC = "ADMRecTest/VIC";
const LECTURER_STAFF_ID = "ADMRecTest/LEC";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminAUserId = 0;
let adminBUserId = 0;
let inactiveAdminUserId = 0;
let studentUserId = 0;
let studentProfileId = 0;
let victimUserId = 0;
let victimProfileId = 0;
let lecturerUserId = 0;
let lecturerProfileId = 0;

let facId = 0;
let depId = 0;
let level100Id = 0;

let acadSessionId = 0;
let semesterId = 0;

let courseId = 0;
let offeringId = 0;

let networkId = 0;
let locationId = 0;

// Multiple sessions, each with one record for student A (to respect UNIQUE session_id, student_id)
let sessionMain = 0;
let sessionVictim = 0;
let sessionConcurrency = 0;
let sessionAtomic = 0;
let sessionFailed = 0;

// Attendance record IDs (one per session for student A, plus victim in separate session)
let recordA = 0;        // student A in sessionMain, used for most tests
let recordVictim = 0;   // student B in sessionVictim, used for test 17
let recordG = 0;        // student A in sessionConcurrency, for concurrency test
let recordE = 0;        // student A in sessionAtomic, for atomicity test
let recordF = 0;        // student A in sessionFailed, for failed-correction test

// No single sessionId anymore - use allSessionIds() everywhere

function userIds(): number[] {
  return [
    adminAUserId,
    adminBUserId,
    inactiveAdminUserId,
    studentUserId,
    victimUserId,
    lecturerUserId,
  ];
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

function assertInvalidRequest(body: unknown): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, "INVALID_REQUEST");
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

async function cleanupScopedData(): Promise<void> {
  // Delete in correct FK order: children first, then parents
  // Attendance records - clean by pattern (sessions started by our test lecturers OR students with our matric prefix)
  await pool.query(
    `DELETE FROM attendance_records
     WHERE session_id IN (
       SELECT id FROM attendance_sessions
       WHERE started_by_lecturer_id IN (
         SELECT id FROM lecturers WHERE staff_id LIKE 'ADMRecTest/%'
       )
     )
     OR student_id IN (
       SELECT id FROM students WHERE matric_number LIKE 'ADMRecTest/%'
     )`
  );
  // Attendance sessions reference course_offerings, networks, locations, lecturers
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
     )`,
    [userIds()]
  );
  // Also delete attendance sessions by pattern (started by our test lecturers)
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE staff_id LIKE 'ADMRecTest/%'
     )`
  );
  // Course offering lecturers
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMRecTest%')
     )`
  );
  // Course offerings reference academic_sessions and courses
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMRecTest%')`
  );
  // Academic sessions (must be after course_offerings)
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMRecTest%'`);
  // Courses (must be after course_offerings)
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ADMRecTest%'`);
  // Audit logs by user_id
  await pool.query(
    `DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`,
    [userIds()]
  );
  // Auth sessions - delete sessions for our test users (by pattern on students/lecturers)
  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (
      SELECT user_id FROM students WHERE matric_number LIKE 'ADMRecTest/%'
      UNION
      SELECT user_id FROM lecturers WHERE staff_id LIKE 'ADMRecTest/%'
      UNION
      SELECT id FROM users WHERE username LIKE 'ADMRecTest%'
    )`
  );
  // Students and lecturers by pattern (matric_number/staff_id prefix) - BEFORE departments
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'ADMRecTest/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'ADMRecTest/%'`);
  // Users by username pattern (admins) and catch-all for students/lecturers
  await pool.query(`DELETE FROM users WHERE username LIKE 'ADMRecTest%'`);
  await pool.query(`DELETE FROM users WHERE username IS NULL AND id IN (
    SELECT user_id FROM students WHERE matric_number LIKE 'ADMRecTest/%'
    UNION
    SELECT user_id FROM lecturers WHERE staff_id LIKE 'ADMRecTest/%'
  )`);
  // Departments (after students and lecturers)
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMRecTest%'`);
  // Faculties (after departments)
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMRecTest%'`);
  // Networks, locations
  await pool.query(
    `DELETE FROM attendance_networks WHERE network_code LIKE 'ADMRecTest%'`
  );
  await pool.query(`DELETE FROM locations WHERE name LIKE 'ADMRecTest%'`);
}

async function resetRecordStatus(
  recordId: number,
  status: "PRESENT" | "LATE"
): Promise<void> {
  await pool.query(
    `UPDATE attendance_records SET status = $1 WHERE id = $2`,
    [status, recordId]
  );
}

async function clearAuditsForRecord(recordId: number): Promise<void> {
  await pool.query(
    `DELETE FROM audit_logs WHERE entity_type = 'attendance_records' AND entity_id = $1`,
    [recordId]
  );
}

async function getRecordStatus(recordId: number): Promise<string | null> {
  const res = await pool.query(
    `SELECT status FROM attendance_records WHERE id = $1`,
    [recordId]
  );
  return res.rows[0]?.status ?? null;
}

async function countAuditsForRecord(recordId: number): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'attendance_records' AND entity_id = $1`,
    [recordId]
  );
  return Number(res.rows[0].count);
}

async function getLatestAuditForRecord(
  recordId: number
): Promise<{
  user_id: number;
  action: string;
  entity_type: string;
  entity_id: number;
  description: string;
  created_at: Date;
} | null> {
  const res = await pool.query(
    `SELECT user_id, action, entity_type, entity_id, description, created_at
     FROM audit_logs
     WHERE entity_type = 'attendance_records' AND entity_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [recordId]
  );
  return res.rows[0] ?? null;
}

async function getAllAuditsForRecord(
  recordId: number
): Promise<
  Array<{
    user_id: number;
    action: string;
    entity_type: string;
    entity_id: number;
    description: string;
    created_at: Date;
    id: number;
  }>
> {
  const res = await pool.query(
    `SELECT id, user_id, action, entity_type, entity_id, description, created_at
     FROM audit_logs
     WHERE entity_type = 'attendance_records' AND entity_id = $1
     ORDER BY id ASC`,
    [recordId]
  );
  return res.rows;
}

async function adminAToken(): Promise<string> {
  const login = await postJson("/api/auth/admin/login", {
    username: ADMIN_A_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token);
  return token;
}

async function adminBToken(): Promise<string> {
  const login = await postJson("/api/auth/admin/login", {
    username: ADMIN_B_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token);
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
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token);
  return token;
}

async function createInactiveAdminSession(): Promise<string> {
  // An inactive admin cannot log in (authenticate returns null),
  // so we fabricate a valid session row directly.
  const token = generateSessionToken();
  const session = await createSession(
    inactiveAdminUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60_000)
  );
  assert.ok(session);
  return token;
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  // --- Admin A ---
  const adminA = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMRecTest Admin A', $1, 'ADMIN', 'ACTIVE', $2) RETURNING id`,
    [passwordHash, ADMIN_A_USERNAME]
  );
  adminAUserId = Number(adminA.rows[0].id);

  // --- Admin B ---
  const adminB = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMRecTest Admin B', $1, 'ADMIN', 'ACTIVE', $2) RETURNING id`,
    [passwordHash, ADMIN_B_USERNAME]
  );
  adminBUserId = Number(adminB.rows[0].id);

  // --- Inactive Admin ---
  const inactiveAdmin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMRecTest Inactive Admin', $1, 'ADMIN', 'INACTIVE', $2) RETURNING id`,
    [passwordHash, INACTIVE_ADMIN_USERNAME]
  );
  inactiveAdminUserId = Number(inactiveAdmin.rows[0].id);

  // --- Faculty / Department / Level ---
  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('ADMRecTest Faculty', 'ADMRecTest-FAC') RETURNING id`
  );
  facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('ADMRecTest Department', 'ADMRecTest-DEP', $1) RETURNING id`,
    [facId]
  );
  depId = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  // --- Academic Session / Semester ---
  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('ADMRecTest-ACAD', true) RETURNING id`
  );
  acadSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(`SELECT id FROM semesters WHERE name = 'First Semester'`);
  semesterId = Number(sem.rows[0].id);

  // --- Course / Offering ---
  const course = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('ADMRecTest-CS101', 'ADMRecTest Course', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  courseId = Number(course.rows[0].id);

  const off = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [courseId, acadSessionId, semesterId]
  );
  offeringId = Number(off.rows[0].id);

  // --- Network / Location ---
  const net = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('ADMRecTest-NET', 'ADMRecTest Network') RETURNING id`
  );
  networkId = Number(net.rows[0].id);

  const loc = await pool.query(
    `INSERT INTO locations (name) VALUES ('ADMRecTest-LOC') RETURNING id`
  );
  locationId = Number(loc.rows[0].id);

  // --- Student A (main) ---
  const stu = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMRecTest Student A', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(stu.rows[0].id);
  const stuProfile = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [studentUserId, STUDENT_MATRIC, depId, level100Id]
  );
  studentProfileId = Number(stuProfile.rows[0].id);

  // --- Student B (victim) ---
  const vic = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMRecTest Student B', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  victimUserId = Number(vic.rows[0].id);
  const vicProfile = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [victimUserId, VICTIM_MATRIC, depId, level100Id]
  );
  victimProfileId = Number(vicProfile.rows[0].id);

  // --- Lecturer ---
  const lecU = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ADMRecTest Lecturer', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lecU.rows[0].id);
  const lecP = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [lecturerUserId, LECTURER_STAFF_ID, depId]
  );
  lecturerProfileId = Number(lecP.rows[0].id);

  // --- Assign lecturer to offering ---
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offeringId, lecturerProfileId]
  );

  // --- Attendance Session 1: Main (ENDED for stability) ---
  const sessMain = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4,
             now() - interval '2 hours', now() - interval '1 hour',
             '5 minutes', 'ENDED', now() - interval '1 hour')
     RETURNING id`,
    [offeringId, lecturerProfileId, networkId, locationId]
  );
  sessionMain = Number(sessMain.rows[0].id);

  // --- Attendance Session 2: Victim (for cross-record test) ---
  const sessVictim = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4,
             now() - interval '2 hours', now() - interval '1 hour',
             '5 minutes', 'ENDED', now() - interval '1 hour')
     RETURNING id`,
    [offeringId, lecturerProfileId, networkId, locationId]
  );
  sessionVictim = Number(sessVictim.rows[0].id);

  // --- Attendance Session 3: Concurrency ---
  const sessConcurrency = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4,
             now() - interval '2 hours', now() - interval '1 hour',
             '5 minutes', 'ENDED', now() - interval '1 hour')
     RETURNING id`,
    [offeringId, lecturerProfileId, networkId, locationId]
  );
  sessionConcurrency = Number(sessConcurrency.rows[0].id);

  // --- Attendance Session 4: Atomicity ---
  const sessAtomic = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4,
             now() - interval '2 hours', now() - interval '1 hour',
             '5 minutes', 'ENDED', now() - interval '1 hour')
     RETURNING id`,
    [offeringId, lecturerProfileId, networkId, locationId]
  );
  sessionAtomic = Number(sessAtomic.rows[0].id);

  // --- Attendance Session 5: Failed correction ---
  const sessFailed = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4,
             now() - interval '2 hours', now() - interval '1 hour',
             '5 minutes', 'ENDED', now() - interval '1 hour')
     RETURNING id`,
    [offeringId, lecturerProfileId, networkId, locationId]
  );
  sessionFailed = Number(sessFailed.rows[0].id);

  // --- Attendance Records (one per session for student A, one for student B) ---
  const recARes = await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
     VALUES ($1, (SELECT id FROM students WHERE user_id = $2), 'PRESENT', now() - interval '1 hour')
     RETURNING id`,
    [sessionMain, studentUserId]
  );
  recordA = Number(recARes.rows[0].id);

  const recVRes = await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
     VALUES ($1, (SELECT id FROM students WHERE user_id = $2), 'LATE', now() - interval '1 hour')
     RETURNING id`,
    [sessionVictim, victimUserId]
  );
  recordVictim = Number(recVRes.rows[0].id);

  const recGRes = await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
     VALUES ($1, (SELECT id FROM students WHERE user_id = $2), 'PRESENT', now() - interval '1 hour')
     RETURNING id`,
    [sessionConcurrency, studentUserId]
  );
  recordG = Number(recGRes.rows[0].id);

  const recERes = await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
     VALUES ($1, (SELECT id FROM students WHERE user_id = $2), 'PRESENT', now() - interval '1 hour')
     RETURNING id`,
    [sessionAtomic, studentUserId]
  );
  recordE = Number(recERes.rows[0].id);

  const recFRes = await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
     VALUES ($1, (SELECT id FROM students WHERE user_id = $2), 'LATE', now() - interval '1 hour')
     RETURNING id`,
    [sessionFailed, studentUserId]
  );
  recordF = Number(recFRes.rows[0].id);

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

// Helper to extract from/to statuses from audit description
function parseStatusTransition(
  description: string
): { from: string; to: string } | null {
  const m = description.match(
    /status changed from (PRESENT|LATE) to (PRESENT|LATE)/
  );
  if (!m) return null;
  return { from: m[1], to: m[2] };
}

// ============================================================================
// 1. Unauthenticated request → 401
// ============================================================================

test("unauthenticated request is rejected with 401", async () => {
  const res = await patchJson(`/api/admin/attendance-records/${recordA}`, {
    status: "LATE",
  });
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ============================================================================
// 2. Student → 403
// ============================================================================

test("student request is rejected with 403", async () => {
  const token = await studentToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ============================================================================
// 3. Lecturer → 403
// ============================================================================

test("lecturer request is rejected with 403", async () => {
  const token = await lecturerToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ============================================================================
// 4. Inactive admin → rejected (401 via fabricated session)
// ============================================================================

test("inactive admin session is rejected with 401", async () => {
  const token = await createInactiveAdminSession();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ============================================================================
// 5. Invalid record ID → 400
// ============================================================================

test("invalid record ID (non-numeric) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    "/api/admin/attendance-records/abc",
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("invalid record ID (zero) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    "/api/admin/attendance-records/0",
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("invalid record ID (negative) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    "/api/admin/attendance-records/-5",
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("invalid record ID (float) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    "/api/admin/attendance-records/1.5",
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

// ============================================================================
// 6. Invalid status → 400
// ============================================================================

test("invalid status value (ABSENT) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "ABSENT" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("empty status string returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("numeric status returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: 42 },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("empty request body returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("extra field in body (studentId) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", studentId: 999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("extra field in body (attendanceSessionId) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", attendanceSessionId: 999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("extra field in body (previousStatus) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", previousStatus: "PRESENT" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("wrong field name (STATUS) returns INVALID_REQUEST", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { STATUS: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

// ============================================================================
// 7. Nonexistent record → 404
// ============================================================================

test("nonexistent record returns RECORD_NOT_FOUND", async () => {
  const token = await adminAToken();
  const res = await patchJson(
    "/api/admin/attendance-records/999999",
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "RECORD_NOT_FOUND");
});

// ============================================================================
// 8. PRESENT -> LATE succeeds
// ============================================================================

test("PRESENT -> LATE correction succeeds", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  const d = body.data;

  assert.equal(d.id, recordA);
  assert.equal(d.status, "LATE");
  assert.equal(d.previousStatus, "PRESENT");
  assert.equal(d.studentId, studentProfileId);
  assert.equal(d.matricNumber, STUDENT_MATRIC);
  assert.equal(typeof d.studentName, "string");
  assert.equal(typeof d.courseCode, "string");
  assert.equal(typeof d.courseTitle, "string");
  assert.ok(d.sessionId === sessionMain, `sessionId mismatch: got ${d.sessionId}, expected ${sessionMain}`);
  assert.equal(typeof d.sessionStartTime, "string");
  assert.equal(typeof d.sessionEndTime, "string");
  assert.equal(typeof d.markedAt, "string");
});

// ============================================================================
// 9. LATE -> PRESENT succeeds
// ============================================================================

test("LATE -> PRESENT correction succeeds", async () => {
  await resetRecordStatus(recordA, "LATE");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "PRESENT" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  const d = body.data;

  assert.equal(d.id, recordA);
  assert.equal(d.status, "PRESENT");
  assert.equal(d.previousStatus, "LATE");
});

// ============================================================================
// 10. No-op correction is rejected (409 NO_OP_CORRECTION)
// ============================================================================

test("no-op PRESENT -> PRESENT is rejected with NO_OP_CORRECTION", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "PRESENT" },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "NO_OP_CORRECTION");

  const after = await getRecordStatus(recordA);
  assert.equal(after, "PRESENT");
  const audits = await countAuditsForRecord(recordA);
  assert.equal(audits, 0, "no audit should be created for no-op");
});

test("no-op LATE -> LATE is rejected with NO_OP_CORRECTION", async () => {
  await resetRecordStatus(recordA, "LATE");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "NO_OP_CORRECTION");

  const after = await getRecordStatus(recordA);
  assert.equal(after, "LATE");
  const audits = await countAuditsForRecord(recordA);
  assert.equal(audits, 0, "no audit should be created for no-op");
});

// ============================================================================
// 11. Student/session/course identity cannot be changed
// ============================================================================

test("attempt to smuggle studentId in body is rejected (400)", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", studentId: victimUserId },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  // Ensure record unchanged
  const status = await getRecordStatus(recordA);
  assert.equal(status, "PRESENT");
});

test("attempt to smuggle attendanceSessionId in body is rejected (400)", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", attendanceSessionId: 999999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  const status = await getRecordStatus(recordA);
  assert.equal(status, "PRESENT");
});

test("attempt to smuggle courseCode in body is rejected (400)", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", courseCode: "HACKED" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  const status = await getRecordStatus(recordA);
  assert.equal(status, "PRESENT");
});

test("legitimate correction preserves student/session/course identity", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  const d = body.data;

  assert.equal(d.studentId, studentProfileId);
  assert.equal(d.matricNumber, STUDENT_MATRIC);
  assert.ok(d.sessionId === sessionMain, `sessionId mismatch: got ${d.sessionId}, expected ${sessionMain}`);
  assert.equal(typeof d.courseCode, "string");
  assert.ok((d.courseCode as string).startsWith("ADMRecTest"));
});

// ============================================================================
// 12. Successful correction creates exactly one audit-log entry
// ============================================================================

test("successful correction creates exactly one audit entry", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);

  const count = await countAuditsForRecord(recordA);
  assert.equal(count, 1, "exactly one audit entry should exist");
});

// ============================================================================
// 13. Audit entry contains actor, record, previous/new status, timestamp
// ============================================================================

test("audit entry contains all required fields", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await clearAuditsForRecord(recordA);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);

  const audit = await getLatestAuditForRecord(recordA);
  assert.ok(audit, "audit entry should exist");
  assert.equal(Number(audit.user_id), adminAUserId, "actor should be the correcting admin");
  assert.equal(audit.entity_type, "attendance_records");
  assert.equal(Number(audit.entity_id), recordA);
  assert.equal(audit.action, "ATTENDANCE_RECORD_CORRECTED");
  assert.ok(audit.created_at instanceof Date, "timestamp should be present");
  assert.ok(audit.description.includes("status changed from PRESENT to LATE"));
  assert.ok(audit.description.includes(STUDENT_MATRIC));
  assert.ok(audit.description.includes("ADMRecTest-CS101"));
  assert.ok(audit.description.includes(`session ${sessionMain}`));
});

// ============================================================================
// 14. Atomicity: failed audit insert rolls back attendance update
// ============================================================================

test("correction rolls back when audit insertion fails", async () => {
  await resetRecordStatus(recordE, "PRESENT");
  await clearAuditsForRecord(recordE);

  // Install a scoped BEFORE INSERT trigger that fails only for our record
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_attendance_correction_audit()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.action = 'ATTENDANCE_RECORD_CORRECTED' AND NEW.entity_id = ${recordE} THEN
        RAISE EXCEPTION 'forced audit insert failure for test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS fail_audit_for_test ON audit_logs;
    CREATE TRIGGER fail_audit_for_test
    BEFORE INSERT ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION fail_attendance_correction_audit();
  `);

  try {
    const token = await adminAToken();
    const res = await patchJson(
      `/api/admin/attendance-records/${recordE}`,
      { status: "LATE" },
      cookieHeader(token)
    );
    // The trigger raises, transaction rolls back → 500 via central error handler
    assert.equal(res.status, 500);
    assertErrorCode(await res.json(), "INTERNAL_ERROR");

    // Attendance record must be unchanged (rolled back)
    const status = await getRecordStatus(recordE);
    assert.equal(status, "PRESENT", "attendance update must be rolled back");

    // No audit entry for this record
    const count = await countAuditsForRecord(recordE);
    assert.equal(count, 0, "no audit entry should exist after rollback");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS fail_audit_for_test ON audit_logs;`);
    await pool.query(`DROP FUNCTION IF EXISTS fail_attendance_correction_audit();`);
  }
});

// ============================================================================
// 15. Failed correction does not create an audit entry
// ============================================================================

test("no-op correction (rejected) creates zero audit entries", async () => {
  await resetRecordStatus(recordF, "PRESENT");
  await clearAuditsForRecord(recordF);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordF}`,
    { status: "PRESENT" },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);

  const count = await countAuditsForRecord(recordF);
  assert.equal(count, 0, "no audit entry for rejected no-op");
});

test("nonexistent record correction creates zero audit entries", async () => {
  const token = await adminAToken();
  const before = await countAuditsForRecord(999999);
  const res = await patchJson(
    "/api/admin/attendance-records/999999",
    { status: "LATE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  const after = await countAuditsForRecord(999999);
  assert.equal(after, before, "no audit entry for not-found");
});

// ============================================================================
// 16. Concurrent corrections produce deterministic audit history
// ============================================================================

test("concurrent corrections serialize and produce deterministic audit history", async () => {
  // Initial status = PRESENT. Admin A tries LATE, Admin B tries PRESENT.
  // Depending on who acquires the lock first:
  // - A first: PRESENT→LATE (success), then B: LATE→PRESENT (success) → 2 audits, final=PRESENT
  // - B first: PRESENT→PRESENT (no-op 409), then A: PRESENT→LATE (success) → 1 audit, final=LATE
  // Both outcomes are correct; verify invariants in either case.
  await resetRecordStatus(recordG, "PRESENT");
  await clearAuditsForRecord(recordG);

  const [tokenA, tokenB] = await Promise.all([adminAToken(), adminBToken()]);

  const [resA, resB] = await Promise.all([
    patchJson(
      `/api/admin/attendance-records/${recordG}`,
      { status: "LATE" },
      cookieHeader(tokenA)
    ),
    patchJson(
      `/api/admin/attendance-records/${recordG}`,
      { status: "PRESENT" },
      cookieHeader(tokenB)
    ),
  ]);

  // Both requests should either succeed (200) or one succeeds and one is no-op (409)
  const statuses = [resA.status, resB.status].sort();
  // Valid outcomes: [200, 200] or [200, 409]
  assert.ok(
    (statuses[0] === 200 && statuses[1] === 200) ||
      (statuses[0] === 200 && statuses[1] === 409),
    `unexpected statuses: ${statuses.join(", ")}`
  );

  // Exactly one or two audit entries depending on outcome
  const audits = await getAllAuditsForRecord(recordG);
  const auditCount = audits.length;
  assert.ok(auditCount === 1 || auditCount === 2, `expected 1 or 2 audits, got ${auditCount}`);

  // Parse transitions
  const transitions = audits
    .map((a) => parseStatusTransition(a.description))
    .filter((t): t is { from: string; to: string } => t !== null);
  assert.equal(transitions.length, auditCount);

  // First entry must originate from initial PRESENT
  assert.equal(transitions[0].from, "PRESENT");

  // No transition is a no-op
  for (const t of transitions) {
    assert.notEqual(t.from, t.to);
  }

  // If two audits, chain must be contiguous: entry1.to == entry2.from
  if (auditCount === 2) {
    assert.equal(transitions[0].to, transitions[1].from);
  }

  // Final DB status must equal the last entry's 'to' status
  const finalStatus = await getRecordStatus(recordG);
  assert.equal(finalStatus, transitions[transitions.length - 1].to);

  // All successful corrections have distinct actors (if both succeeded)
  if (resA.status === 200 && resB.status === 200) {
    const actorIds = new Set(audits.map((a) => Number(a.user_id)));
    assert.ok(actorIds.has(adminAUserId));
    assert.ok(actorIds.has(adminBUserId));
  }
});

// ============================================================================
// 17. One admin cannot modify another unrelated record through manipulated request data
// ============================================================================

test("smuggled studentId in body does not affect victim record", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await resetRecordStatus(recordVictim, "LATE");
  await clearAuditsForRecord(recordA);
  await clearAuditsForRecord(recordVictim);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", studentId: victimUserId },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  // Both records unchanged
  assert.equal(await getRecordStatus(recordA), "PRESENT");
  assert.equal(await getRecordStatus(recordVictim), "LATE");

  // No audit entries on either
  assert.equal(await countAuditsForRecord(recordA), 0);
  assert.equal(await countAuditsForRecord(recordVictim), 0);
});

test("smuggled attendanceSessionId in body does not affect other session", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await resetRecordStatus(recordVictim, "LATE");
  await clearAuditsForRecord(recordA);
  await clearAuditsForRecord(recordVictim);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", attendanceSessionId: 999999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  assert.equal(await getRecordStatus(recordA), "PRESENT");
  assert.equal(await getRecordStatus(recordVictim), "LATE");
});

test("smuggled record id in body does not retarget correction", async () => {
  await resetRecordStatus(recordA, "PRESENT");
  await resetRecordStatus(recordVictim, "LATE");
  await clearAuditsForRecord(recordA);
  await clearAuditsForRecord(recordVictim);

  const token = await adminAToken();
  const res = await patchJson(
    `/api/admin/attendance-records/${recordA}`,
    { status: "LATE", id: recordVictim },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  assert.equal(await getRecordStatus(recordA), "PRESENT");
  assert.equal(await getRecordStatus(recordVictim), "LATE");
});