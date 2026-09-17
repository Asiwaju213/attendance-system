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

const TEST_PASSWORD = "adm-report-test-pw";
const ADMIN_USERNAME = "ADMRepTest_Admin";
const INACTIVE_ADMIN_USERNAME = "ADMRepTest_AdminInactive";
const LECTURER_1_STAFF_ID = "ADMRepTest/LEC1";
const LECTURER_2_STAFF_ID = "ADMRepTest/LEC2";

const STU1 = "ADMRepTest/STU1";
const STU2 = "ADMRepTest/STU2";
const STU3 = "ADMRepTest/STU3";
const STU4 = "ADMRepTest/STU4";
const STU5 = "ADMRepTest/STU5";
const STU6 = "ADMRepTest/STU6";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let inactiveAdminUserId = 0;

let stuUserIds: number[] = [];
let stuProfileIds: Record<string, number> = {};

let lecturer1UserId = 0;
let lecturer2UserId = 0;
let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;

let facId = 0;
let depId = 0;
let level100Id = 0;

let acadSessionAId = 0;
let acadSessionBId = 0;
let firstSemesterId = 0;
let secondSemesterId = 0;

let course1Id = 0;
let course2Id = 0;

let offeringAId = 0;
let offeringBId = 0;
let offeringCId = 0;
let offeringDId = 0;

let network1Id = 0;
let location1Id = 0;

let sessionA1 = 0; // ENDED  (offering A)
let sessionA2 = 0; // ENDED  (offering A)
let sessionA3 = 0; // ENDED  (offering A)
let sessionActive = 0; // ACTIVE (offering A)
let sessionExpired = 0; // ACTIVE but past end_time (offering A)
let sessionBOffering = 0; // ENDED (offering B)

function userIds(): number[] {
  return [adminUserId, inactiveAdminUserId, ...stuUserIds, lecturer1UserId, lecturer2UserId];
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
     ) OR student_id IN (
       SELECT id FROM students WHERE user_id = ANY($1::BIGINT[])
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
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMRepTest%')
     ) OR student_id IN (
       SELECT id FROM students WHERE user_id = ANY($1::BIGINT[])
     )`,
    [userIds()]
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMRepTest%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMRepTest%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ADMRepTest%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMRepTest%'`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'ADMRepTest%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'ADMRepTest%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMRepTest%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMRepTest%'`);
}

async function insertUser(
  name: string,
  role: "STUDENT" | "LECTURER" | "ADMIN",
  status: string,
  username: string | null
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, passwordHash, role, status, username]
  );
  return Number(result.rows[0].id);
}

async function insertStudent(matric: string, name: string): Promise<{ userId: number; profileId: number }> {
  const userId = await insertUser(name, "STUDENT", "ACTIVE", null);
  const profile = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, matric, depId, level100Id]
  );
  return { userId, profileId: Number(profile.rows[0].id) };
}

async function insertLecturer(
  staffId: string,
  name: string
): Promise<{ userId: number; profileId: number }> {
  const userId = await insertUser(name, "LECTURER", "ACTIVE", null);
  const profile = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, staffId, depId]
  );
  return { userId, profileId: Number(profile.rows[0].id) };
}

