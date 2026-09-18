import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";

const TEST_PASSWORD = "shist-test-password";
const ADMIN_USERNAME = "shist_admin";

const STUDENT_A_MATRIC = "SHIST/STU/A";
const STUDENT_B_MATRIC = "SHIST/STU/B";
const INACTIVE_STUDENT_MATRIC = "SHIST/STU/INACTIVE";
const LECTURER_1_STAFF_ID = "SHIST/LEC/1";

const FACULTY_CODE = "SHIST-FAC";
const DEPT_CODE = "SHIST-DEP";
const ACADEMIC_SESSION_NAME = "SHIST-2026";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentAUserId = 0;
let studentBUserId = 0;
let inactiveStudentUserId = 0;
let lecturer1UserId = 0;
let lecturer2UserId = 0;
let lecturer3UserId = 0;
let lecturer4UserId = 0;
let lecturer5UserId = 0;

let studentAProfileId = 0;
let studentBProfileId = 0;
let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;
let lecturer3ProfileId = 0;
let lecturer4ProfileId = 0;
let lecturer5ProfileId = 0;

let department1Id = 0;
let level100Id = 0;
let academicSessionId = 0;
let firstSemesterId = 0;

let course1Id = 0;
let course2Id = 0;

let offering1Id = 0;
let offering2Id = 0;
let offeringClosedId = 0;
let offeringInactiveCourseId = 0;

let network1Id = 0;
let network2Id = 0;
let location1Id = 0;
let location2Id = 0;

let activeOffering1SessionId = 0;
let activeOffering2SessionId = 0;
let closedOfferingSessionId = 0;
let inactiveCourseSessionId = 0;
let endedSessionId = 0;
let expiredSessionId = 0;

const ALL_USER_IDS = () => [
  adminUserId,
  studentAUserId,
  studentBUserId,
  inactiveStudentUserId,
  lecturer1UserId,
  lecturer2UserId,
  lecturer3UserId,
  lecturer4UserId,
  lecturer5UserId,
];

function cookieFrom(res: globalThis.Response): string | null {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.cookieName}=`));
  if (!cookie) {
    return null;
  }
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

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

async function getHistory(token: string): Promise<{ data: { courses: any[] } }> {
  const res = await get("/api/student/attendance/history", cookieHeader(token));
  assert.equal(res.status, 200);
  return (await res.json()) as { data: { courses: any[] } };
}

async function loginStudent(matricNumber: string): Promise<string> {
  const res = await postJson("/api/auth/student/login", {
    matricNumber,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res);
  assert.ok(token);
  return token!;
}

async function loginLecturer(staffId: string): Promise<string> {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;
  assert.ok(token);
  return token!;
}

async function loginAdmin(): Promise<string> {
  const res = await postJson("/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;
  assert.ok(token);
  return token!;
}

function findCourse(courses: any[], offeringId: number): any {
  return courses.find((c: any) => c.courseOfferingId === offeringId);
}

function findSession(sessions: any[], sessionId: number): any {
  return sessions.find((s: any) => s.sessionId === sessionId);
}

function allSessions(courses: any[]): any[] {
  return courses.flatMap((c: any) => c.sessions);
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function insertUser(
  name: string,
  role: string,
  status: string,
  username: string | null
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, passwordHash, role, status, username]
  );
  return Number(res.rows[0].id);
}

async function insertStudent(
  userId: number,
  matric: string
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, matric, department1Id, level100Id]
  );
  return Number(res.rows[0].id);
}

async function insertLecturer(userId: number, staffId: string): Promise<number> {
  const res = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, staffId, department1Id]
  );
  return Number(res.rows[0].id);
}

async function insertCourse(
  courseCode: string,
  title: string,
  facultyId: number,
  levelId: number,
  status: string = "ACTIVE"
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [courseCode, title, facultyId, levelId, status]
  );
  return Number(res.rows[0].id);
}

async function insertCourseOffering(
  courseId: number,
  academicSessionId: number,
  semesterId: number,
  status: string = "OPEN"
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [courseId, academicSessionId, semesterId, status]
  );
  return Number(res.rows[0].id);
}

async function insertSession(
  offeringId: number,
  lecturerProfileId: number,
  startOffsetMinutes: number,
  endOffsetMinutes: number,
  status: "ACTIVE" | "ENDED",
  lateThresholdMinutes: number,
  networkId: number = network1Id,
  locationId: number = location1Id
): Promise<number> {
  const inserted = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute'),
             now() + ($6 * interval '1 minute'),
             ($7 * interval '1 minute'), $8,
             CASE WHEN $8 = 'ENDED' THEN now() + ($6 * interval '1 minute') END)
     RETURNING id`,
    [
      offeringId,
      lecturerProfileId,
      networkId,
      locationId,
      startOffsetMinutes,
      endOffsetMinutes,
      lateThresholdMinutes,
      status,
    ]
  );
  return Number(inserted.rows[0].id);
}

