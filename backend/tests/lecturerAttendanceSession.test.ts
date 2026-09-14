import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";

const TEST_PASSWORD = "lecturer-session-test-password";
const ADMIN_USERNAME = "latt_admin";
const STUDENT_MATRIC = "LATT/STU";
const LECTURER_1_STAFF_ID = "LATT/LEC1";
const LECTURER_2_STAFF_ID = "LATT/LEC2";
const LECTURER_3_STAFF_ID = "LATT/LEC3";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturer1UserId = 0;
let lecturer2UserId = 0;
let lecturer3UserId = 0;
let noProfileUserId = 0;

let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;

let dep1Id = 0;
let level100Id = 0;

let academicSessionId = 0;
let firstSemesterId = 0;

let course1Id = 0;
let course2Id = 0;
let courseInactiveId = 0;

let offering1Id = 0;
let offering2Id = 0;
let offering3Id = 0;
let offering4Id = 0;

let network1Id = 0;
let network2Id = 0;
let location1Id = 0;
let location2Id = 0;

const ALL_USER_IDS = () => [
  adminUserId,
  studentUserId,
  lecturer1UserId,
  lecturer2UserId,
  lecturer3UserId,
  noProfileUserId,
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

function validCreateBody(): Record<string, unknown> {
  return {
    courseOfferingId: offering1Id,
    attendanceNetworkId: network1Id,
    locationId: location1Id,
    durationMinutes: 60,
    lateThresholdMinutes: 5,
  };
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
    [ALL_USER_IDS()]
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
     )`,
    [ALL_USER_IDS()]
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LATT%')
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LATT%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'LATT%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'LATT%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'LATT%'`);
  await pool.query(
    `DELETE FROM audit_logs
     WHERE user_id = ANY($1::BIGINT[])
       AND action IN ('SESSION_STARTED', 'SESSION_ENDED')`,
    [ALL_USER_IDS()]
  );
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    ALL_USER_IDS(),
  ]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
    ALL_USER_IDS(),
  ]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [
    ALL_USER_IDS(),
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [
    ALL_USER_IDS(),
  ]);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'LATT%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'LATT%'`);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'LATT%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'LATT-LOC%'`);
}

async function resetSessionState(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records
     WHERE session_id IN (
       SELECT id FROM attendance_sessions
       WHERE started_by_lecturer_id IN (
         SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
       )
     )`,
    [ALL_USER_IDS()]
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
     )`,
    [ALL_USER_IDS()]
  );
  await pool.query(
    `DELETE FROM audit_logs
     WHERE user_id = ANY($1::BIGINT[])
       AND action IN ('SESSION_STARTED', 'SESSION_ENDED')`,
    [ALL_USER_IDS()]
  );
  await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE id = ANY($1::BIGINT[])`, [
    ALL_USER_IDS(),
  ]);
}