async function insertSession(
  offeringId: number,
  lecturerId: number,
  status: "ACTIVE" | "ENDED",
  startOffsetMinutes: number,
  endOffsetMinutes: number,
  endedAtOffsetMinutes: number | null
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4,
             now() + ($5 * interval '1 minute'), now() + ($6 * interval '1 minute'),
             '5 minutes', $7,
             CASE WHEN $8::bigint IS NULL THEN NULL ELSE now() + ($8 * interval '1 minute') END)
     RETURNING id`,
    [offeringId, lecturerId, network1Id, location1Id, startOffsetMinutes, endOffsetMinutes, status, endedAtOffsetMinutes]
  );
  return Number(result.rows[0].id);
}

async function insertRecord(sessionId: number, studentId: number, status: "PRESENT" | "LATE") {
  await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status)
     VALUES ($1, $2, $3)`,
    [sessionId, studentId, status]
  );
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  adminUserId = await insertUser("ADMRepTest Admin", "ADMIN", "ACTIVE", ADMIN_USERNAME);
  inactiveAdminUserId = await insertUser(
    "ADMRepTest Inactive Admin",
    "ADMIN",
    "INACTIVE",
    INACTIVE_ADMIN_USERNAME
  );

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('ADMRepTest Faculty', 'ADMRepTest-FAC') RETURNING id`
  );
  facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('ADMRepTest Department', 'ADMRepTest-DEP', $1) RETURNING id`,
    [facId]
  );
  depId = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acadA = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('ADMRepTest-ACAD-A', true) RETURNING id`
  );
  acadSessionAId = Number(acadA.rows[0].id);

  const acadB = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('ADMRepTest-ACAD-B', false) RETURNING id`
  );
  acadSessionBId = Number(acadB.rows[0].id);

  const sem1 = await pool.query(`SELECT id FROM semesters WHERE name = 'First Semester'`);
  firstSemesterId = Number(sem1.rows[0].id);

  const sem2 = await pool.query(`SELECT id FROM semesters WHERE name = 'Second Semester'`);
  secondSemesterId = Number(sem2.rows[0].id);

  const course1 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('ADMRepTest-CS101', 'ADMRepTest Course One', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course1Id = Number(course1.rows[0].id);

  const course2 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('ADMRepTest-CS102', 'ADMRepTest Course Two', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course2Id = Number(course2.rows[0].id);

  const offA = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course1Id, acadSessionAId, firstSemesterId]
  );
  offeringAId = Number(offA.rows[0].id);

  const offB = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course2Id, acadSessionAId, firstSemesterId]
  );
  offeringBId = Number(offB.rows[0].id);

  const offC = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course1Id, acadSessionBId, secondSemesterId]
  );
  offeringCId = Number(offC.rows[0].id);

  const offD = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course2Id, acadSessionBId, secondSemesterId]
  );
  offeringDId = Number(offD.rows[0].id);

  const net1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('ADMRepTest-NET1', 'ADMRepTest Network One') RETURNING id`
  );
  network1Id = Number(net1.rows[0].id);

  const loc1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('ADMRepTest-LOC1') RETURNING id`
  );
  location1Id = Number(loc1.rows[0].id);

  const lec1 = await insertLecturer(LECTURER_1_STAFF_ID, "ADMRepTest Lecturer One");
  lecturer1UserId = lec1.userId;
  lecturer1ProfileId = lec1.profileId;

  const lec2 = await insertLecturer(LECTURER_2_STAFF_ID, "ADMRepTest Lecturer Two");
  lecturer2UserId = lec2.userId;
  lecturer2ProfileId = lec2.profileId;

  const students: Array<[string, string]> = [
    [STU1, "ADMRepTest Student One"],
    [STU2, "ADMRepTest Student Two"],
    [STU3, "ADMRepTest Student Three"],
    [STU4, "ADMRepTest Student Four"],
    [STU5, "ADMRepTest Student Five"],
    [STU6, "ADMRepTest Student Six"],
  ];
  stuUserIds = [];
  stuProfileIds = {};
  for (const [matric, name] of students) {
    const s = await insertStudent(matric, name);
    stuUserIds.push(s.userId);
    stuProfileIds[matric] = s.profileId;
  }

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2), ($1, $3), ($4, $2)`,
    [offeringAId, lecturer1ProfileId, lecturer2ProfileId, offeringBId]
  );

  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED'), ($3, $2, 'ENROLLED'), ($4, $2, 'ENROLLED'),
            ($5, $2, 'DROPPED'), ($1, $6, 'ENROLLED'), ($7, $6, 'ENROLLED'),
            ($8, $9, 'ENROLLED')`,
    [
      stuProfileIds[STU1],
      offeringAId,
      stuProfileIds[STU2],
      stuProfileIds[STU3],
      stuProfileIds[STU4],
      offeringBId,
      stuProfileIds[STU5],
      stuProfileIds[STU6],
      offeringCId,
    ]
  );

  // Completed sessions on offering A (3 total).
  sessionA1 = await insertSession(offeringAId, lecturer1ProfileId, "ENDED", -300, -240, -240);
  sessionA2 = await insertSession(offeringAId, lecturer1ProfileId, "ENDED", -500, -440, -440);
  sessionA3 = await insertSession(offeringAId, lecturer1ProfileId, "ENDED", -700, -640, -640);

  // ACTIVE session (end in the future) - must be excluded from completed count.
  sessionActive = await insertSession(offeringAId, lecturer1ProfileId, "ACTIVE", -10, 50, null);

  // Expired but still flagged ACTIVE (end_time in the past) - must be excluded.
  sessionExpired = await insertSession(offeringAId, lecturer2ProfileId, "ACTIVE", -180, -60, null);

  // Completed session on the OTHER offering - records here must not leak.
  sessionBOffering = await insertSession(offeringBId, lecturer1ProfileId, "ENDED", -400, -340, -340);

  // Enrolled students
  await insertRecord(sessionA1, stuProfileIds[STU1], "PRESENT"); // STU1 present
  await insertRecord(sessionA1, stuProfileIds[STU2], "LATE");    // STU2 late
  await insertRecord(sessionA1, stuProfileIds[STU3], "PRESENT"); // STU3 present
  await insertRecord(sessionA1, stuProfileIds[STU4], "PRESENT"); // STU4 dropped, must not count
  await insertRecord(sessionA2, stuProfileIds[STU1], "PRESENT"); // STU1 present
  await insertRecord(sessionA2, stuProfileIds[STU2], "PRESENT"); // STU2 present
  await insertRecord(sessionA3, stuProfileIds[STU1], "PRESENT"); // STU1 present
  await insertRecord(sessionA3, stuProfileIds[STU3], "PRESENT"); // STU3 present

  // Records in sessions that must NOT count.
  await insertRecord(sessionActive, stuProfileIds[STU1], "PRESENT");   // active session record
  await insertRecord(sessionExpired, stuProfileIds[STU2], "LATE");     // expired ACTIVE record
  await insertRecord(sessionBOffering, stuProfileIds[STU1], "PRESENT"); // other offering record
  await insertRecord(sessionBOffering, stuProfileIds[STU5], "PRESENT"); // other-offering-only student

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
    matricNumber: STU1,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token);
  return token;
}

