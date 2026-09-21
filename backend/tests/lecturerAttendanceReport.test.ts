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
import { getLecturerCourseOfferingReport } from "../src/services/lecturerAttendanceReportStore";

const TEST_PASSWORD = "lec-rep-test-pw";
const ADMIN_USERNAME = "LECRepTest_Admin";
const INACTIVE_LECTURER_STAFF_ID = "LECRepTest/LEC-INACTIVE";

const LEC1_STAFF_ID = "LECRepTest/LEC1";
const LEC2_STAFF_ID = "LECRepTest/LEC2";

const STU1 = "LECRepTest/STU1";
const STU2 = "LECRepTest/STU2";
const STU3 = "LECRepTest/STU3";
const STU4 = "LECRepTest/STU4";
const STU5 = "LECRepTest/STU5";
const STU6 = "LECRepTest/STU6";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let inactiveLecturerUserId = 0;

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
let courseInactiveId = 0;

let offeringAId = 0; // open, active course, assigned to lec1 + lec2 (main report)
let offeringBId = 0; // open, assigned only to lec2 (not accessible to lec1)
let offeringCId = 0; // open, assigned to lec1, one enrolled student, no sessions
let offeringClosedId = 0; // CLOSED, assigned to lec1 (must be hidden)
let offeringInactiveId = 0; // OPEN but course INACTIVE, assigned to lec1 (must be hidden)

let network1Id = 0;
let location1Id = 0;

let sessionA1 = 0; // ENDED (latest) - lec1
let sessionA2 = 0; // ENDED - lec1
let sessionA3 = 0; // ENDED (oldest) - lec2 (different assigned lecturer)
let sessionActive = 0; // ACTIVE (end in the future) - lec1
let sessionExpired = 0; // ACTIVE but past end_time - lec2
let sessionBOffering = 0; // ENDED on offering B - lec1

function userIds(): number[] {
  return [
    adminUserId,
    inactiveLecturerUserId,
    ...stuUserIds,
    lecturer1UserId,
    lecturer2UserId,
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
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LECRepTest%')
     ) OR student_id IN (
       SELECT id FROM students WHERE user_id = ANY($1::BIGINT[])
     )`,
    [userIds()]
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LECRepTest%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LECRepTest%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'LECRepTest%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'LECRepTest%'`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'LECRepTest%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'LECRepTest%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'LECRepTest%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'LECRepTest%'`);
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

async function insertCourse(
  code: string,
  title: string,
  status = "ACTIVE"
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [code, title, facId, level100Id, status]
  );
  return Number(result.rows[0].id);
}

async function insertOffering(
  courseId: number,
  academicSessionId: number,
  semesterId: number,
  status = "OPEN"
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [courseId, academicSessionId, semesterId, status]
  );
  return Number(result.rows[0].id);
}