async function insertAttendanceRecord(
  sessionId: number,
  studentProfileId: number,
  status: "PRESENT" | "LATE"
): Promise<void> {
  await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
     VALUES ($1, $2, $3, now())`,
    [sessionId, studentProfileId, status]
  );
}

// ---------------------------------------------------------------------------
// State reset + cleanup
// ---------------------------------------------------------------------------

// Runs before every test so a previous test (even a failed one) can never leak
// sessions, registrations, or attendance records into the next scenario.
async function resetScopedData(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records WHERE session_id IN (
       SELECT id FROM attendance_sessions WHERE course_offering_id IN (
         SELECT id FROM course_offerings WHERE course_id IN (
           SELECT id FROM courses WHERE course_code LIKE 'SHIST%')))`
  );
  await pool.query(
    `DELETE FROM attendance_sessions WHERE course_offering_id IN (
       SELECT id FROM course_offerings WHERE course_id IN (
         SELECT id FROM courses WHERE course_code LIKE 'SHIST%'))`
  );
  await pool.query(
    `DELETE FROM course_registrations WHERE course_offering_id IN (
       SELECT id FROM course_offerings WHERE course_id IN (
         SELECT id FROM courses WHERE course_code LIKE 'SHIST%'))`
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers WHERE course_offering_id IN (
       SELECT id FROM course_offerings WHERE course_id IN (
         SELECT id FROM courses WHERE course_code LIKE 'SHIST%'))`
  );

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
    [
      offering1Id,
      lecturer2ProfileId,
      offering2Id,
      lecturer1ProfileId,
      offeringClosedId,
      lecturer3ProfileId,
      offeringInactiveCourseId,
      lecturer4ProfileId,
    ]
  );
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED'), ($3, $4, 'ENROLLED'), ($5, $4, 'ENROLLED')`,
    [studentAProfileId, offering1Id, studentAProfileId, offering2Id, studentBProfileId]
  );

  activeOffering1SessionId = await insertSession(offering1Id, lecturer2ProfileId, -15, 45, "ACTIVE", 5);
  activeOffering2SessionId = await insertSession(offering2Id, lecturer1ProfileId, -15, 45, "ACTIVE", 0);
  closedOfferingSessionId = await insertSession(offeringClosedId, lecturer3ProfileId, -15, 45, "ACTIVE", 5);
  inactiveCourseSessionId = await insertSession(offeringInactiveCourseId, lecturer4ProfileId, -15, 45, "ACTIVE", 5);
  endedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -60, -30, "ENDED", 5);
  expiredSessionId = await insertSession(offering2Id, lecturer5ProfileId, -60, -30, "ACTIVE", 5);
}