async function insertExpiredActiveSession(
  lecturerProfileId: number
): Promise<number> {
  const inserted = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status)
     VALUES ($1, $2, $3, $4, now() - interval '2 hours', now() - interval '1 hour',
             '0', 'ACTIVE')
     RETURNING id`,
    [offering1Id, lecturerProfileId, network1Id, location1Id]
  );
  return Number(inserted.rows[0].id);
}

async function insertEndedSession(
  lecturerProfileId: number,
  sourceSessionId: number
): Promise<number> {
  const inserted = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, ended_at)
     SELECT course_offering_id, $1, attendance_network_id,
            location_id, start_time, start_time + interval '30 minutes',
            '0', 'ENDED', start_time + interval '30 minutes'
     FROM attendance_sessions WHERE id = $2
     RETURNING id`,
    [lecturerProfileId, sourceSessionId]
  );
  return Number(inserted.rows[0].id);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LATT Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('LATT Faculty', 'LATT-FAC') RETURNING id`
  );
  const facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('LATT Department', 'LATT-DEP', $1) RETURNING id`,
    [facId]
  );
  dep1Id = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ('LATT-2026', true) RETURNING id`
  );
  academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  firstSemesterId = Number(sem.rows[0].id);

  const course1 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('LATT-101', 'LATT Course One', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course1Id = Number(course1.rows[0].id);

  const course2 = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('LATT-102', 'LATT Course Two', $1, $2) RETURNING id`,
    [facId, level100Id]
  );
  course2Id = Number(course2.rows[0].id);

  const courseInactive = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
     VALUES ('LATT-103', 'LATT Course Inactive', $1, $2, 'INACTIVE') RETURNING id`,
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

  const offering3 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'CLOSED') RETURNING id`,
    [course1Id, academicSessionId, secondSemesterId]
  );
  offering3Id = Number(offering3.rows[0].id);

  const offering4 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [courseInactiveId, academicSessionId, firstSemesterId]
  );
  offering4Id = Number(offering4.rows[0].id);

  const network1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('LATT-NET1', 'LATT Network One') RETURNING id`
  );
  network1Id = Number(network1.rows[0].id);

  const network2 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name, status)
     VALUES ('LATT-NET2', 'LATT Network Inactive', 'INACTIVE') RETURNING id`
  );
  network2Id = Number(network2.rows[0].id);

  const location1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('LATT-LOC1') RETURNING id`
  );
  location1Id = Number(location1.rows[0].id);

  const location2 = await pool.query(
    `INSERT INTO locations (name, status) VALUES ('LATT-LOC2', 'INACTIVE') RETURNING id`
  );
  location2Id = Number(location2.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LATT Student', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [studentUserId, STUDENT_MATRIC, dep1Id, level100Id]
  );

  const lecturer1 = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LATT Lecturer One', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  lecturer1UserId = Number(lecturer1.rows[0].id);
  const l1Profile = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [lecturer1UserId, LECTURER_1_STAFF_ID, dep1Id]
  );
  lecturer1ProfileId = Number(l1Profile.rows[0].id);

  const lecturer2 = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LATT Lecturer Two', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  lecturer2UserId = Number(lecturer2.rows[0].id);
  const l2Profile = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [lecturer2UserId, LECTURER_2_STAFF_ID, dep1Id]
  );
  lecturer2ProfileId = Number(l2Profile.rows[0].id);

  const lecturer3 = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LATT Lecturer Three', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  lecturer3UserId = Number(lecturer3.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturer3UserId, LECTURER_3_STAFF_ID, dep1Id]
  );

  const noProfile = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LATT No Profile', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  noProfileUserId = Number(noProfile.rows[0].id);

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offering1Id, lecturer1ProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offering3Id, lecturer1ProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offering2Id, lecturer2ProfileId]
  );

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(resetSessionState);

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
    staffId: LECTURER_1_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token, "lecturer login should issue a session cookie");
  return token;
}

async function lecturer2Token(): Promise<string> {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_2_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token, "lecturer login should issue a session cookie");
  return token;
}

async function createSessionViaApi(
  token: string,
  body: Record<string, unknown> = validCreateBody()
): Promise<Record<string, unknown>> {
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    body,
    cookieHeader(token)
  );
  assert.equal(res.status, 201);
  const json = (await res.json()) as { data: Record<string, unknown> };
  return json.data;
}

// ---------------------------------------------------------------------------
// Authentication / authorization
// ---------------------------------------------------------------------------

test("unauthenticated requests cannot create an attendance session", async () => {
  const res = await postJson("/api/lecturer/attendance-sessions", validCreateBody());
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("students cannot create an attendance session", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    validCreateBody(),
    cookieHeader(token!)
  );
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("an inactive lecturer cannot create an attendance session", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_3_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  await pool.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [
    lecturer3UserId,
  ]);
  try {
    const res = await postJson(
      "/api/lecturer/attendance-sessions",
      validCreateBody(),
      cookieHeader(token!)
    );
    assert.equal(res.status, 401);
    assertErrorCode(await res.json(), "UNAUTHENTICATED");
  } finally {
    await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [
      lecturer3UserId,
    ]);
  }
});

test("a lecturer without a profile row is rejected", async () => {
  const rawToken = "latt-no-profile-token";
  await createSession(
    noProfileUserId,
    hashSessionToken(rawToken),
    new Date(Date.now() + 3600_000)
  );

  const createRes = await postJson(
    "/api/lecturer/attendance-sessions",
    validCreateBody(),
    cookieHeader(rawToken)
  );
  assert.equal(createRes.status, 404);
  assertErrorCode(await createRes.json(), "LECTURER_NOT_FOUND");

  const listRes = await get(
    "/api/lecturer/attendance-sessions",
    cookieHeader(rawToken)
  );
  assert.equal(listRes.status, 404);
  assertErrorCode(await listRes.json(), "LECTURER_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

test("invalid request bodies are rejected with 400", async () => {
  const token = await lecturer1Token();
  const base = validCreateBody();

  const badIds = [
    { ...base, courseOfferingId: 0 },
    { ...base, courseOfferingId: -5 },
    { ...base, attendanceNetworkId: 0 },
    { ...base, locationId: "abc" },
    { ...base, courseOfferingId: "not-a-number" },
    { ...base, durationMinutes: undefined },
  ];

  for (const body of badIds) {
    const res = await postJson(
      "/api/lecturer/attendance-sessions",
      body,
      cookieHeader(token)
    );
    assert.equal(res.status, 400, JSON.stringify(body));
    assertInvalidRequest(await res.json());
  }
});

test("duration boundaries are enforced", async () => {
  const token = await lecturer1Token();
  const base = validCreateBody();

  const zero = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...base, durationMinutes: 0 },
    cookieHeader(token)
  );
  assert.equal(zero.status, 400);
  assertInvalidRequest(await zero.json());

  const over = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...base, durationMinutes: 481 },
    cookieHeader(token)
  );
  assert.equal(over.status, 400);
  assertInvalidRequest(await over.json());

  const fractional = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...base, durationMinutes: 1.5 },
    cookieHeader(token)
  );
  assert.equal(fractional.status, 400);
  assertInvalidRequest(await fractional.json());

  const text = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...base, durationMinutes: "oops" },
    cookieHeader(token)
  );
  assert.equal(text.status, 400);
  assertInvalidRequest(await text.json());
});

test("late threshold boundaries are enforced", async () => {
  const token = await lecturer1Token();
  const base = validCreateBody();

  const negative = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...base, lateThresholdMinutes: -1 },
    cookieHeader(token)
  );
  assert.equal(negative.status, 400);
  assertInvalidRequest(await negative.json());

  const over = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...base, lateThresholdMinutes: 121 },
    cookieHeader(token)
  );
  assert.equal(over.status, 400);
  assertInvalidRequest(await over.json());

  const beyondDuration = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...base, durationMinutes: 30, lateThresholdMinutes: 31 },
    cookieHeader(token)
  );
  assert.equal(beyondDuration.status, 400);
  assertInvalidRequest(await beyondDuration.json());
});

// ---------------------------------------------------------------------------
// Offering / course / assignment validation
// ---------------------------------------------------------------------------

test("course offering must exist", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), courseOfferingId: 999999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "OFFERING_NOT_FOUND");
});

test("course offering must be OPEN", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), courseOfferingId: offering3Id },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "OFFERING_NOT_OPEN");
});

test("course belonging to the offering must be ACTIVE", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), courseOfferingId: offering4Id },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "COURSE_NOT_ACTIVE");
});

test("lecturer must be assigned to the offering", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), courseOfferingId: offering2Id },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "LECTURER_NOT_ASSIGNED");
});

// ---------------------------------------------------------------------------
// Network / location validation
// ---------------------------------------------------------------------------

test("attendance network must exist", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), attendanceNetworkId: 999999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "ATTENDANCE_NETWORK_NOT_FOUND");
});

test("attendance network must be ACTIVE", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), attendanceNetworkId: network2Id },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "ATTENDANCE_NETWORK_INACTIVE");
});

test("location must exist", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), locationId: 999999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "LOCATION_NOT_FOUND");
});

test("location must be ACTIVE", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), locationId: location2Id },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "LOCATION_INACTIVE");
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test("a valid assigned lecturer can create an attendance session", async () => {
  const token = await lecturer1Token();
  const data = await createSessionViaApi(token);

  assert.equal(data.courseOfferingId, offering1Id);
  assert.equal(data.courseCode, "LATT-101");
  assert.equal(data.courseTitle, "LATT Course One");
  assert.equal(data.attendanceNetworkId, network1Id);
  assert.equal(data.attendanceNetworkName, "LATT Network One");
  assert.equal(data.locationId, location1Id);
  assert.equal(data.locationName, "LATT-LOC1");
  assert.equal(data.lateThresholdMinutes, 5);
  assert.equal(data.status, "ACTIVE");
  assert.equal(data.currentState, "ACTIVE");
  assert.equal(data.endedAt, null);
  assert.equal(typeof data.id, "number");
});

test("server generates start_time and end_time from duration", async () => {
  const token = await lecturer1Token();
  const before = Date.now();
  const data = await createSessionViaApi(token, {
    ...validCreateBody(),
    durationMinutes: 90,
    lateThresholdMinutes: 15,
  });
  const after = Date.now();

  const start = new Date(data.startTime as string).getTime();
  const end = new Date(data.endTime as string).getTime();

  assert.ok(start >= before - 60_000, "start_time should be the current time");
  assert.ok(start <= after + 5_000, "start_time should be the current time");
  assert.equal(end - start, 90 * 60 * 1000, "end_time = start_time + duration");
});

test("late_threshold interval is stored correctly", async () => {
  const token = await lecturer1Token();
  const data = await createSessionViaApi(token, {
    ...validCreateBody(),
    lateThresholdMinutes: 15,
  });

  const row = await pool.query(
    `SELECT late_threshold::text AS late_threshold, status, ended_at, start_time, end_time
     FROM attendance_sessions WHERE id = $1`,
    [data.id]
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].late_threshold, "00:15:00");
  assert.equal(row.rows[0].status, "ACTIVE");
  assert.equal(row.rows[0].ended_at, null);
});

test("client-supplied lecturer id, start time, status, and endedAt cannot override server values", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    {
      ...validCreateBody(),
      startedByLecturerId: lecturer2ProfileId,
      startTime: "2020-01-01T00:00:00.000Z",
      endTime: "2020-01-01T01:00:00.000Z",
      status: "ENDED",
      endedAt: "2020-01-01T00:30:00.000Z",
    },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };

  const start = new Date(body.data.startTime as string).getTime();
  assert.ok(start > Date.now() - 60_000, "startTime must be server time, not a client override");
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(body.data.currentState, "ACTIVE");
  assert.equal(body.data.endedAt, null);
});

test("a duplicate currently-active session is rejected", async () => {
  const token = await lecturer1Token();
  await createSessionViaApi(token);

  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    validCreateBody(),
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "ACTIVE_SESSION_EXISTS");
});

test("different lecturers can each have an active session", async () => {
  const token1 = await lecturer1Token();
  const token2 = await lecturer2Token();

  const create1 = await postJson(
    "/api/lecturer/attendance-sessions",
    validCreateBody(),
    cookieHeader(token1)
  );
  assert.equal(create1.status, 201);

  const create2 = await postJson(
    "/api/lecturer/attendance-sessions",
    {
      ...validCreateBody(),
      courseOfferingId: offering2Id,
    },
    cookieHeader(token2)
  );
  assert.equal(create2.status, 201);

  const result = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_sessions WHERE status = 'ACTIVE'`
  );
  assert.equal(result.rows[0].n, 2);
});