async function assignLecturer(offeringId: number, lecturerId: number): Promise<void> {
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offeringId, lecturerId]
  );
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

  adminUserId = await insertUser("LECRepTest Admin", "ADMIN", "ACTIVE", ADMIN_USERNAME);
  inactiveLecturerUserId = await insertUser(
    "LECRepTest Inactive Lecturer",
    "LECTURER",
    "INACTIVE",
    null
  );

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('LECRepTest Faculty', 'LECRepTest-FAC') RETURNING id`
  );
  facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('LECRepTest Department', 'LECRepTest-DEP', $1) RETURNING id`,
    [facId]
  );
  depId = Number(dep.rows[0].id);

  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [inactiveLecturerUserId, INACTIVE_LECTURER_STAFF_ID, depId]
  );

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acadA = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('LECRepTest-ACAD-A', true) RETURNING id`
  );
  acadSessionAId = Number(acadA.rows[0].id);

  const acadB = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('LECRepTest-ACAD-B', false) RETURNING id`
  );
  acadSessionBId = Number(acadB.rows[0].id);

  const sem1 = await pool.query(`SELECT id FROM semesters WHERE name = 'First Semester'`);
  firstSemesterId = Number(sem1.rows[0].id);

  const sem2 = await pool.query(`SELECT id FROM semesters WHERE name = 'Second Semester'`);
  secondSemesterId = Number(sem2.rows[0].id);

  course1Id = await insertCourse("LECRepTest-CS101", "LECRepTest Course One");
  course2Id = await insertCourse("LECRepTest-CS102", "LECRepTest Course Two");
  courseInactiveId = await insertCourse(
    "LECRepTest-CS103",
    "LECRepTest Course Inactive",
    "INACTIVE"
  );

  offeringAId = await insertOffering(course1Id, acadSessionAId, firstSemesterId);
  offeringBId = await insertOffering(course2Id, acadSessionAId, firstSemesterId);
  offeringCId = await insertOffering(course1Id, acadSessionBId, secondSemesterId);
  offeringClosedId = await insertOffering(
    course1Id,
    acadSessionBId,
    firstSemesterId,
    "CLOSED"
  );
  offeringInactiveId = await insertOffering(
    courseInactiveId,
    acadSessionAId,
    secondSemesterId
  );

  const net1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('LECRepTest-NET1', 'LECRepTest Network One') RETURNING id`
  );
  network1Id = Number(net1.rows[0].id);

  const loc1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('LECRepTest-LOC1') RETURNING id`
  );
  location1Id = Number(loc1.rows[0].id);

  const lec1 = await insertLecturer(LEC1_STAFF_ID, "LECRepTest Lecturer One");
  lecturer1UserId = lec1.userId;
  lecturer1ProfileId = lec1.profileId;

  const lec2 = await insertLecturer(LEC2_STAFF_ID, "LECRepTest Lecturer Two");
  lecturer2UserId = lec2.userId;
  lecturer2ProfileId = lec2.profileId;

  const students: Array<[string, string]> = [
    [STU1, "LECRepTest Student One"],
    [STU2, "LECRepTest Student Two"],
    [STU3, "LECRepTest Student Three"],
    [STU4, "LECRepTest Student Four"],
    [STU5, "LECRepTest Student Five"],
    [STU6, "LECRepTest Student Six"],
  ];
  stuUserIds = [];
  stuProfileIds = {};
  for (const [matric, name] of students) {
    const s = await insertStudent(matric, name);
    stuUserIds.push(s.userId);
    stuProfileIds[matric] = s.profileId;
  }

  // offeringA: lec1 + lec2  | offeringB: lec2   | closed/inactive: lec1
  await assignLecturer(offeringAId, lecturer1ProfileId);
  await assignLecturer(offeringAId, lecturer2ProfileId);
  await assignLecturer(offeringBId, lecturer2ProfileId);
  await assignLecturer(offeringCId, lecturer1ProfileId);
  await assignLecturer(offeringClosedId, lecturer1ProfileId);
  await assignLecturer(offeringInactiveId, lecturer1ProfileId);

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

  // Completed sessions on offering A (3 total). A3 is started by lec2: sessions
  // started by any assigned lecturer must count and carry that lecturer's name.
  sessionA1 = await insertSession(offeringAId, lecturer1ProfileId, "ENDED", -300, -240, -240);
  sessionA2 = await insertSession(offeringAId, lecturer1ProfileId, "ENDED", -500, -440, -440);
  sessionA3 = await insertSession(offeringAId, lecturer2ProfileId, "ENDED", -700, -640, -640);

  sessionActive = await insertSession(offeringAId, lecturer1ProfileId, "ACTIVE", -10, 50, null);
  sessionExpired = await insertSession(offeringAId, lecturer2ProfileId, "ACTIVE", -180, -60, null);

  sessionBOffering = await insertSession(offeringBId, lecturer1ProfileId, "ENDED", -400, -340, -340);

  await insertRecord(sessionA1, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionA1, stuProfileIds[STU2], "LATE");
  await insertRecord(sessionA1, stuProfileIds[STU3], "PRESENT");
  await insertRecord(sessionA1, stuProfileIds[STU4], "PRESENT"); // dropped, must not count
  await insertRecord(sessionA2, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionA2, stuProfileIds[STU2], "PRESENT");
  await insertRecord(sessionA3, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionA3, stuProfileIds[STU3], "PRESENT");

  // Records that must NOT count.
  await insertRecord(sessionActive, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionExpired, stuProfileIds[STU2], "LATE");
  await insertRecord(sessionBOffering, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionBOffering, stuProfileIds[STU5], "PRESENT");

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