async function cleanupScopedData(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records WHERE session_id IN (
       SELECT id FROM attendance_sessions WHERE course_offering_id IN (
         SELECT id FROM course_offerings WHERE course_id IN (
           SELECT id FROM courses WHERE course_code LIKE 'SHIST%')))`
  );
  await pool.query(
    `DELETE FROM attendance_sessions WHERE course_offering_id IN (
       SELECT id FROM course_offerings WHERE course_id IN (
         SELECT id FROM courses WHERE course_code LIKE 'SHIST%'))`
  );
  await pool.query(
    `DELETE FROM course_registrations WHERE course_offering_id IN (
       SELECT id FROM course_offerings WHERE course_id IN (
         SELECT id FROM courses WHERE course_code LIKE 'SHIST%'))`
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers WHERE course_offering_id IN (
       SELECT id FROM course_offerings WHERE course_id IN (
         SELECT id FROM courses WHERE course_code LIKE 'SHIST%'))`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'SHIST%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'SHIST%'`);
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'SHIST/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'SHIST/LEC/%'`);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    ALL_USER_IDS(),
  ]);
  await pool.query(`DELETE FROM users WHERE username = $1`, [ADMIN_USERNAME]);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'Shist %' OR name LIKE 'SHIST %'`
  );
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'SHIST%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'SHIST%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'SHIST%'`);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'SHIST%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'SHIST-LOC%'`);
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ($1, $2, 'ADMIN', 'ACTIVE', $3) RETURNING id`,
    ["Shist Admin", passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Shist Faculty', $1) RETURNING id`,
    [FACULTY_CODE]
  );
  const facultyId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Shist Department', $1, $2) RETURNING id`,
    [DEPT_CODE, facultyId]
  );
  department1Id = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ($1, true) RETURNING id`,
    [ACADEMIC_SESSION_NAME]
  );
  academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  firstSemesterId = Number(sem.rows[0].id);

  const sem2 = await pool.query(
    `SELECT id FROM semesters WHERE name = 'Second Semester'`
  );
  const secondSemesterId = Number(sem2.rows[0].id);

  course1Id = await insertCourse("SHIST-101", "Shist Course One", facultyId, level100Id);
  course2Id = await insertCourse("SHIST-102", "Shist Course Two", facultyId, level100Id);
  const courseInactiveId = await insertCourse(
    "SHIST-103",
    "Shist Course Inactive",
    facultyId,
    level100Id,
    "INACTIVE"
  );

  offering1Id = await insertCourseOffering(course1Id, academicSessionId, firstSemesterId);
  offering2Id = await insertCourseOffering(course2Id, academicSessionId, firstSemesterId);
  offeringClosedId = await insertCourseOffering(
    course1Id,
    academicSessionId,
    secondSemesterId,
    "CLOSED"
  );
  offeringInactiveCourseId = await insertCourseOffering(
    courseInactiveId,
    academicSessionId,
    firstSemesterId
  );

  const net1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('SHIST-NET1', 'Shist Network One') RETURNING id`
  );
  network1Id = Number(net1.rows[0].id);

  const net2 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('SHIST-NET2', 'Shist Network Two') RETURNING id`
  );
  network2Id = Number(net2.rows[0].id);

  const loc1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('SHIST-LOC1') RETURNING id`
  );
  location1Id = Number(loc1.rows[0].id);

  const loc2 = await pool.query(
    `INSERT INTO locations (name) VALUES ('SHIST-LOC2') RETURNING id`
  );
  location2Id = Number(loc2.rows[0].id);

  studentAUserId = await insertUser("Shist Student A", "STUDENT", "ACTIVE", null);
  studentBUserId = await insertUser("Shist Student B", "STUDENT", "ACTIVE", null);
  inactiveStudentUserId = await insertUser("Shist Student Inactive", "STUDENT", "INACTIVE", null);
  lecturer1UserId = await insertUser("Shist Lecturer One", "LECTURER", "ACTIVE", null);
  lecturer2UserId = await insertUser("Shist Lecturer Two", "LECTURER", "ACTIVE", null);
  lecturer3UserId = await insertUser("Shist Lecturer Three", "LECTURER", "ACTIVE", null);
  lecturer4UserId = await insertUser("Shist Lecturer Four", "LECTURER", "ACTIVE", null);
  lecturer5UserId = await insertUser("Shist Lecturer Five", "LECTURER", "ACTIVE", null);

  studentAProfileId = await insertStudent(studentAUserId, STUDENT_A_MATRIC);
  studentBProfileId = await insertStudent(studentBUserId, STUDENT_B_MATRIC);
  await insertStudent(inactiveStudentUserId, INACTIVE_STUDENT_MATRIC);

  lecturer1ProfileId = await insertLecturer(lecturer1UserId, "SHIST/LEC/1");
  lecturer2ProfileId = await insertLecturer(lecturer2UserId, "SHIST/LEC/2");
  lecturer3ProfileId = await insertLecturer(lecturer3UserId, "SHIST/LEC/3");
  lecturer4ProfileId = await insertLecturer(lecturer4UserId, "SHIST/LEC/4");
  lecturer5ProfileId = await insertLecturer(lecturer5UserId, "SHIST/LEC/5");

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(resetScopedData);

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