test("an expired previous session is reconciled and a new active session is created", async () => {
  const token = await lecturer1Token();
  const expiredId = await insertExpiredActiveSession(lecturer1ProfileId);

  const res = await postJson(
    "/api/lecturer/attendance-sessions",
    validCreateBody(),
    cookieHeader(token)
  );
  assert.equal(res.status, 201);

  const oldRow = await pool.query(
    `SELECT status, ended_at, end_time FROM attendance_sessions WHERE id = $1`,
    [expiredId]
  );
  assert.equal(oldRow.rows[0].status, "ENDED");
  assert.ok(oldRow.rows[0].ended_at, "ended_at should be set");
  const endedAt = new Date(oldRow.rows[0].ended_at).getTime();
  const scheduledEnd = new Date(oldRow.rows[0].end_time).getTime();
  assert.ok(
    Math.abs(endedAt - scheduledEnd) < 5000,
    "ended_at should equal the scheduled end_time"
  );

  const activeCount = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_sessions
     WHERE started_by_lecturer_id = $1 AND status = 'ACTIVE'`,
    [lecturer1ProfileId]
  );
  assert.equal(activeCount.rows[0].n, 1);
});

test("concurrent creation cannot produce two active sessions for the same lecturer", async () => {
  const token = await lecturer1Token();

  const [res1, res2] = await Promise.all([
    postJson("/api/lecturer/attendance-sessions", validCreateBody(), cookieHeader(token)),
    postJson("/api/lecturer/attendance-sessions", validCreateBody(), cookieHeader(token)),
  ]);

  const statuses = [res1.status, res2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409]);

  const conflict = res1.status === 409 ? res1 : res2;
  assertErrorCode(await conflict.json(), "ACTIVE_SESSION_EXISTS");

  const activeCount = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_sessions
     WHERE started_by_lecturer_id = $1 AND status = 'ACTIVE'`,
    [lecturer1ProfileId]
  );
  assert.equal(activeCount.rows[0].n, 1);
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test("a lecturer sees only their own sessions", async () => {
  const token1 = await lecturer1Token();
  const token2 = await lecturer2Token();

  const mine = await createSessionViaApi(token1);
  await createSessionViaApi(token2, {
    ...validCreateBody(),
    courseOfferingId: offering2Id,
  });

  const res = await get("/api/lecturer/attendance-sessions", cookieHeader(token1));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };

  const ids = body.data.map((s) => s.id);
  assert.ok(ids.includes(mine.id), "lecturer should see their own session");
  assert.ok(
    body.data.every(
      (s) => s.courseOfferingId !== offering2Id,
      "lecturer must not see another lecturer's session"
    )
  );
});