async function lecturer1Token(): Promise<string> {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LEC1_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token, "lecturer login should issue a session cookie");
  return token;
}

async function lecturer2Token(): Promise<string> {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LEC2_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token, "lecturer login should issue a session cookie");
  return token;
}

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

async function createInactiveLecturerSession(): Promise<string> {
  const token = generateSessionToken();
  const session = await createSession(
    inactiveLecturerUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60_000)
  );
  assert.ok(session);
  return token;
}

function reportUrl(offeringId: number | string): string {
  return `/api/lecturer/attendance-reports/course-offering/${offeringId}`;
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
// 3. Admin request → 403
// ---------------------------------------------------------------------------

test("admin request is rejected with 403", async () => {
  const token = await adminToken();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 4. Inactive lecturer → 401
// ---------------------------------------------------------------------------

test("inactive lecturer session is rejected with 401", async () => {
  const token = await createInactiveLecturerSession();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// 5. Assigned lecturer can retrieve the report with correct context
// ---------------------------------------------------------------------------

test("assigned lecturer can retrieve a full report for their offering", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  const offering = body.data!.courseOffering!;

  assert.equal(offering.courseOfferingId, offeringAId);
  assert.equal(offering.courseId, course1Id);
  assert.equal(offering.courseCode, "LECRepTest-CS101");
  assert.equal(offering.courseTitle, "LECRepTest Course One");
  assert.equal(offering.academicSession, "LECRepTest-ACAD-A");
  assert.equal(offering.semester, "First Semester");
  assert.equal(offering.level, 100);
  assert.equal(offering.totalCompletedSessions, 3);

  // Lecturer identity is the requesting lecturer, not a list of everyone.
  assert.equal(offering.lecturer.id, lecturer1ProfileId);
  assert.equal(offering.lecturer.staffId, LEC1_STAFF_ID);
  assert.equal(offering.lecturer.name, "LECRepTest Lecturer One");

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
    assert.equal(Array.isArray(student.sessions), true);
    assert.equal((student.sessions as unknown[]).length, 3);
  }
});

// ---------------------------------------------------------------------------
// 6. Lecturer not assigned to an existing offering → 404, no existence leak
// ---------------------------------------------------------------------------

test("existing offering not assigned to the lecturer returns OFFERING_NOT_FOUND", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringBId), cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "OFFERING_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 7. Missing offering → 404 with identical message
// ---------------------------------------------------------------------------

test("missing course offering returns OFFERING_NOT_FOUND with the same message", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(999999), cookieHeader(token));
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, "OFFERING_NOT_FOUND");
  assert.equal(body.message, "The course offering was not found.");
});

// ---------------------------------------------------------------------------
// 8. Invalid id → 400
// ---------------------------------------------------------------------------

test("invalid course offering id returns INVALID_REQUEST", async () => {
  const token = await lecturer1Token();
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    const res = await get(reportUrl(bad), cookieHeader(token));
    assert.equal(res.status, 400, `expected 400 for "${bad}"`);
    assertInvalidRequest(await res.json());
  }
});

// ---------------------------------------------------------------------------
// 9. CLOSED offering (even if assigned) → 404
// ---------------------------------------------------------------------------

test("closed offering is hidden from an assigned lecturer", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringClosedId), cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "OFFERING_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 10. Offering of an INACTIVE course → 404
// ---------------------------------------------------------------------------

test("offering on an inactive course is hidden from an assigned lecturer", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringInactiveId), cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "OFFERING_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 11. Only ENROLLED students appear (dropped and other-offering students excluded)
// ---------------------------------------------------------------------------

test("only currently enrolled students appear in the report", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const matricNumbers = studentList(await res.json()).map((s) => s.matricNumber);

  assert.deepEqual(matricNumbers.sort(), [STU1, STU2, STU3].sort());
  assert.ok(!matricNumbers.includes(STU4), "dropped students must not appear");
  assert.ok(!matricNumbers.includes(STU5), "other-offering students must not appear");
});