// ---------------------------------------------------------------------------
// Focused scenarios
// ---------------------------------------------------------------------------

test("Student Attendance History: unauthenticated request returns 401", async () => {
  const res = await get("/api/student/attendance/history");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "UNAUTHENTICATED");
});

test("Student Attendance History: authenticated student gets 200 with the expected shape", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const { data } = await getHistory(token);

  assert.ok(data && typeof data === "object");
  assert.deepEqual(Object.keys(data).sort(), ["courses"]);
  assert.equal(data.courses.length, 1);

  const course = findCourse(data.courses, offering2Id);
  assert.ok(course, "student A has completed sessions only in offering2");

  assert.equal(course.courseOfferingId, offering2Id);
  assert.equal(course.courseCode, "SHIST-102");
  assert.equal(course.courseTitle, "Shist Course Two");
  assert.equal(course.academicSession, ACADEMIC_SESSION_NAME);
  assert.equal(course.semester, "First Semester");
  assert.equal(course.level, 100);

  assert.deepEqual(
    Object.keys(course).sort(),
    [
      "courseOfferingId",
      "courseCode",
      "courseTitle",
      "academicSession",
      "semester",
      "level",
      "summary",
      "sessions",
    ].sort()
  );

  assert.equal(course.summary.completedSessions, 1);
  assert.equal(course.summary.presentCount, 0);
  assert.equal(course.summary.lateCount, 0);
  assert.equal(course.summary.absentCount, 1);
  assert.equal(course.summary.attendancePercentage, 0);

  assert.equal(course.sessions.length, 1);
  const session = course.sessions[0];
  assert.equal(session.sessionId, endedSessionId);
  assert.equal(typeof session.startTime, "string");
  assert.equal(typeof session.endTime, "string");
  assert.ok(
    new Date(session.endTime).getTime() > new Date(session.startTime).getTime()
  );
  assert.equal(session.lecturerName, "Shist Lecturer One");
  assert.equal(session.locationName, "SHIST-LOC1");
  assert.equal(session.attendanceNetworkName, "Shist Network One");
  assert.equal(session.status, "ABSENT");
  assert.equal(session.markedAt, null);
});

test("Student Attendance History: lecturer is forbidden with 403", async () => {
  const token = await loginLecturer(LECTURER_1_STAFF_ID);
  const res = await get("/api/student/attendance/history", cookieHeader(token));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "FORBIDDEN");
});

test("Student Attendance History: admin is forbidden with 403", async () => {
  const token = await loginAdmin();
  const res = await get("/api/student/attendance/history", cookieHeader(token));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "FORBIDDEN");
});

test("Student Attendance History: inactive student is rejected with 401", async () => {
  const token = generateSessionToken();
  await createSession(
    inactiveStudentUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60 * 60 * 1000)
  );
  const res = await get("/api/student/attendance/history", cookieHeader(token));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "UNAUTHENTICATED");
});