test("sessions are listed newest first by start_time then id", async () => {
  const token = await lecturer1Token();

  const first = await createSessionViaApi(token, { ...validCreateBody(), durationMinutes: 30, lateThresholdMinutes: 0 });

  await postJson(
    `/api/lecturer/attendance-sessions/${first.id}/end`,
    {},
    cookieHeader(token)
  );

  // A row sharing first's start_time but with a later id, ended already.
  const tieId = await insertEndedSession(lecturer1ProfileId, first.id as number);

  const second = await createSessionViaApi(token, { ...validCreateBody(), durationMinutes: 60, lateThresholdMinutes: 5 });

  const res = await get("/api/lecturer/attendance-sessions", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };

  const ids = body.data.map((s) => s.id as number);
  const secondIdx = ids.indexOf(second.id as number);
  const tieIdx = ids.indexOf(tieId);
  const firstIdx = ids.indexOf(first.id as number);

  assert.ok(secondIdx >= 0 && tieIdx >= 0 && firstIdx >= 0);
  assert.ok(secondIdx < tieIdx, "newer start_time should come first");
  assert.ok(tieIdx < firstIdx, "same start_time: higher id should come first");
});

test("historical sessions are included and currentState is computed correctly", async () => {
  const token = await lecturer1Token();
  const token2 = await lecturer2Token();

  const active = await createSessionViaApi(token);

  const expiredId = await insertExpiredActiveSession(lecturer2ProfileId);

  const endRes = await postJson(
    `/api/lecturer/attendance-sessions/${active.id}/end`,
    {},
    cookieHeader(token)
  );
  assert.equal(endRes.status, 200);
  assert.equal((await endRes.json()).data.currentState, "ENDED");

  const res = await get("/api/lecturer/attendance-sessions", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };

  const byId = new Map(body.data.map((s) => [s.id as number, s.currentState as string]));
  assert.equal(byId.get(active.id as number), "ENDED");
  assert.ok(body.data.length >= 1);

  const res2 = await get("/api/lecturer/attendance-sessions", cookieHeader(token2));
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as { data: Array<Record<string, unknown>> };
  const expiredRow = body2.data.find((s) => s.id === expiredId);
  assert.ok(expiredRow, "expired historical session should be listed");
  assert.equal(expiredRow!.currentState, "EXPIRED");
  assert.equal(expiredRow!.status, "ACTIVE", "expired row stays ACTIVE in the database");
});