// ---------------------------------------------------------------------------
// 12. Correct PRESENT/LATE/ABSENT counts per student
// ---------------------------------------------------------------------------

test("report counts PRESENT, LATE, and ABSENT correctly per student", async () => {
  const token = await lecturer1Token();
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
// 13. Percentage counts PRESENT + LATE, rounded to 2 decimals
// ---------------------------------------------------------------------------

test("report percentage counts PRESENT and LATE as attendance and rounds", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  assert.equal(findStudent(students, STU1).attendancePercentage, 100);
  assert.equal(findStudent(students, STU2).attendancePercentage, 66.67);
  assert.equal(findStudent(students, STU3).attendancePercentage, 66.67);
});

// ---------------------------------------------------------------------------
// 14. No completed sessions → null percentage and empty session history
// ---------------------------------------------------------------------------

test("offering with no completed sessions reports null percentage and empty history", async () => {
  const token = await lecturer1Token();
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
  assert.deepEqual(s.sessions, []);
});

// ---------------------------------------------------------------------------
// 15. ACTIVE sessions excluded
// ---------------------------------------------------------------------------

test("active sessions are not counted as completed", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 3);

  const s1 = findStudent(body.data!.students!, STU1);
  assert.equal(s1.totalCompletedSessions, 3);
  assert.equal(s1.presentCount, 3, "active-session record must not count");
});

// ---------------------------------------------------------------------------
// 16. Expired-but-still-ACTIVE sessions excluded
// ---------------------------------------------------------------------------

test("expired-but-unended sessions are not counted as completed", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 3);

  const s2 = findStudent(body.data!.students!, STU2);
  assert.equal(s2.lateCount, 1, "expired-session record must not count");
  assert.equal(s2.totalCompletedSessions, 3);
});

// ---------------------------------------------------------------------------
// 17. Attendance records from another offering excluded
// ---------------------------------------------------------------------------

test("attendance from another offering is excluded", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const s1 = findStudent(studentList(await res.json()), STU1);
  assert.equal(s1.presentCount, 3);
  assert.equal(s1.totalCompletedSessions, 3);
});

// ---------------------------------------------------------------------------
// 18. Per-student history contains only ENDED sessions
// ---------------------------------------------------------------------------

test("per-student history lists only ended sessions", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  const s1 = findStudent(body.data!.students!, STU1);
  const sessionIds = (s1.sessions as Array<Record<string, unknown>>).map((s) => s.sessionId);

  assert.deepEqual(sessionIds.sort(), [sessionA1, sessionA2, sessionA3].sort());
  assert.ok(!sessionIds.includes(sessionActive), "active session must not appear");
  assert.ok(!sessionIds.includes(sessionExpired), "expired session must not appear");
  assert.ok(!sessionIds.includes(sessionBOffering), "other-offering session must not appear");
});

// ---------------------------------------------------------------------------
// 19. ABSENT is inferred, never written
// ---------------------------------------------------------------------------

test("absence is inferred from a missing record and no ABSENT rows are written", async () => {
  const before = await pool.query(
    `SELECT COUNT(*)::int AS count FROM attendance_records
     WHERE session_id = ANY($1::BIGINT[])`,
    [[sessionA1, sessionA2, sessionA3, sessionActive, sessionExpired, sessionBOffering]]
  );

  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  const s2 = findStudent(students, STU2);
  const s2Sessions = s2.sessions as Array<Record<string, unknown>>;
  const a3 = s2Sessions.find((s) => s.sessionId === sessionA3);
  assert.ok(a3, "expected STU2 history to include the oldest ended session");
  assert.equal(a3!.status, "ABSENT");
  assert.equal(a3!.markedAt, null);

  // STU3 was absent from sessionA2.
  const s3 = findStudent(students, STU3);
  const s3Sessions = s3.sessions as Array<Record<string, unknown>>;
  const a2 = s3Sessions.find((s) => s.sessionId === sessionA2);
  assert.ok(a2, "expected STU3 history to include the middle ended session");
  assert.equal(a2!.status, "ABSENT");
  assert.equal(a2!.markedAt, null);

  const absentRows = await pool.query(
    `SELECT COUNT(*)::int AS count FROM attendance_records WHERE status = 'ABSENT'`
  );
  assert.equal(absentRows.rows[0].count, 0, "ABSENT can never be stored");

  const after = await pool.query(
    `SELECT COUNT(*)::int AS count FROM attendance_records
     WHERE session_id = ANY($1::BIGINT[])`,
    [[sessionA1, sessionA2, sessionA3, sessionActive, sessionExpired, sessionBOffering]]
  );
  assert.equal(before.rows[0].count, after.rows[0].count, "report must be read-only");
});