test("Student Attendance History: only ENROLLED registrations are included", async () => {
  const offering1EndedSessionId = await insertSession(
    offering1Id,
    lecturer2ProfileId,
    -90,
    -60,
    "ENDED",
    5
  );
  await insertAttendanceRecord(offering1EndedSessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const enrolled = (await getHistory(token)).data.courses;
  const enrolledIds = enrolled.map((c) => c.courseOfferingId).sort((a: number, b: number) => a - b);
  assert.deepEqual(enrolledIds, [offering1Id, offering2Id].sort((a: number, b: number) => a - b));
  assert.ok(
    findCourse(enrolled, offering1Id).sessions.some(
      (s: any) => s.sessionId === offering1EndedSessionId
    ),
    "the ended offering1 session is visible while enrolled"
  );

  await pool.query(
    `UPDATE course_registrations SET status = 'DROPPED'
     WHERE student_id = $1 AND course_offering_id = $2`,
    [studentAProfileId, offering1Id]
  );
  try {
    const dropped = (await getHistory(token)).data.courses;
    const droppedIds = dropped.map((c) => c.courseOfferingId);
    assert.ok(
      !droppedIds.includes(offering1Id),
      "a DROPPED registration must not be included"
    );
    assert.ok(droppedIds.includes(offering2Id), "the still-ENROLLED registration stays");
  } finally {
    await pool.query(
      `UPDATE course_registrations SET status = 'ENROLLED'
       WHERE student_id = $1 AND course_offering_id = $2`,
      [studentAProfileId, offering1Id]
    );
  }

  const remaining = await pool.query(
    `SELECT id FROM attendance_sessions WHERE id = $1`,
    [offering1EndedSessionId]
  );
  assert.equal(
    remaining.rowCount,
    1,
    "the session still exists; only the registration status changed"
  );
});

test("Student Attendance History: only ENDED sessions are included", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const courses = (await getHistory(token)).data.courses;

  const sessionIds = allSessions(courses).map((s) => s.sessionId);
  assert.deepEqual(
    sessionIds,
    [endedSessionId],
    "the only included session is the ENDED one"
  );

  for (const course of courses) {
    for (const session of course.sessions) {
      assert.ok(
        ["PRESENT", "LATE", "ABSENT"].includes(session.status),
        "included sessions always carry a derived completed status"
      );
    }
  }
});

test("Student Attendance History: ACTIVE sessions are excluded", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const courses = (await getHistory(token)).data.courses;
  const sessionIds = allSessions(courses).map((s) => s.sessionId);

  assert.ok(
    !sessionIds.includes(activeOffering2SessionId),
    "the ongoing ACTIVE session of offering2 must not appear"
  );
  assert.ok(
    !sessionIds.includes(activeOffering1SessionId),
    "the ongoing ACTIVE session of offering1 must not appear"
  );
});

test("Student Attendance History: EXPIRED-but-not-ended sessions are excluded", async () => {
  const expired = await pool.query(
    `SELECT status, end_time < now() AS past, ended_at IS NULL AS no_ended_at
     FROM attendance_sessions WHERE id = $1`,
    [expiredSessionId]
  );
  assert.equal(expired.rows[0].status, "ACTIVE");
  assert.equal(expired.rows[0].past, true);
  assert.equal(expired.rows[0].no_ended_at, true);

  const token = await loginStudent(STUDENT_A_MATRIC);
  const courses = (await getHistory(token)).data.courses;
  const sessionIds = allSessions(courses).map((s) => s.sessionId);
  assert.ok(
    !sessionIds.includes(expiredSessionId),
    "an EXPIRED-but-not-ended session must not be in history"
  );
});

test("Student Attendance History: PRESENT record maps to PRESENT status", async () => {
  await insertAttendanceRecord(endedSessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const course = findCourse((await getHistory(token)).data.courses, offering2Id);
  assert.ok(course);

  const session = findSession(course.sessions, endedSessionId);
  assert.ok(session);
  assert.equal(session.status, "PRESENT");
  assert.ok(
    typeof session.markedAt === "string" && !Number.isNaN(Date.parse(session.markedAt))
  );

  assert.equal(course.summary.presentCount, 1);
  assert.equal(course.summary.lateCount, 0);
  assert.equal(course.summary.absentCount, 0);
});

test("Student Attendance History: LATE record maps to LATE status", async () => {
  await insertAttendanceRecord(endedSessionId, studentAProfileId, "LATE");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const course = findCourse((await getHistory(token)).data.courses, offering2Id);
  assert.ok(course);

  const session = findSession(course.sessions, endedSessionId);
  assert.ok(session);
  assert.equal(session.status, "LATE");
  assert.ok(
    typeof session.markedAt === "string" && !Number.isNaN(Date.parse(session.markedAt))
  );

  assert.equal(course.summary.presentCount, 0);
  assert.equal(course.summary.lateCount, 1);
  assert.equal(course.summary.absentCount, 0);
});

test("Student Attendance History: missing record maps to ABSENT", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const course = findCourse((await getHistory(token)).data.courses, offering2Id);
  assert.ok(course);

  const session = findSession(course.sessions, endedSessionId);
  assert.ok(session);
  assert.equal(session.status, "ABSENT");
  assert.equal(session.markedAt, null);

  assert.equal(course.summary.presentCount, 0);
  assert.equal(course.summary.lateCount, 0);
  assert.equal(course.summary.absentCount, 1);
});