async function lecturerToken(): Promise<string> {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_1_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token);
  return token;
}

async function createInactiveAdminSession(): Promise<string> {
  const token = generateSessionToken();
  const session = await createSession(
    inactiveAdminUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60_000)
  );
  assert.ok(session);
  return token;
}

function reportUrl(offeringId: number | string): string {
  return `/api/admin/attendance-reports/course-offering/${offeringId}`;
}

interface ReportBody {
  data?: {
    courseOffering?: Record<string, unknown>;
    students?: Array<Record<string, unknown>>;
  };
}

function studentList(body: unknown): Array<Record<string, unknown>> {
  const report = body as ReportBody;
  assert.ok(Array.isArray(report.data?.students));
  return report.data!.students!;
}

function findStudent(
  students: Array<Record<string, unknown>>,
  matricNumber: string
): Record<string, unknown> {
  const found = students.find((s) => s.matricNumber === matricNumber);
  assert.ok(found, `expected student ${matricNumber} in report`);
  return found;
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated request → 401
// ---------------------------------------------------------------------------

test("unauthenticated request is rejected with 401", async () => {
  const res = await get(reportUrl(offeringAId));
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// 2. Student request → 403
// ---------------------------------------------------------------------------

test("student request is rejected with 403", async () => {
  const token = await studentToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 3. Lecturer request → 403
// ---------------------------------------------------------------------------

test("lecturer request is rejected with 403", async () => {
  const token = await lecturerToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 4. Inactive admin → 401
// ---------------------------------------------------------------------------

test("inactive admin session is rejected with 401", async () => {
  const token = await createInactiveAdminSession();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// 5. Admin can retrieve the report
// ---------------------------------------------------------------------------

test("admin can retrieve a report for a course offering", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  const offering = body.data!.courseOffering!;

  assert.equal(offering.id, offeringAId);
  assert.equal(offering.courseId, course1Id);
  assert.equal(offering.courseCode, "ADMRepTest-CS101");
  assert.equal(offering.courseTitle, "ADMRepTest Course One");
  assert.equal(offering.academicSessionId, acadSessionAId);
  assert.equal(offering.academicSessionName, "ADMRepTest-ACAD-A");
  assert.equal(offering.semesterId, firstSemesterId);
  assert.equal(offering.semesterName, "First Semester");
  assert.equal(offering.levelId, level100Id);
  assert.equal(offering.levelName, 100);
  assert.equal(offering.totalCompletedSessions, 3);

  const lecturers = offering.lecturers as Array<Record<string, unknown>>;
  assert.equal(lecturers.length, 2);
  const staffIds = lecturers.map((l) => l.staffId);
  assert.ok(staffIds.includes(LECTURER_1_STAFF_ID));
  assert.ok(staffIds.includes(LECTURER_2_STAFF_ID));
  assert.ok(lecturers.every((l) => typeof l.name === "string"));

  const students = body.data!.students!;
  assert.equal(students.length, 3);
  for (const student of students) {
    assert.equal(typeof student.studentId, "number");
    assert.equal(typeof student.matricNumber, "string");
    assert.equal(typeof student.studentName, "string");
    assert.equal(student.totalCompletedSessions, 3);
    assert.equal(typeof student.presentCount, "number");
    assert.equal(typeof student.lateCount, "number");
    assert.equal(typeof student.absentCount, "number");
    assert.equal(typeof student.attendancePercentage, "number");
  }
});

// ---------------------------------------------------------------------------
// 6. Missing course offering → 404
// ---------------------------------------------------------------------------

test("missing course offering returns OFFERING_NOT_FOUND", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(999999), cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "OFFERING_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 7. Invalid id → 400
// ---------------------------------------------------------------------------

test("invalid course offering id returns INVALID_REQUEST", async () => {
  const token = await adminToken();
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    const res = await get(reportUrl(bad), cookieHeader(token));
    assert.equal(res.status, 400, `expected 400 for "${bad}"`);
    assertInvalidRequest(await res.json());
  }
});

// ---------------------------------------------------------------------------
// 8. Offering with no enrolled students
// ---------------------------------------------------------------------------

test("offering with no enrolled students returns an empty student list", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringDId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.id, offeringDId);
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 0);
  assert.deepEqual(body.data!.students, []);
});

// ---------------------------------------------------------------------------
// 9. Offering with no completed sessions
// ---------------------------------------------------------------------------

test("offering with no completed sessions reports zero activity and null percentage", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringCId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 0);

  const students = body.data!.students!;
  assert.equal(students.length, 1);
  const s = students[0];
  assert.equal(s.studentId, stuProfileIds[STU6]);
  assert.equal(s.totalCompletedSessions, 0);
  assert.equal(s.presentCount, 0);
  assert.equal(s.lateCount, 0);
  assert.equal(s.absentCount, 0);
  assert.equal(s.attendancePercentage, null);
});

// ---------------------------------------------------------------------------
// 10. Correct PRESENT/LATE/ABSENT counts
// ---------------------------------------------------------------------------

test("report counts PRESENT, LATE, and ABSENT correctly per student", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  const s1 = findStudent(students, STU1);
  assert.equal(s1.presentCount, 3);
  assert.equal(s1.lateCount, 0);
  assert.equal(s1.absentCount, 0);

  const s2 = findStudent(students, STU2);
  assert.equal(s2.presentCount, 1);
  assert.equal(s2.lateCount, 1);
  assert.equal(s2.absentCount, 1);

  const s3 = findStudent(students, STU3);
  assert.equal(s3.presentCount, 2);
  assert.equal(s3.lateCount, 0);
  assert.equal(s3.absentCount, 1);
});

// ---------------------------------------------------------------------------
// 11. Correct percentage (PRESENT + LATE count as attendance)
// ---------------------------------------------------------------------------

test("report percentage counts PRESENT and LATE as attendance", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  assert.equal(findStudent(students, STU1).attendancePercentage, 100);
  // STU2 attended 2 of 3 completed sessions (one PRESENT, one LATE): LATE counts as attendance.
  assert.equal(findStudent(students, STU2).attendancePercentage, 66.67);
  assert.equal(findStudent(students, STU3).attendancePercentage, 66.67);
});

// ---------------------------------------------------------------------------
// 12. Active session excluded
// ---------------------------------------------------------------------------

test("active sessions are not counted as completed sessions", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 3);

  // STU1 has a PRESENT record on the active session; it must not raise presentCount.
  const s1 = findStudent(body.data!.students!, STU1);
  assert.equal(s1.presentCount, 3);
  assert.equal(s1.totalCompletedSessions, 3);
});

