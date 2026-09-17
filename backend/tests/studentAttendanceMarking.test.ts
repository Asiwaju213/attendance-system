import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";
import {
  buildAuthenticationResponse,
  createTestAuthenticator,
  type TestAuthenticator,
} from "./webauthnTestHelpers";

const TEST_PASSWORD = "mark-test-password";
const ADMIN_USERNAME = "mark_admin";

const STUDENT_A_MATRIC = "MARK/STU/A";
const STUDENT_B_MATRIC = "MARK/STU/B";

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

let authenticatorA: TestAuthenticator;
let authenticatorB: TestAuthenticator;

let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;
let lecturer3ProfileId = 0;
let lecturer4ProfileId = 0;
let lecturer5ProfileId = 0;
let lecturer6ProfileId = 0;

let department1Id = 0;
let level100Id = 0;
let academicSessionId = 0;
let firstSemesterId = 0;

let course1Id = 0;
let course2Id = 0;
let course3Id = 0;
let courseInactiveId = 0;

let offering1Id = 0;
let offering2Id = 0;
let offering3Id = 0;
let offeringClosedId = 0;
let offeringInactiveCourseId = 0;

let network1Id = 0;
let location1Id = 0;

let presentSessionId = 0;
let lateSessionId = 0;
let expiredSessionId = 0;
let endedSessionId = 0;
let closedOfferingSessionId = 0;
let inactiveCourseSessionId = 0;
let unregisteredSessionId = 0;

const SESSION_IDS = () => [
  presentSessionId,
  lateSessionId,
  expiredSessionId,
  endedSessionId,
  closedOfferingSessionId,
  inactiveCourseSessionId,
  unregisteredSessionId,
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

async function mark(token: string, body: unknown): Promise<globalThis.Response> {
  return postJson("/api/student/attendance", body, cookieHeader(token));
}

async function deviceChallenge(token: string): Promise<string> {
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { challenge: string } };
  return body.data.challenge;
}

async function buildAssertion(
  authenticator: TestAuthenticator,
  challenge: string
) {
  return buildAuthenticationResponse({
    authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: nextSignCount(authenticator),
  });
}

const nextSignCounts = new WeakMap<TestAuthenticator, number>();

function nextSignCount(authenticator: TestAuthenticator): number {
  const stored = nextSignCounts.get(authenticator) ?? 2;
  nextSignCounts.set(authenticator, stored + 1);
  return stored;
}

async function markSession(
  token: string,
  attendanceSessionId: number,
  authenticator: TestAuthenticator,
  extras: Record<string, unknown> = {}
): Promise<globalThis.Response> {
  const challenge = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticator, challenge);
  return mark(token, { attendanceSessionId, assertion, ...extras });
}

async function seedDevice(
  studentProfileId: number,
  authenticator: TestAuthenticator
): Promise<void> {
  await pool.query(
    `INSERT INTO student_devices (student_id, credential_id, credential_public_key, counter, status)
     VALUES ($1, $2, $3, 1, 'ACTIVE')`,
    [
      studentProfileId,
      isoBase64URL.fromBuffer(authenticator.credentialId),
      Buffer.from(authenticator.credentialPublicKey),
    ]
  );
}

