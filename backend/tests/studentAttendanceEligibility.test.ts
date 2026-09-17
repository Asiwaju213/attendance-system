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

const TEST_PASSWORD = "satt-test-password";
const ADMIN_USERNAME = "satt_admin";

const STUDENT_A_MATRIC = "SATT/STU/A";
const STUDENT_B_MATRIC = "SATT/STU/B";
const INACTIVE_STUDENT_MATRIC = "SATT/STU/INACTIVE";
const LECTURER_1_STAFF_ID = "SATT/LEC/1";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentAUserId = 0;
let studentBUserId = 0;
let inactiveStudentUserId = 0;
let noProfileStudentUserId = 0;
let lecturer1UserId = 0;

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
let courseInactiveId = 0;

let offering1Id = 0;
let offering2Id = 0;
let offeringClosedId = 0;
let offeringInactiveCourseId = 0;

let network1Id = 0;
let location1Id = 0;

let activeOffering1SessionId = 0;
let activeOffering2SessionId = 0;
let closedOfferingSessionId = 0;
let inactiveCourseSessionId = 0;
let endedSessionId = 0;
let expiredSessionId = 0;

const SESSION_IDS = () => [
  activeOffering1SessionId,
  activeOffering2SessionId,
  closedOfferingSessionId,
  inactiveCourseSessionId,
  endedSessionId,
  expiredSessionId,
];

const ALL_USER_IDS = () => [
  adminUserId,
  studentAUserId,
  studentBUserId,
  inactiveStudentUserId,
  noProfileStudentUserId,
  lecturer1UserId,
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

async function getEligible(token: string): Promise<Array<Record<string, unknown>>> {
  const res = await get("/api/student/attendance/eligible", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
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

async function markAttendance(
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

async function insertSession(
  offeringId: number,
  lecturerProfileId: number,
  startOffsetMinutes: number,
  endOffsetMinutes: number,
  status: "ACTIVE" | "ENDED",
  lateThresholdMinutes: number
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
      network1Id,
      location1Id,
      startOffsetMinutes,
      endOffsetMinutes,
      lateThresholdMinutes,
      status,
    ]
  );
  return Number(inserted.rows[0].id);
}

async function cleanupScopedData(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records WHERE session_id = ANY($1::BIGINT[])`,
    [SESSION_IDS()]
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE staff_id LIKE 'SATT/LEC/%'
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'SATT%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'SATT%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'SATT%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'SATT%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'SATT%'`);
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'SATT/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'SATT/LEC/%'`);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    ALL_USER_IDS(),
  ]);
  await pool.query(`DELETE FROM users WHERE username = $1`, [ADMIN_USERNAME]);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'Satt %' OR name LIKE 'SATT %'`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'SATT%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'SATT%'`);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'SATT%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'SATT-LOC%'`);
}