// ---------------------------------------------------------------------------
// 13. Expired-but-still-ACTIVE session excluded
// ---------------------------------------------------------------------------

test("expired-but-unended sessions are not counted as completed sessions", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 3);

  // STU2 has a LATE record on the expired-but-ACTIVE session; it must not count.
  const s2 = findStudent(body.data!.students!, STU2);
  assert.equal(s2.lateCount, 1);
  assert.equal(s2.totalCompletedSessions, 3);
});

// ---------------------------------------------------------------------------
// 14. Students from another offering excluded
// ---------------------------------------------------------------------------

test("students enrolled only in another offering are excluded", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());
  const matricNumbers = students.map((s) => s.matricNumber);

  assert.deepEqual(matricNumbers.sort(), [STU1, STU2, STU3].sort());
  assert.ok(!matricNumbers.includes(STU4), "dropped students must not appear");
  assert.ok(!matricNumbers.includes(STU5), "other-offering students must not appear");
});

// ---------------------------------------------------------------------------
// 15. Attendance records from another offering excluded
// ---------------------------------------------------------------------------

test("attendance from another offering is excluded", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  // STU1 has a PRESENT record in offering B's completed session; it must not leak
  // into offering A's report (present stays 3, not 4).
  const s1 = findStudent(students, STU1);
  assert.equal(s1.presentCount, 3);
  assert.equal(s1.totalCompletedSessions, 3);
});