async function countRecords(
  sessionId: number,
  studentProfileId: number
): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_records
     WHERE session_id = $1 AND student_id = $2`,
    [sessionId, studentProfileId]
  );
  return result.rows[0].n;
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
       SELECT id FROM lecturers WHERE staff_id LIKE 'MARK/LEC/%'
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'MARK%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'MARK%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'MARK%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'MARK%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'MARK%'`);
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number IN ($1, $2)
     )`,
    [STUDENT_A_MATRIC, STUDENT_B_MATRIC]
  );
  await pool.query(
    `DELETE FROM student_devices
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number IN ($1, $2)
     )`,
    [STUDENT_A_MATRIC, STUDENT_B_MATRIC]
  );
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'MARK/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'MARK/LEC/%'`);
  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (
       SELECT id FROM users
       WHERE username = $1 OR name LIKE 'Mark %' OR name LIKE 'MARK %'
     )`,
    [ADMIN_USERNAME]
  );
  await pool.query(`DELETE FROM users WHERE username = $1`, [ADMIN_USERNAME]);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'Mark %' OR name LIKE 'MARK %'`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'MARK%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'MARK%'`);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'MARK%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'MARK-LOC%'`);
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
     VALUES ('Mark Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Mark Faculty', 'MARK-FAC') RETURNING id`
  );
  const facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Mark Department', 'MARK-DEP', $1) RETURNING id`,
    [facId]
  );
  department1Id = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ('MARK-2026', true) RETURNING id`
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

  async function insertCourse(
    code: string,
    title: string,
    status = "ACTIVE"
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [code, title, facId, level100Id, status]
    );
    return Number(res.rows[0].id);
  }

  course1Id = await insertCourse("MARK-101", "Mark Course One");
  course2Id = await insertCourse("MARK-102", "Mark Course Two");
  course3Id = await insertCourse("MARK-103", "Mark Course Three");
  courseInactiveId = await insertCourse("MARK-104", "Mark Course Inactive", "INACTIVE");

  async function insertOffering(
    courseId: number,
    semesterId: number,
    status = "OPEN"
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [courseId, academicSessionId, semesterId, status]
    );
    return Number(res.rows[0].id);
  }

  offering1Id = await insertOffering(course1Id, firstSemesterId);
  offering2Id = await insertOffering(course2Id, firstSemesterId);
  offering3Id = await insertOffering(course3Id, firstSemesterId);
  offeringClosedId = await insertOffering(course1Id, secondSemesterId, "CLOSED");
  offeringInactiveCourseId = await insertOffering(courseInactiveId, firstSemesterId);

  const network1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('MARK-NET1', 'Mark Network One') RETURNING id`
  );
  network1Id = Number(network1.rows[0].id);

  const location1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('MARK-LOC1') RETURNING id`
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

  async function insertStudent(userId: number, matric: string): Promise<number> {
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

  studentAUserId = await insertUser("Mark Student A", "STUDENT", "ACTIVE", null);
  studentBUserId = await insertUser("Mark Student B", "STUDENT", "ACTIVE", null);
  inactiveStudentUserId = await insertUser("Mark Student Inactive", "STUDENT", "INACTIVE", null);
  noProfileStudentUserId = await insertUser("Mark Student No Profile", "STUDENT", "ACTIVE", null);
  lecturer1UserId = await insertUser("Mark Lecturer One", "LECTURER", "ACTIVE", null);

  studentAProfileId = await insertStudent(studentAUserId, STUDENT_A_MATRIC);
  studentBProfileId = await insertStudent(studentBUserId, STUDENT_B_MATRIC);
  await insertStudent(inactiveStudentUserId, "MARK/STU/INACTIVE");

  authenticatorA = await createTestAuthenticator();
  authenticatorB = await createTestAuthenticator();
  await seedDevice(studentAProfileId, authenticatorA);
  await seedDevice(studentBProfileId, authenticatorB);

  lecturer1ProfileId = await insertLecturer(lecturer1UserId, "MARK/LEC/1");
  const lecturer2UserIdRes = await insertUser("Mark Lecturer Two", "LECTURER", "ACTIVE", null);
  const lecturer3UserIdRes = await insertUser("Mark Lecturer Three", "LECTURER", "ACTIVE", null);
  const lecturer4UserIdRes = await insertUser("Mark Lecturer Four", "LECTURER", "ACTIVE", null);
  const lecturer5UserIdRes = await insertUser("Mark Lecturer Five", "LECTURER", "ACTIVE", null);
  const lecturer6UserIdRes = await insertUser("Mark Lecturer Six", "LECTURER", "ACTIVE", null);
  lecturer2ProfileId = await insertLecturer(lecturer2UserIdRes, "MARK/LEC/2");
  lecturer3ProfileId = await insertLecturer(lecturer3UserIdRes, "MARK/LEC/3");
  lecturer4ProfileId = await insertLecturer(lecturer4UserIdRes, "MARK/LEC/4");
  lecturer5ProfileId = await insertLecturer(lecturer5UserIdRes, "MARK/LEC/5");
  lecturer6ProfileId = await insertLecturer(lecturer6UserIdRes, "MARK/LEC/6");

  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED'), ($1, $3, 'ENROLLED'),
            ($1, $4, 'ENROLLED'), ($5, $3, 'ENROLLED')`,
    [studentAProfileId, offering1Id, offering2Id, offeringClosedId, studentBProfileId]
  );

  // Within the late threshold (started ~1 minute ago, 10 minute threshold) -> PRESENT.
  presentSessionId = await insertSession(offering1Id, lecturer1ProfileId, -1, 60, "ACTIVE", 10);
  // Past the late threshold (started ~10 minutes ago, 5 minute threshold) -> LATE.
  lateSessionId = await insertSession(offering2Id, lecturer2ProfileId, -10, 60, "ACTIVE", 5);
  // End time already passed.
  expiredSessionId = await insertSession(offering2Id, lecturer3ProfileId, -30, -10, "ACTIVE", 5);
  // Marked ended.
  endedSessionId = await insertSession(offering1Id, lecturer1ProfileId, -30, -10, "ENDED", 5);
  // Offering closed.
  closedOfferingSessionId = await insertSession(offeringClosedId, lecturer4ProfileId, -1, 60, "ACTIVE", 5);
  // Course inactive.
  inactiveCourseSessionId = await insertSession(offeringInactiveCourseId, lecturer5ProfileId, -1, 60, "ACTIVE", 5);
  // Valid session on an offering student A is not registered for.
  unregisteredSessionId = await insertSession(offering3Id, lecturer6ProfileId, -1, 60, "ACTIVE", 5);

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

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