// ---------------------------------------------------------------------------
// 20. Session detail fields complete
// ---------------------------------------------------------------------------

test("session details expose the required fields", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const s1 = findStudent(studentList(await res.json()), STU1);
  const sessions = s1.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 3);
  for (const session of sessions) {
    assert.equal(typeof session.sessionId, "number");
    assert.equal(typeof session.startTime, "string");
    assert.equal(typeof session.endTime, "string");
    assert.equal(typeof session.lecturerName, "string");
    assert.equal(typeof session.locationName, "string");
    assert.equal(typeof session.attendanceNetworkName, "string");
    assert.ok(["PRESENT", "LATE", "ABSENT"].includes(session.status as string));
  }
});

// ---------------------------------------------------------------------------
// 21. LATE sessions keep LATE status and marked time
// ---------------------------------------------------------------------------

test("PRESENT and LATE records carry their status and marked time", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const s2 = findStudent(studentList(await res.json()), STU2);
  const sessions = s2.sessions as Array<Record<string, unknown>>;

  const a1 = sessions.find((s) => s.sessionId === sessionA1);
  assert.ok(a1);
  assert.equal(a1!.status, "LATE");
  assert.equal(typeof a1!.markedAt, "string");

  const a2 = sessions.find((s) => s.sessionId === sessionA2);
  assert.ok(a2);
  assert.equal(a2!.status, "PRESENT");
  assert.equal(typeof a2!.markedAt, "string");
});

// ---------------------------------------------------------------------------
// 22. Sessions started by another assigned lecturer count and identify them
// ---------------------------------------------------------------------------

test("a session started by a co-assigned lecturer counts and shows their name", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.totalCompletedSessions, 3);

  const s1 = findStudent(body.data!.students!, STU1);
  const a3 = (s1.sessions as Array<Record<string, unknown>>).find(
    (s) => s.sessionId === sessionA3
  );
  assert.ok(a3);
  assert.equal(a3!.lecturerName, "LECRepTest Lecturer Two");
  assert.equal(a3!.locationName, "LECRepTest-LOC1");
  assert.equal(a3!.attendanceNetworkName, "LECRepTest Network One");
});

// ---------------------------------------------------------------------------
// 23. Session history is ordered newest first
// ---------------------------------------------------------------------------

test("per-student session history is ordered by end time descending", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const s1 = findStudent(studentList(await res.json()), STU1);
  const sessionIds = (s1.sessions as Array<Record<string, unknown>>).map((s) => s.sessionId);
  assert.deepEqual(sessionIds, [sessionA1, sessionA2, sessionA3]);
});

// ---------------------------------------------------------------------------
// 24. Client-supplied lecturerId is ignored
// ---------------------------------------------------------------------------

test("a client-supplied lecturerId cannot change the report scope", async () => {
  const token = await lecturer1Token();
  const [defaultRes, tamperedRes] = await Promise.all([
    get(reportUrl(offeringAId), cookieHeader(token)),
    get(`${reportUrl(offeringAId)}?lecturerId=${lecturer2ProfileId}`, cookieHeader(token)),
  ]);
  assert.equal(defaultRes.status, 200);
  assert.equal(tamperedRes.status, 200);
  assert.deepEqual(await tamperedRes.json(), await defaultRes.json());
});

// ---------------------------------------------------------------------------
// 25. A co-assigned lecturer (lec2) can view the shared offering
// ---------------------------------------------------------------------------