test("Student Attendance History: absent count is calculated correctly", async () => {
  const secondEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -120, -90, "ENDED", 5);
  const thirdEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -180, -150, "ENDED", 5);

  await insertAttendanceRecord(endedSessionId, studentAProfileId, "PRESENT");
  await insertAttendanceRecord(secondEndedSessionId, studentAProfileId, "LATE");
  // thirdEndedSessionId intentionally has no record -> ABSENT.

  const token = await loginStudent(STUDENT_A_MATRIC);
  const course = findCourse((await getHistory(token)).data.courses, offering2Id);
  assert.ok(course);

  assert.equal(course.summary.completedSessions, 3);
  assert.equal(course.summary.presentCount, 1);
  assert.equal(course.summary.lateCount, 1);
  assert.equal(course.summary.absentCount, 1);
  assert.equal(course.summary.attendancePercentage, 66.67);
});

test("Student Attendance History: attendance percentage is rounded to 2 decimal places", async () => {
  const secondEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -120, -90, "ENDED", 5);
  await insertAttendanceRecord(endedSessionId, studentAProfileId, "PRESENT");
  await insertAttendanceRecord(secondEndedSessionId, studentAProfileId, "LATE");

  const token = await loginStudent(STUDENT_A_MATRIC);
  let course = findCourse((await getHistory(token)).data.courses, offering2Id);
  assert.ok(course);
  assert.equal(course.summary.attendancePercentage, 100);
  assert.equal(typeof course.summary.attendancePercentage, "number");

  const thirdEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -180, -150, "ENDED", 5);
  course = findCourse((await getHistory(token)).data.courses, offering2Id);
  // 2 attended of 3 -> 66.666... which must round to 66.67.
  assert.equal(course.summary.attendancePercentage, 66.67);

  const fourthEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -240, -210, "ENDED", 5);
  await insertAttendanceRecord(fourthEndedSessionId, studentAProfileId, "PRESENT");
  course = findCourse((await getHistory(token)).data.courses, offering2Id);
  // 3 attended of 4 -> 75 exactly.
  assert.equal(course.summary.attendancePercentage, 75);
});

test("Student Attendance History: multiple completed sessions aggregate correctly", async () => {
  const secondEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -120, -90, "ENDED", 5);
  const thirdEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -180, -150, "ENDED", 5);

  await insertAttendanceRecord(endedSessionId, studentAProfileId, "PRESENT");
  await insertAttendanceRecord(secondEndedSessionId, studentAProfileId, "LATE");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const course = findCourse((await getHistory(token)).data.courses, offering2Id);
  assert.ok(course);

  assert.equal(course.summary.completedSessions, 3);
  assert.equal(course.summary.presentCount, 1);
  assert.equal(course.summary.lateCount, 1);
  assert.equal(course.summary.absentCount, 1);
  assert.equal(course.summary.attendancePercentage, 66.67);

  assert.deepEqual(
    course.sessions.map((s: any) => s.sessionId).sort((a: number, b: number) => a - b),
    [endedSessionId, secondEndedSessionId, thirdEndedSessionId].sort((a: number, b: number) => a - b)
  );
  assert.deepEqual(
    course.sessions.map((s: any) => s.status).sort(),
    ["ABSENT", "LATE", "PRESENT"]
  );
});

