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
import { getLecturerSessionAttendanceReport } from "../src/services/lecturerAttendanceReportStore";
import { boundDeviceHeaders } from "./studentSessionTestHelpers";

const TEST_PASSWORD = "lec-ses-rep-test-pw";
const ADMIN_USERNAME = "LECSesRep_Admin";
const INACTIVE_LECTURER_STAFF_ID = "LECSesRep/LEC-INACTIVE";

const LEC1_STAFF_ID = "LECSesRep/LEC1";
const LEC2_STAFF_ID = "LECSesRep/LEC2";

const STU1 = "LECSesRep/STU1";
const STU2 = "LECSesRep/STU2";
const STU3 = "LECSesRep/STU3";
const STU4 = "LECSesRep/STU4";
const STU5 = "LECSesRep/STU5";

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

let offeringAId = 0; // open, active course, assigned to lec1 + lec2
let offeringBId = 0; // open, assigned only to lec2
let offeringClosedId = 0; // CLOSED, assigned to lec1
let offeringInactiveId = 0; // OPEN but course INACTIVE, assigned to lec1

let sessionMain = 0; // ENDED on offering A, started by lec1
let sessionCoLec = 0; // ENDED on offering A, started by lec2 (co-assigned)
let sessionActive = 0; // ACTIVE on offering A - lec1
let sessionB = 0; // ENDED on offering B - lec2
let sessionClosed = 0; // ENDED on the CLOSED offering - lec1
let sessionInactive = 0; // ENDED on the inactive-course offering - lec1

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
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LECSesRep%')
     ) OR student_id IN (
       SELECT id FROM students WHERE user_id = ANY($1::BIGINT[])
     )`,
    [userIds()]
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LECSesRep%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LECSesRep%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'LECSesRep%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'LECSesRep%'`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'LECSesRep%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'LECSesRep%'`);
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
           (course_offering_id, started_by_lecturer_id, start_time, end_time, late_threshold, status, ended_at)
         VALUES ($1, $2,
           now() + ($3 * interval '1 minute'), now() + ($4 * interval '1 minute'),
           '5 minutes', $5,
           CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() + ($6 * interval '1 minute') END)
     RETURNING id`,
        [offeringId, lecturerId, startOffsetMinutes, endOffsetMinutes, status, endedAtOffsetMinutes]
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

  adminUserId = await insertUser("LECSesRep Admin", "ADMIN", "ACTIVE", ADMIN_USERNAME);
  inactiveLecturerUserId = await insertUser(
    "LECSesRep Inactive Lecturer",
    "LECTURER",
    "INACTIVE",
    null
  );

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('LECSesRep Faculty', 'LECSesRep-FAC') RETURNING id`
  );
  facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('LECSesRep Department', 'LECSesRep-DEP', $1) RETURNING id`,
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
    `INSERT INTO academic_sessions (name, is_active) VALUES ('LECSesRep-ACAD-A', true) RETURNING id`
  );
  acadSessionAId = Number(acadA.rows[0].id);

  const acadB = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('LECSesRep-ACAD-B', false) RETURNING id`
  );
  acadSessionBId = Number(acadB.rows[0].id);

  const sem1 = await pool.query(`SELECT id FROM semesters WHERE name = 'First Semester'`);
  firstSemesterId = Number(sem1.rows[0].id);

  const sem2 = await pool.query(`SELECT id FROM semesters WHERE name = 'Second Semester'`);
  secondSemesterId = Number(sem2.rows[0].id);

  course1Id = await insertCourse("LECSesRep-CS101", "LECSesRep Course One");
  course2Id = await insertCourse("LECSesRep-CS102", "LECSesRep Course Two");
  courseInactiveId = await insertCourse(
    "LECSesRep-CS103",
    "LECSesRep Course Inactive",
    "INACTIVE"
  );

  offeringAId = await insertOffering(course1Id, acadSessionAId, firstSemesterId);
  offeringBId = await insertOffering(course2Id, acadSessionAId, firstSemesterId);
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

  const lec1 = await insertLecturer(LEC1_STAFF_ID, "LECSesRep Lecturer One");
  lecturer1UserId = lec1.userId;
  lecturer1ProfileId = lec1.profileId;

  const lec2 = await insertLecturer(LEC2_STAFF_ID, "LECSesRep Lecturer Two");
  lecturer2UserId = lec2.userId;
  lecturer2ProfileId = lec2.profileId;

  const students: Array<[string, string]> = [
    [STU1, "LECSesRep Student One"],
    [STU2, "LECSesRep Student Two"],
    [STU3, "LECSesRep Student Three"],
    [STU4, "LECSesRep Student Four"],
    [STU5, "LECSesRep Student Five"],
  ];
  stuUserIds = [];
  stuProfileIds = {};
  for (const [matric, name] of students) {
    const s = await insertStudent(matric, name);
    stuUserIds.push(s.userId);
    stuProfileIds[matric] = s.profileId;
  }

  // offeringA: lec1 + lec2 | offeringB: lec2 | closed/inactive: lec1
  await assignLecturer(offeringAId, lecturer1ProfileId);
  await assignLecturer(offeringAId, lecturer2ProfileId);
  await assignLecturer(offeringBId, lecturer2ProfileId);
  await assignLecturer(offeringClosedId, lecturer1ProfileId);
  await assignLecturer(offeringInactiveId, lecturer1ProfileId);

  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED'), ($3, $2, 'ENROLLED'), ($4, $2, 'ENROLLED'),
            ($5, $2, 'DROPPED'), ($6, $7, 'ENROLLED')`,
    [
      stuProfileIds[STU1],
      offeringAId,
      stuProfileIds[STU2],
      stuProfileIds[STU3],
      stuProfileIds[STU4],
      stuProfileIds[STU5],
      offeringBId,
    ]
  );

  sessionMain = await insertSession(offeringAId, lecturer1ProfileId, "ENDED", -300, -240, -240);
  sessionCoLec = await insertSession(offeringAId, lecturer2ProfileId, "ENDED", -700, -640, -640);
  sessionActive = await insertSession(offeringAId, lecturer1ProfileId, "ACTIVE", -10, 50, null);
  sessionB = await insertSession(offeringBId, lecturer2ProfileId, "ENDED", -400, -340, -340);
  sessionClosed = await insertSession(offeringClosedId, lecturer1ProfileId, "ENDED", -500, -440, -440);
  sessionInactive = await insertSession(offeringInactiveId, lecturer1ProfileId, "ENDED", -600, -540, -540);

  // sessionMain: STU1 PRESENT, STU2 LATE, STU3 absent (no record), STU4 dropped.
  await insertRecord(sessionMain, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionMain, stuProfileIds[STU2], "LATE");
  await insertRecord(sessionMain, stuProfileIds[STU4], "PRESENT"); // dropped, must not appear

  // sessionCoLec: only STU3 marked; STU1/STU2 records from sessionMain must not leak.
  await insertRecord(sessionCoLec, stuProfileIds[STU3], "PRESENT");

  // Records that must never surface in an ended-session report.
  await insertRecord(sessionActive, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionB, stuProfileIds[STU5], "PRESENT");
  await insertRecord(sessionClosed, stuProfileIds[STU1], "PRESENT");
  await insertRecord(sessionInactive, stuProfileIds[STU1], "PRESENT");

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
  }, await boundDeviceHeaders(STU1));
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

function sessionUrl(sessionId: number | string): string {
  return `/api/lecturer/attendance-reports/session/${sessionId}`;
}

interface SessionReportBody {
  data?: {
    session?: Record<string, unknown>;
    students?: Array<Record<string, unknown>>;
  };
}

function sessionBlock(body: unknown): Record<string, unknown> {
  const report = body as SessionReportBody;
  assert.ok(report.data?.session);
  return report.data!.session!;
}

function studentList(body: unknown): Array<Record<string, unknown>> {
  const report = body as SessionReportBody;
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
  const res = await get(sessionUrl(sessionMain));
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// 2. Student request → 403
// ---------------------------------------------------------------------------

test("student request is rejected with 403", async () => {
  const token = await studentToken();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 3. Admin request → 403
// ---------------------------------------------------------------------------

test("admin request is rejected with 403", async () => {
  const token = await adminToken();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 4. Inactive lecturer → 401
// ---------------------------------------------------------------------------

test("inactive lecturer session is rejected with 401", async () => {
  const token = await createInactiveLecturerSession();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// 5. Invalid id → 400
// ---------------------------------------------------------------------------

test("invalid attendance session id returns INVALID_REQUEST", async () => {
  const token = await lecturer1Token();
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    const res = await get(sessionUrl(bad), cookieHeader(token));
    assert.equal(res.status, 400, `expected 400 for "${bad}"`);
    assertInvalidRequest(await res.json());
  }
});

// ---------------------------------------------------------------------------
// 6. Assigned lecturer retrieves the report with complete session metadata
// ---------------------------------------------------------------------------

test("assigned lecturer retrieves the report with complete session metadata", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as SessionReportBody;
  const session = body.data!.session!;

  assert.equal(session.sessionId, sessionMain);
  assert.equal(session.courseCode, "LECSesRep-CS101");
  assert.equal(session.courseTitle, "LECSesRep Course One");
  assert.equal(session.academicSession, "LECSesRep-ACAD-A");
  assert.equal(session.semester, "First Semester");
  assert.equal(session.level, 100);
  assert.equal(session.lateThresholdMinutes, 5);
  assert.equal(typeof session.startTime, "string");
  assert.equal(typeof session.endTime, "string");
  assert.equal(typeof session.endedAt, "string");

  const startedBy = session.startedByLecturer as Record<string, unknown>;
  assert.ok(startedBy);
  assert.equal(startedBy.id, lecturer1ProfileId);
  assert.equal(startedBy.staffId, LEC1_STAFF_ID);
  assert.equal(startedBy.name, "LECSesRep Lecturer One");
});

// ---------------------------------------------------------------------------
// 7. Enrolled students appear with PRESENT / LATE / ABSENT; dropped excluded
// ---------------------------------------------------------------------------

test("enrolled students appear with their per-student status", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  assert.equal(students.length, 3, "only currently enrolled students appear");
  const matricNumbers = students.map((s) => s.matricNumber);
  assert.ok(!matricNumbers.includes(STU4), "dropped students must not appear");

  assert.equal(findStudent(students, STU1).status, "PRESENT");
  assert.equal(findStudent(students, STU2).status, "LATE");
  assert.equal(findStudent(students, STU3).status, "ABSENT");
});

// ---------------------------------------------------------------------------
// 8. markedAt is present for PRESENT/LATE and null for ABSENT
// ---------------------------------------------------------------------------

test("markedAt is set only for students who actually marked attendance", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  assert.equal(typeof findStudent(students, STU1).markedAt, "string");
  assert.equal(typeof findStudent(students, STU2).markedAt, "string");
  assert.equal(findStudent(students, STU3).markedAt, null);
});

// ---------------------------------------------------------------------------
// 9. Records from other sessions never leak into this session's report
// ---------------------------------------------------------------------------

test("attendance records from other sessions do not leak", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionCoLec), cookieHeader(token));
  assert.equal(res.status, 200);
  const students = studentList(await res.json());

  // STU1/STU2 only have records on sessionMain and sessionActive, never on
  // sessionCoLec, so they must be reported ABSENT here.
  assert.equal(findStudent(students, STU1).status, "ABSENT");
  assert.equal(findStudent(students, STU2).status, "ABSENT");
  assert.equal(findStudent(students, STU3).status, "PRESENT");
  // STU1's record on the ACTIVE session must also never surface.
  assert.equal(findStudent(students, STU1).markedAt, null);
});

// ---------------------------------------------------------------------------
// 10. Unassigned lecturer gets the same response as a missing session
// ---------------------------------------------------------------------------

test("unassigned lecturer gets the same isolation response as a missing session", async () => {
  const token = await lecturer1Token();
  const [unassignedRes, missingRes] = await Promise.all([
    get(sessionUrl(sessionB), cookieHeader(token)),
    get(sessionUrl(999999), cookieHeader(token)),
  ]);
  assert.equal(unassignedRes.status, 404);
  assert.equal(missingRes.status, 404);
  const unassignedBody = await unassignedRes.json();
  assertErrorCode(unassignedBody, "SESSION_NOT_FOUND");
  assert.deepEqual(unassignedBody, await missingRes.json());
});

// ---------------------------------------------------------------------------
// 11. Missing session → 404 with the documented message
// ---------------------------------------------------------------------------

test("missing attendance session returns SESSION_NOT_FOUND", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(999999), cookieHeader(token));
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, "SESSION_NOT_FOUND");
  assert.equal(body.message, "The attendance session was not found.");
});

// ---------------------------------------------------------------------------
// 12. ACTIVE session rejected
// ---------------------------------------------------------------------------

test("an active session is not reportable", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionActive), cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 13. Session on a CLOSED offering hidden from an assigned lecturer
// ---------------------------------------------------------------------------

test("a session on a closed offering is hidden from an assigned lecturer", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionClosed), cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 14. Session on an INACTIVE course hidden from an assigned lecturer
// ---------------------------------------------------------------------------

test("a session on an inactive course is hidden from an assigned lecturer", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionInactive), cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 15. Co-assigned lecturer can view a session started by another lecturer
// ---------------------------------------------------------------------------

test("a co-assigned lecturer can view a session started by another lecturer", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionCoLec), cookieHeader(token));
  assert.equal(res.status, 200);
  const session = sessionBlock(await res.json());
  assert.equal(session.sessionId, sessionCoLec);

  const startedBy = session.startedByLecturer as Record<string, unknown>;
  assert.equal(startedBy.id, lecturer2ProfileId);
  assert.equal(startedBy.staffId, LEC2_STAFF_ID);
  assert.equal(startedBy.name, "LECSesRep Lecturer Two");
});

// ---------------------------------------------------------------------------
// 16. The starting lecturer can also view it ( lec2 owns sessionCoLec )
// ---------------------------------------------------------------------------

test("the lecturer who started the session can view it", async () => {
  const token = await lecturer2Token();
  const res = await get(sessionUrl(sessionCoLec), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as SessionReportBody;
  const session = body.data!.session!;
  const startedBy = session.startedByLecturer as Record<string, unknown>;
  assert.equal(startedBy.staffId, LEC2_STAFF_ID);
  assert.equal(body.data!.students!.length, 3);
});

// ---------------------------------------------------------------------------
// 17. Client-supplied lecturerId is ignored
// ---------------------------------------------------------------------------

test("a client-supplied lecturerId cannot change the report scope", async () => {
  const token = await lecturer1Token();
  const [defaultRes, tamperedRes] = await Promise.all([
    get(sessionUrl(sessionMain), cookieHeader(token)),
    get(`${sessionUrl(sessionMain)}?lecturerId=${lecturer2ProfileId}`, cookieHeader(token)),
  ]);
  assert.equal(defaultRes.status, 200);
  assert.equal(tamperedRes.status, 200);
  assert.deepEqual(await tamperedRes.json(), await defaultRes.json());
});

// ---------------------------------------------------------------------------
// 18. No internal user IDs leak in the response
// ---------------------------------------------------------------------------

test("the response exposes only the documented keys", async () => {
  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as SessionReportBody;

  assert.deepEqual(Object.keys(body.data!.session!).sort(), [
    "academicSession",
    "courseCode",
    "courseTitle",
    "endTime",
    "endedAt",
    "lateThresholdMinutes",
    "level",
    "semester",
    "sessionId",
    "startTime",
    "startedByLecturer",
  ]);

  const students = body.data!.students!;
  assert.ok(students.length > 0);
  for (const student of students) {
    assert.deepEqual(Object.keys(student).sort(), [
      "markedAt",
      "matricNumber",
      "status",
      "studentId",
      "studentName",
    ]);
    assert.ok(!("userId" in student), "internal userId must not leak");
    assert.ok(["PRESENT", "LATE", "ABSENT"].includes(student.status as string));
  }
});

// ---------------------------------------------------------------------------
// 19. The report is read-only: no rows written or changed
// ---------------------------------------------------------------------------

test("fetching the report never writes or modifies attendance data", async () => {
  const before = await pool.query(
    `SELECT COUNT(*)::int AS count FROM attendance_records
     WHERE session_id = ANY($1::BIGINT[])`,
    [[sessionMain, sessionCoLec, sessionActive, sessionB, sessionClosed, sessionInactive]]
  );

  const token = await lecturer1Token();
  const res = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(res.status, 200);

  const after = await pool.query(
    `SELECT COUNT(*)::int AS count FROM attendance_records
     WHERE session_id = ANY($1::BIGINT[])`,
    [[sessionMain, sessionCoLec, sessionActive, sessionB, sessionClosed, sessionInactive]]
  );
  assert.equal(before.rows[0].count, after.rows[0].count, "report must be read-only");

  const absentRows = await pool.query(
    `SELECT COUNT(*)::int AS count FROM attendance_records WHERE status = 'ABSENT'`
  );
  assert.equal(absentRows.rows[0].count, 0, "ABSENT can never be stored");
});

// ---------------------------------------------------------------------------
// 20. Report generation is bounded (no N+1)
// ---------------------------------------------------------------------------

test("generating a session report uses a bounded number of queries regardless of enrollments", async () => {
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
    const result = await getLecturerSessionAttendanceReport(
      lecturer1UserId,
      sessionMain
    );
    assert.equal(result.ok, true);
    assert.equal(queryCount, 3, "profile + session context + students");
  } finally {
    pool.query = originalQuery;
  }
});

// ---------------------------------------------------------------------------
// 21. Repeated fetches are stable
// ---------------------------------------------------------------------------

test("repeated fetches return the same payload", async () => {
  const token = await lecturer1Token();
  const first = await get(sessionUrl(sessionMain), cookieHeader(token));
  const second = await get(sessionUrl(sessionMain), cookieHeader(token));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(await second.json(), firstBody, "responses must be stable");
});