function assertInvalidRequest(body: unknown): void {
  assertErrorCode(body, "INVALID_REQUEST");
}

// ---------------------------------------------------------------------------
// Authentication / authorization
// ---------------------------------------------------------------------------

test("MARK auth: an unauthenticated request is rejected", async () => {
  const res = await postJson("/api/student/attendance", { attendanceSessionId: presentSessionId });
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("MARK auth: a lecturer cannot mark attendance", async () => {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId: "MARK/LEC/1",
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;

  const markRes = await mark(token, { attendanceSessionId: presentSessionId });
  assert.equal(markRes.status, 403);
  assertErrorCode(await markRes.json(), "FORBIDDEN");
});

test("MARK auth: an admin cannot mark attendance as a student", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;

  const markRes = await mark(token, { attendanceSessionId: presentSessionId });
  assert.equal(markRes.status, 403);
  assertErrorCode(await markRes.json(), "FORBIDDEN");
});

test("MARK auth: an inactive student is rejected", async () => {
  const token = generateSessionToken();
  await createSession(
    inactiveStudentUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60 * 60 * 1000)
  );

  const res = await mark(token, { attendanceSessionId: presentSessionId });
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("MARK auth: a user with the student role but no student profile gets 404", async () => {
  const token = generateSessionToken();
  await createSession(
    noProfileStudentUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60 * 60 * 1000)
  );

  const assertion = await buildAssertion(authenticatorA, randomBytes(32).toString("base64url"));
  const res = await mark(token, {
    attendanceSessionId: presentSessionId,
    assertion,
  });
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "STUDENT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test("MARK validation: invalid attendanceSessionId values are rejected with 400", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const invalidBodies = [
    {},
    { attendanceSessionId: null },
    { attendanceSessionId: 0 },
    { attendanceSessionId: -5 },
    { attendanceSessionId: 1.5 },
    { attendanceSessionId: "abc" },
    { attendanceSessionId: true },
    { attendanceSessionId: [1] },
  ];

  for (const body of invalidBodies) {
    const res = await mark(token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assertInvalidRequest(await res.json());
  }
});

// ---------------------------------------------------------------------------
// Authoritative checks
// ---------------------------------------------------------------------------

test("MARK checks: a missing session returns SESSION_NOT_FOUND", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, 999999, authenticatorA);
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

test("MARK checks: a session that has already ended is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, endedSessionId, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "SESSION_NOT_ACTIVE");
});

test("MARK checks: an expired session is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, expiredSessionId, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "SESSION_NOT_ACTIVE");
});

test("MARK checks: a closed offering is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, closedOfferingSessionId, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "OFFERING_NOT_OPEN");
});

test("MARK checks: an inactive course is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, inactiveCourseSessionId, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "COURSE_NOT_ACTIVE");
});

test("MARK checks: an unregistered student is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, unregisteredSessionId, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "STUDENT_NOT_REGISTERED");
});

// ---------------------------------------------------------------------------
// Successful marking
// ---------------------------------------------------------------------------

test("MARK success: attendance within the late threshold is PRESENT", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, presentSessionId, authenticatorA);

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "PRESENT");
  assert.equal(body.data.attendanceSessionId, presentSessionId);
  assert.equal(body.data.courseCode, "MARK-101");
  assert.equal(body.data.courseTitle, "Mark Course One");
  assert.equal(typeof body.data.id, "number");
  assert.equal(typeof body.data.markedAt, "string");
  assert.ok(Number.isNaN(Date.parse(body.data.markedAt)) === false);
  assert.equal(await countRecords(presentSessionId, studentAProfileId), 1);
});

test("MARK success: attendance after the late threshold is LATE", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, lateSessionId, authenticatorA);

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "LATE");
  assert.equal(body.data.attendanceSessionId, lateSessionId);
  assert.equal(body.data.courseCode, "MARK-102");
  assert.equal(body.data.courseTitle, "Mark Course Two");
  assert.equal(await countRecords(lateSessionId, studentAProfileId), 1);
});