// ---------------------------------------------------------------------------
// 16. Multiple sessions aggregated correctly
// ---------------------------------------------------------------------------

test("multiple completed sessions are aggregated correctly", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 3);

  // STU1 attended all 3 completed sessions (sessionA1, sessionA2, sessionA3).
  const s1 = findStudent(body.data!.students!, STU1);
  assert.equal(s1.presentCount, 3);
  assert.equal(s1.absentCount, 0);

  // STU2 attended sessionA1 (late) and sessionA2 (present), absent in sessionA3.
  const s2 = findStudent(body.data!.students!, STU2);
  assert.equal(s2.presentCount, 1);
  assert.equal(s2.lateCount, 1);
  assert.equal(s2.absentCount, 1);

  // STU3 attended sessionA1 and sessionA3, absent in sessionA2.
  const s3 = findStudent(body.data!.students!, STU3);
  assert.equal(s3.presentCount, 2);
  assert.equal(s3.lateCount, 0);
  assert.equal(s3.absentCount, 1);
});

// ---------------------------------------------------------------------------
// 17. No duplicate counting
// ---------------------------------------------------------------------------

test("duplicate attendance records cannot be inserted and do not double count", async () => {
  // The schema forbids duplicate (session, student) records via a UNIQUE
  // constraint, so a duplicate PRESENT row for STU1 on sessionA1 is rejected.
  await assert.rejects(
    pool.query(
      `INSERT INTO attendance_records (session_id, student_id, status)
       VALUES ($1, $2, 'PRESENT')`,
      [sessionA1, stuProfileIds[STU1]]
    ),
    (error: unknown) => (error as { code?: string }).code === "23505"
  );

  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const s1 = findStudent(studentList(await res.json()), STU1);
  assert.equal(s1.presentCount, 3, "present count must not double count");
});