test("another co-assigned lecturer can view the same offering with their own identity", async () => {
  const token = await lecturer2Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReportBody;
  assert.equal(body.data!.courseOffering!.courseOfferingId, offeringAId);
  assert.equal(body.data!.courseOffering!.lecturer.staffId, LEC2_STAFF_ID);
  assert.equal(studentList(body).length, 3);
});

// ---------------------------------------------------------------------------
// 26. Removing the assignment hides the offering again
// ---------------------------------------------------------------------------

test("an offerer no longer assigned gets OFFERING_NOT_FOUND", async () => {
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id = $1 AND lecturer_id = $2`,
    [offeringAId, lecturer1ProfileId]
  );
  try {
    const token = await lecturer1Token();
    const res = await get(reportUrl(offeringAId), cookieHeader(token));
    assert.equal(res.status, 404);
    assertErrorCode(await res.json(), "OFFERING_NOT_FOUND");
  } finally {
    await assignLecturer(offeringAId, lecturer1ProfileId);
  }
});

// ---------------------------------------------------------------------------
// 27. Response shape has no accidental internal fields
// ---------------------------------------------------------------------------

test("report students expose only the documented keys", async () => {
  const token = await lecturer1Token();
  const res = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());
  assert.ok(students.length > 0);
  for (const student of students) {
    assert.deepEqual(Object.keys(student).sort(), [
      "absentCount",
      "attendancePercentage",
      "lateCount",
      "matricNumber",
      "presentCount",
      "sessions",
      "studentId",
      "studentName",
      "totalCompletedSessions",
    ]);
    assert.ok(!("userId" in student), "internal userId must not leak");
  }
  const sessions = students[0].sessions as Array<Record<string, unknown>>;
  assert.ok(sessions.length > 0);
  assert.deepEqual(Object.keys(sessions[0]).sort(), [
    "attendanceNetworkName",
    "endTime",
    "lecturerName",
    "locationName",
    "markedAt",
    "sessionId",
    "startTime",
    "status",
  ]);
});

// ---------------------------------------------------------------------------
// 28. Report generation is bounded (no N+1)
// ---------------------------------------------------------------------------

test("generating a report uses a bounded number of queries regardless of enrollments", async () => {
  const originalQuery = pool.query.bind(pool);
  let queryCount = 0;
  const countingQuery = (async (
    ...args: Parameters<typeof pool.query>
  ) => {
    queryCount += 1;
    return originalQuery(...args);
  }) as typeof pool.query;
  pool.query = countingQuery;
  try {
    const result = await getLecturerCourseOfferingReport(lecturer1UserId, offeringAId);
    assert.equal(result.ok, true);
    assert.equal(queryCount, 4, "profile + context + aggregates + details");
  } finally {
    pool.query = originalQuery;
  }
});

// ---------------------------------------------------------------------------
// 29. No cross-offering students bleed into another lecturer's report
// ---------------------------------------------------------------------------

test("students of an unshared offering do not appear in another report", async () => {
  const token = await lecturer2Token();
  const res = await get(reportUrl(offeringBId), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());
  const matricNumbers = students.map((s) => s.matricNumber);
  assert.deepEqual(matricNumbers.sort(), [STU1, STU5].sort());
  // STU1's PRESENT record on offering A's sessions must not leak into offering B.
  const s1 = findStudent(students, STU1);
  const sessions = s1.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionBOffering);
  assert.equal(s1.presentCount, 1);
  assert.equal(s1.absentCount, 0);
});

// ---------------------------------------------------------------------------
// 30. Report is read-only across repeated fetches
// ---------------------------------------------------------------------------

test("repeated fetches never modify attendance data", async () => {
  const token = await lecturer1Token();
  const first = await get(reportUrl(offeringAId), cookieHeader(token));
  const second = await get(reportUrl(offeringAId), cookieHeader(token));
  const third = await get(reportUrl(offeringAId), cookieHeader(token));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(await second.json(), firstBody, "responses must be stable");
  assert.deepEqual(await third.json(), firstBody, "responses must be stable");
});