async function resetAttendanceRecords(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records WHERE session_id = ANY($1::BIGINT[])`,
    [SESSION_IDS()]
  );
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Satt Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Satt Faculty', 'SATT-FAC') RETURNING id`
  );
  const facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Satt Department', 'SATT-DEP', $1) RETURNING id`,
    [facId]
  );
  department1Id = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ('SATT-2026', true) RETURNING id`
  );
  academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  firstSemesterId = Number(sem.rows[0].id);

  const course1 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('SATT-101', 'SATT Course One', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course1Id = Number(course1.rows[0].id);

  const course2 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('SATT-102', 'SATT Course Two', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course2Id = Number(course2.rows[0].id);

  const courseInactive = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
     VALUES ('SATT-103', 'SATT Course Inactive', $1, $2, 'INACTIVE') RETURNING id`,
    [facId, level100Id]
  );
  courseInactiveId = Number(courseInactive.rows[0].id);

  const offering1 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course1Id, academicSessionId, firstSemesterId]
  );
  offering1Id = Number(offering1.rows[0].id);

  const offering2 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course2Id, academicSessionId, firstSemesterId]
  );
  offering2Id = Number(offering2.rows[0].id);

  const sem2 = await pool.query(
    `SELECT id FROM semesters WHERE name = 'Second Semester'`
  );
  const secondSemesterId = Number(sem2.rows[0].id);

  const offeringClosed = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'CLOSED') RETURNING id`,
    [course1Id, academicSessionId, secondSemesterId]
  );
  offeringClosedId = Number(offeringClosed.rows[0].id);

  const offeringInactive = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [courseInactiveId, academicSessionId, firstSemesterId]
  );
  offeringInactiveCourseId = Number(offeringInactive.rows[0].id);

  const network1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('SATT-NET1', 'SATT Network One') RETURNING id`
  );
  network1Id = Number(network1.rows[0].id);

  const location1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('SATT-LOC1') RETURNING id`
  );
  location1Id = Number(location1.rows[0].id);

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

  studentAUserId = await insertUser("Satt Student A", "STUDENT", "ACTIVE", null);
  studentBUserId = await insertUser("Satt Student B", "STUDENT", "ACTIVE", null);
  inactiveStudentUserId = await insertUser("Satt Student Inactive", "STUDENT", "INACTIVE", null);
  noProfileStudentUserId = await insertUser("Satt Student No Profile", "STUDENT", "ACTIVE", null);
  const lecturer1UserIdRes = await insertUser("Satt Lecturer One", "LECTURER", "ACTIVE", null);
  lecturer1UserId = lecturer1UserIdRes;

  studentAProfileId = await insertStudent(studentAUserId, STUDENT_A_MATRIC);
  studentBProfileId = await insertStudent(studentBUserId, STUDENT_B_MATRIC);
  await insertStudent(inactiveStudentUserId, INACTIVE_STUDENT_MATRIC);

  lecturer1ProfileId = await insertLecturer(lecturer1UserId, "SATT/LEC/1");
  const lecturer2UserIdRes = await insertUser("Satt Lecturer Two", "LECTURER", "ACTIVE", null);
  const lecturer3UserIdRes = await insertUser("Satt Lecturer Three", "LECTURER", "ACTIVE", null);
  const lecturer4UserIdRes = await insertUser("Satt Lecturer Four", "LECTURER", "ACTIVE", null);
  const lecturer5UserIdRes = await insertUser("Satt Lecturer Five", "LECTURER", "ACTIVE", null);
  lecturer2ProfileId = await insertLecturer(lecturer2UserIdRes, "SATT/LEC/2");
  lecturer3ProfileId = await insertLecturer(lecturer3UserIdRes, "SATT/LEC/3");
  lecturer4ProfileId = await insertLecturer(lecturer4UserIdRes, "SATT/LEC/4");
  lecturer5ProfileId = await insertLecturer(lecturer5UserIdRes, "SATT/LEC/5");

  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED'), ($3, $4, 'ENROLLED'), ($5, $4, 'ENROLLED')`,
    [studentAProfileId, offering1Id, studentAProfileId, offering2Id, studentBProfileId]
  );

  // Active sessions: both start and end in the near future relative to now.
  activeOffering1SessionId = await insertSession(offering1Id, lecturer1ProfileId, -15, 45, "ACTIVE", 5);
  activeOffering2SessionId = await insertSession(offering2Id, lecturer2ProfileId, -15, 45, "ACTIVE", 0);

  // Excluded by offering being CLOSED / course being INACTIVE.
  closedOfferingSessionId = await insertSession(offeringClosedId, lecturer3ProfileId, -15, 45, "ACTIVE", 5);
  inactiveCourseSessionId = await insertSession(offeringInactiveCourseId, lecturer4ProfileId, -15, 45, "ACTIVE", 5);

  // Excluded by status ENDED / end_time already passed (only reason: not currently active).
  endedSessionId = await insertSession(offering2Id, lecturer1ProfileId, -60, -30, "ENDED", 5);
  expiredSessionId = await insertSession(offering2Id, lecturer5ProfileId, -60, -30, "ACTIVE", 5);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(resetAttendanceRecords);

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

async function findSession(
  sessions: Array<Record<string, unknown>>,
  id: number
): Promise<Record<string, unknown> | undefined> {
  return sessions.find((s) => Number(s.id) === id);
}

// ---------------------------------------------------------------------------
// Authentication / authorization
// ---------------------------------------------------------------------------

test("SATT auth: an unauthenticated request is rejected", async () => {
  const res = await get("/api/student/attendance/eligible");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "UNAUTHENTICATED");
});

test("SATT auth: a lecturer cannot access the student endpoint", async () => {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_1_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;

  const eligible = await get("/api/student/attendance/eligible", cookieHeader(token));
  assert.equal(eligible.status, 403);
  assert.equal((await eligible.json()).error, "FORBIDDEN");
});

test("SATT auth: an admin cannot access the student endpoint as a student", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;

  const eligible = await get("/api/student/attendance/eligible", cookieHeader(token));
  assert.equal(eligible.status, 403);
  assert.equal((await eligible.json()).error, "FORBIDDEN");
});

test("SATT auth: an inactive student is rejected", async () => {
  const token = generateSessionToken();
  await createSession(
    inactiveStudentUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60 * 60 * 1000)
  );

  const res = await get("/api/student/attendance/eligible", cookieHeader(token));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "UNAUTHENTICATED");
});