// ---------------------------------------------------------------------------
// Manual ending
// ---------------------------------------------------------------------------

test("the owner can manually end an active session", async () => {
  const token = await lecturer1Token();
  const created = await createSessionViaApi(token, { ...validCreateBody(), durationMinutes: 60, lateThresholdMinutes: 5 });
  const scheduledEnd = created.endTime as string;

  const res = await postJson(
    `/api/lecturer/attendance-sessions/${created.id}/end`,
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };

  assert.equal(body.data.status, "ENDED");
  assert.equal(body.data.currentState, "ENDED");
  assert.ok(body.data.endedAt, "endedAt should be set by the server");
  assert.equal(
    body.data.endTime,
    scheduledEnd,
    "scheduled end_time must remain unchanged"
  );
  assert.equal(body.data.startTime, created.startTime);

  const saved = await pool.query(
    `SELECT status, ended_at, end_time FROM attendance_sessions WHERE id = $1`,
    [created.id]
  );
  assert.equal(saved.rows[0].status, "ENDED");
  assert.ok(saved.rows[0].ended_at);
  assert.equal(new Date(saved.rows[0].end_time).toISOString(), scheduledEnd);
});

test("ending an already-ended session is rejected", async () => {
  const token = await lecturer1Token();
  const created = await createSessionViaApi(token);
  await postJson(
    `/api/lecturer/attendance-sessions/${created.id}/end`,
    {},
    cookieHeader(token)
  );

  const res = await postJson(
    `/api/lecturer/attendance-sessions/${created.id}/end`,
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "SESSION_ALREADY_ENDED");
});