test("Student Attendance History: multiple course offerings are isolated from each other", async () => {
  const offering1EndedSessionId = await insertSession(offering1Id, lecturer2ProfileId, -90, -60, "ENDED", 5);
  await insertAttendanceRecord(offering1EndedSessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const courses = (await getHistory(token)).data.courses;

  const offeringIds = courses.map((c) => c.courseOfferingId).sort((a: number, b: number) => a - b);
  assert.deepEqual(offeringIds, [offering1Id, offering2Id].sort((a: number, b: number) => a - b));

  const course1 = findCourse(courses, offering1Id);
  const course2 = findCourse(courses, offering2Id);
  assert.ok(course1 && course2);

  const course1SessionIds = course1.sessions.map((s: any) => s.sessionId);
  const course2SessionIds = course2.sessions.map((s: any) => s.sessionId);
  assert.deepEqual(course1SessionIds, [offering1EndedSessionId]);
  assert.deepEqual(course2SessionIds, [endedSessionId]);
  assert.ok(
    course1SessionIds.every((id: number) => !course2SessionIds.includes(id)),
    "sessions must never be shared across offerings"
  );

  assert.equal(course1.summary.presentCount, 1);
  assert.equal(course2.summary.presentCount, 0);
});

test("Student Attendance History: another student's attendance records cannot leak", async () => {
  const offering1EndedSessionId = await insertSession(offering1Id, lecturer2ProfileId, -90, -60, "ENDED", 5);
  await insertAttendanceRecord(endedSessionId, studentAProfileId, "PRESENT");
  await insertAttendanceRecord(offering1EndedSessionId, studentAProfileId, "LATE");

  const tokenB = await loginStudent(STUDENT_B_MATRIC);
  const courses = (await getHistory(tokenB)).data.courses;

  const offeringIds = courses.map((c) => c.courseOfferingId);
  assert.deepEqual(
    offeringIds,
    [offering2Id],
    "student B is only enrolled in offering2; nothing else may leak"
  );

  const courseB = findCourse(courses, offering2Id);
  assert.ok(courseB);
  const sessionB = findSession(courseB.sessions, endedSessionId);
  assert.ok(sessionB);
  assert.equal(
    sessionB.status,
    "ABSENT",
    "student B must not inherit student A's PRESENT record"
  );
  assert.equal(sessionB.markedAt, null);
  assert.equal(courseB.summary.presentCount, 0);
  assert.equal(courseB.summary.lateCount, 0);
  assert.equal(courseB.summary.absentCount, 1);
});

test("Student Attendance History: records of another offering cannot affect this offering", async () => {
  const offering1EndedSessionId = await insertSession(offering1Id, lecturer2ProfileId, -90, -60, "ENDED", 5);
  await insertAttendanceRecord(offering1EndedSessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const courses = (await getHistory(token)).data.courses;

  const course1 = findCourse(courses, offering1Id);
  const course2 = findCourse(courses, offering2Id);
  assert.ok(course1 && course2);

  const session1 = findSession(course1.sessions, offering1EndedSessionId);
  const session2 = findSession(course2.sessions, endedSessionId);
  assert.ok(session1 && session2);
  assert.equal(session1.status, "PRESENT");

  assert.equal(session2.status, "ABSENT");
  assert.equal(course2.summary.completedSessions, 1);
  assert.equal(course2.summary.presentCount, 0);
  assert.equal(course2.summary.lateCount, 0);
  assert.equal(course2.summary.absentCount, 1);
  assert.equal(course2.summary.attendancePercentage, 0);

  assert.equal(course1.summary.completedSessions, 1);
  assert.equal(course1.summary.presentCount, 1);
});

test("Student Attendance History: completed sessions without records are all ABSENT", async () => {
  const secondEndedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -120, -90, "ENDED", 5);

  const token = await loginStudent(STUDENT_A_MATRIC);
  const course = findCourse((await getHistory(token)).data.courses, offering2Id);
  assert.ok(course);

  assert.equal(course.summary.completedSessions, 2);
  assert.equal(course.summary.presentCount, 0);
  assert.equal(course.summary.lateCount, 0);
  assert.equal(course.summary.absentCount, 2);
  assert.equal(course.summary.attendancePercentage, 0);

  const ids = course.sessions.map((s: any) => s.sessionId).sort((a: number, b: number) => a - b);
  assert.deepEqual(ids, [endedSessionId, secondEndedSessionId].sort((a: number, b: number) => a - b));

  for (const session of course.sessions) {
    assert.equal(session.status, "ABSENT");
    assert.equal(session.markedAt, null);
  }
});

test("Student Attendance History: lecturer, location, and network belong to the correct session", async () => {
  const offering1EndedSessionId = await insertSession(
    offering1Id,
    lecturer2ProfileId,
    -90,
    -60,
    "ENDED",
    5,
    network2Id,
    location2Id
  );
  await insertAttendanceRecord(endedSessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const courses = (await getHistory(token)).data.courses;

  const session2 = findSession(findCourse(courses, offering2Id).sessions, endedSessionId);
  assert.ok(session2);
  assert.equal(session2.lecturerName, "Shist Lecturer One");
  assert.equal(session2.locationName, "SHIST-LOC1");
  assert.equal(session2.attendanceNetworkName, "Shist Network One");

  const session1 = findSession(findCourse(courses, offering1Id).sessions, offering1EndedSessionId);
  assert.ok(session1);
  assert.equal(session1.lecturerName, "Shist Lecturer Two");
  assert.equal(session1.locationName, "SHIST-LOC2");
  assert.equal(session1.attendanceNetworkName, "Shist Network Two");

  assert.ok(
    !Number.isNaN(Date.parse(session1.startTime)) &&
      !Number.isNaN(Date.parse(session1.endTime))
  );
  assert.ok(
    !Number.isNaN(Date.parse(session2.startTime)) &&
      !Number.isNaN(Date.parse(session2.endTime))
  );
});

test("Student Attendance History: response exposes no unintended or sensitive fields", async () => {
  await insertAttendanceRecord(endedSessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await get("/api/student/attendance/history", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(Object.keys(body).sort(), ["data"]);
  assert.deepEqual(Object.keys(body.data).sort(), ["courses"]);
  assert.equal(body.data.courses.length, 1);

  const course = body.data.courses[0];
  assert.deepEqual(
    Object.keys(course).sort(),
    [
      "courseOfferingId",
      "courseCode",
      "courseTitle",
      "academicSession",
      "semester",
      "level",
      "summary",
      "sessions",
    ].sort()
  );
  assert.deepEqual(
    Object.keys(course.summary).sort(),
    ["completedSessions", "presentCount", "lateCount", "absentCount", "attendancePercentage"].sort()
  );

  const session = course.sessions[0];
  assert.deepEqual(
    Object.keys(session).sort(),
    [
      "sessionId",
      "startTime",
      "endTime",
      "lecturerName",
      "locationName",
      "attendanceNetworkName",
      "status",
      "markedAt",
    ].sort()
  );
  assert.equal(typeof session.sessionId, "number");
  assert.equal(session.sessionId, endedSessionId);

  const serialized = JSON.stringify(body);
  for (const forbidden of [
    "userId",
    "studentId",
    "password",
    "passwordHash",
    "course_offering_id",
    "session_id",
    "record_status",
    "marked_at",
    "started_by_lecturer_id",
    "ended_at",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `response must not contain the internal field '${forbidden}'`
    );
  }
});

test("Student Attendance History: courses with zero completed sessions are omitted", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const courses = (await getHistory(token)).data.courses;

  const offeringIds = courses.map((c) => c.courseOfferingId);
  assert.deepEqual(
    offeringIds,
    [offering2Id],
    "only offering2 has completed sessions and is therefore returned"
  );
  assert.ok(
    !offeringIds.includes(offering1Id),
    "offering1 has zero completed sessions and must be omitted"
  );

  const reg = await pool.query(
    `SELECT status FROM course_registrations
     WHERE student_id = $1 AND course_offering_id = $2`,
    [studentAProfileId, offering1Id]
  );
  assert.equal(
    reg.rows[0].status,
    "ENROLLED",
    "the enrollment exists; the omission is driven by zero completed sessions"
  );
});