test("SATT auth: a user with the student role but no student profile gets 404", async () => {
  const token = generateSessionToken();
  await createSession(
    noProfileStudentUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60 * 60 * 1000)
  );

  const res = await get("/api/student/attendance/eligible", cookieHeader(token));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "STUDENT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("SATT eligibility: a registered student sees the active sessions for their enrollments", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const sessions = await getEligible(token);

  const byId = new Map(sessions.map((s) => [Number(s.id), s]));
  const active1 = byId.get(activeOffering1SessionId);
  const active2 = byId.get(activeOffering2SessionId);

  assert.ok(active1, "student A should see the active offering1 session");
  assert.ok(active2, "student A should see the active offering2 session");
  assert.equal(sessions.length, 2);

  assert.equal(active1!.courseOfferingId, offering1Id);
  assert.equal(active1!.courseCode, "SATT-101");
  assert.equal(active1!.courseTitle, "SATT Course One");
  assert.equal(active1!.lateThresholdMinutes, 5);
  assert.equal(active1!.attendanceNetworkName, "SATT Network One");
  assert.equal(active1!.locationName, "SATT-LOC1");
  assert.equal(active1!.currentAttendanceState, "NOT_MARKED");
  assert.equal(typeof active1!.startTime, "string");
  assert.equal(typeof active1!.endTime, "string");
  assert.ok(new Date(active1!.endTime as string).getTime() > Date.now());

  assert.equal(active2!.courseOfferingId, offering2Id);
  assert.equal(active2!.courseCode, "SATT-102");
  assert.equal(active2!.lateThresholdMinutes, 0);
  assert.equal(active2!.currentAttendanceState, "NOT_MARKED");
});

test("SATT eligibility: an unregistered student does not see that session", async () => {
  const token = await loginStudent(STUDENT_B_MATRIC);
  const sessions = await getEligible(token);

  const ids = sessions.map((s) => Number(s.id));
  assert.ok(!ids.includes(activeOffering1SessionId), "student B is not enrolled in offering1");
  assert.ok(ids.includes(activeOffering2SessionId), "student B is enrolled in offering2");
  assert.equal(sessions.length, 1);
});

test("SATT eligibility: a closed offering never appears", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const sessions = await getEligible(token);
  const ids = sessions.map((s) => Number(s.id));
  assert.ok(!ids.includes(closedOfferingSessionId));
});

test("SATT eligibility: an inactive course never appears", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const sessions = await getEligible(token);
  const ids = sessions.map((s) => Number(s.id));
  assert.ok(!ids.includes(inactiveCourseSessionId));
});

test("SATT eligibility: ended and expired sessions never appear", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const sessions = await getEligible(token);
  const ids = sessions.map((s) => Number(s.id));
  assert.ok(!ids.includes(endedSessionId), "ended session must not appear");
  assert.ok(!ids.includes(expiredSessionId), "expired session must not appear");
});

test("SATT eligibility: a dropped registration is not an active enrollment", async () => {
  await pool.query(
    `UPDATE course_registrations SET status = 'DROPPED'
     WHERE student_id = $1 AND course_offering_id = $2`,
    [studentAProfileId, offering1Id]
  );
  try {
    const token = await loginStudent(STUDENT_A_MATRIC);
    const sessions = await getEligible(token);
    const ids = sessions.map((s) => Number(s.id));
    assert.ok(
      !ids.includes(activeOffering1SessionId),
      "dropped enrollment must not be treated as active"
    );
    assert.ok(ids.includes(activeOffering2SessionId));
  } finally {
    await pool.query(
      `UPDATE course_registrations SET status = 'ENROLLED'
       WHERE student_id = $1 AND course_offering_id = $2`,
      [studentAProfileId, offering1Id]
    );
  }
});

// ---------------------------------------------------------------------------
// Existing attendance state
// ---------------------------------------------------------------------------

test("SATT state: an already-marked session returns the existing attendance state", async () => {
  await markAttendance(activeOffering1SessionId, studentAProfileId, "LATE");
  await markAttendance(activeOffering2SessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_A_MATRIC);
  const sessions = await getEligible(token);

  const active1 = await findSession(sessions, activeOffering1SessionId);
  const active2 = await findSession(sessions, activeOffering2SessionId);
  assert.ok(active1 && active2);

  assert.equal(active1!.currentAttendanceState, "LATE");
  assert.equal(active2!.currentAttendanceState, "PRESENT");
});

test("SATT state: another student's registration and attendance are never exposed", async () => {
  await markAttendance(activeOffering2SessionId, studentAProfileId, "PRESENT");

  const token = await loginStudent(STUDENT_B_MATRIC);
  const sessions = await getEligible(token);
  const ids = sessions.map((s) => Number(s.id));

  assert.ok(
    !ids.includes(activeOffering1SessionId),
    "student B is not registered for offering1, so its session must not leak"
  );

  const active2 = await findSession(sessions, activeOffering2SessionId);
  assert.ok(active2);
  assert.equal(
    active2!.currentAttendanceState,
    "NOT_MARKED",
    "student A's PRESENT record must never be shown to student B"
  );
});