test("MARK success: the stored record uses the derived status and server timestamp", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markSession(token, lateSessionId, authenticatorA);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };

  const after = Date.now();
  const row = await pool.query(
    `SELECT status, marked_at, session_id, student_id FROM attendance_records WHERE id = $1`,
    [body.data.id]
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].status, "LATE");
  assert.equal(Number(row.rows[0].session_id), lateSessionId);
  assert.equal(Number(row.rows[0].student_id), studentAProfileId);
  const markedAt = new Date(row.rows[0].marked_at).getTime();
  assert.ok(Math.abs(markedAt - after) < 60_000, "marked_at uses the server/database time");
  assert.ok(Math.abs(new Date(body.data.markedAt as string).getTime() - after) < 60_000);
});

test("MARK success: client-supplied identity, status, and timestamps are ignored", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const challenge = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticatorA, challenge);
  const res = await mark(token, {
    attendanceSessionId: lateSessionId,
    assertion,
    studentId: 999999,
    userId: 999999,
    courseOfferingId: 999999,
    status: "PRESENT",
    markedAt: "2020-01-01T00:00:00.000Z",
    lecturerId: 999999,
  });

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "LATE", "status must be derived server-side");
  assert.equal(body.data.studentId, studentAProfileId);
  assert.equal(body.data.attendanceSessionId, lateSessionId);
  assert.ok(new Date(body.data.markedAt as string).getTime() > Date.now() - 60_000);

  const row = await pool.query(
    `SELECT status, student_id FROM attendance_records WHERE session_id = $1`,
    [lateSessionId]
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].status, "LATE");
  assert.equal(Number(row.rows[0].student_id), studentAProfileId);
});

// ---------------------------------------------------------------------------
// Duplicates and concurrency
// ---------------------------------------------------------------------------

test("MARK duplicates: a second marking of the same session is 409", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const first = await markSession(token, presentSessionId, authenticatorA);
  assert.equal(first.status, 201);

  const second = await markSession(token, presentSessionId, authenticatorA);
  assert.equal(second.status, 409);
  assertErrorCode(await second.json(), "ALREADY_MARKED");
  assert.equal(await countRecords(presentSessionId, studentAProfileId), 1);
});

test("MARK concurrency: simultaneous attempts create exactly one record", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);

  const [res1, res2] = await Promise.all([
    markSession(token, presentSessionId, authenticatorA),
    markSession(token, presentSessionId, authenticatorA),
  ]);

  const statuses = [res1.status, res2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409], "one request wins, the other reports already marked");

  const conflict = res1.status === 409 ? res1 : res2;
  assertErrorCode(await conflict.json(), "ALREADY_MARKED");

  assert.equal(await countRecords(presentSessionId, studentAProfileId), 1);
});

// ---------------------------------------------------------------------------
// Isolation between students
// ---------------------------------------------------------------------------

test("MARK isolation: one student's attendance never affects or exposes another's", async () => {
  const tokenA = await loginStudent(STUDENT_A_MATRIC);
  const tokenB = await loginStudent(STUDENT_B_MATRIC);

  const aRes = await markSession(tokenA, lateSessionId, authenticatorA);
  assert.equal(aRes.status, 201);
  const aBody = (await aRes.json()) as { data: Record<string, unknown> };

  const bRes = await markSession(tokenB, lateSessionId, authenticatorB);
  assert.equal(bRes.status, 201);
  const bBody = (await bRes.json()) as { data: Record<string, unknown> };

  assert.equal(bBody.data.status, "LATE");
  assert.notEqual(
    Number(bBody.data.id),
    Number(aBody.data.id),
    "each student gets their own record"
  );
  assert.equal(
    Number(bBody.data.studentId),
    studentBProfileId,
    "the record belongs to student B, not student A"
  );
  assert.equal(await countRecords(lateSessionId, studentAProfileId), 1);
  assert.equal(await countRecords(lateSessionId, studentBProfileId), 1);

  const rows = await pool.query(
    `SELECT student_id, status FROM attendance_records WHERE session_id = $1`,
    [lateSessionId]
  );
  assert.equal(rows.rows.length, 2);
  const studentIds = rows.rows.map((r) => Number(r.student_id)).sort((a, b) => a - b);
  assert.deepEqual(studentIds, [studentAProfileId, studentBProfileId].sort((a, b) => a - b));

  const bOnA = await markSession(tokenB, presentSessionId, authenticatorB);
  assert.equal(bOnA.status, 409);
  assertErrorCode(await bOnA.json(), "STUDENT_NOT_REGISTERED");
});