test("ending an expired session is rejected with SESSION_EXPIRED and the row is not mutated", async () => {
  const token = await lecturer1Token();
  const expiredId = await insertExpiredActiveSession(lecturer1ProfileId);

  const res = await postJson(
    `/api/lecturer/attendance-sessions/${expiredId}/end`,
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "SESSION_EXPIRED");

  const saved = await pool.query(
    `SELECT status, ended_at FROM attendance_sessions WHERE id = $1`,
    [expiredId]
  );
  assert.equal(saved.rows[0].status, "ACTIVE");
  assert.equal(saved.rows[0].ended_at, null);
});

test("a lecturer cannot end another lecturer's session", async () => {
  const token1 = await lecturer1Token();
  const token2 = await lecturer2Token();

  const created = await createSessionViaApi(token1);

  const res = await postJson(
    `/api/lecturer/attendance-sessions/${created.id}/end`,
    {},
    cookieHeader(token2)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

test("ending a nonexistent session returns 404", async () => {
  const token = await lecturer1Token();
  const res = await postJson(
    "/api/lecturer/attendance-sessions/999999/end",
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

test("an invalid session id is rejected", async () => {
  const token = await lecturer1Token();
  const letters = await postJson(
    "/api/lecturer/attendance-sessions/abc/end",
    {},
    cookieHeader(token)
  );
  assert.equal(letters.status, 400);
  assertInvalidRequest(await letters.json());

  const zero = await postJson(
    "/api/lecturer/attendance-sessions/0/end",
    {},
    cookieHeader(token)
  );
  assert.equal(zero.status, 400);
  assertInvalidRequest(await zero.json());
});

test("concurrent end requests are safe", async () => {
  const token = await lecturer1Token();
  const created = await createSessionViaApi(token);

  const [res1, res2] = await Promise.all([
    postJson(`/api/lecturer/attendance-sessions/${created.id}/end`, {}, cookieHeader(token)),
    postJson(`/api/lecturer/attendance-sessions/${created.id}/end`, {}, cookieHeader(token)),
  ]);

  const statuses = [res1.status, res2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);

  const conflict = res1.status === 409 ? res1 : res2;
  assertErrorCode(await conflict.json(), "SESSION_ALREADY_ENDED");

  const saved = await pool.query(
    `SELECT status FROM attendance_sessions WHERE id = $1`,
    [created.id]
  );
  assert.equal(saved.rows[0].status, "ENDED");
});

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

test("audit logs record session start and manual end", async () => {
  const token = await lecturer1Token();
  const created = await createSessionViaApi(token);

  await postJson(
    `/api/lecturer/attendance-sessions/${created.id}/end`,
    {},
    cookieHeader(token)
  );

  const logs = await pool.query(
    `SELECT action, entity_id FROM audit_logs
     WHERE user_id = $1 AND entity_type = 'attendance_sessions'
     ORDER BY id ASC`,
    [lecturer1UserId]
  );

  assert.deepEqual(
    logs.rows.map((r) => r.action),
    ["SESSION_STARTED", "SESSION_ENDED"]
  );
  assert.equal(Number(logs.rows[0].entity_id), created.id);
  assert.equal(Number(logs.rows[1].entity_id), created.id);
});