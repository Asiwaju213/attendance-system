import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";

const TEST_PASSWORD = "lecturer-catalog-test-password";
const ADMIN_USERNAME = "lcat_admin";
const STUDENT_MATRIC = "LCAT/STU";
const LECTURER_1_STAFF_ID = "LCAT/LEC1";
const LECTURER_2_STAFF_ID = "LCAT/LEC2";

const ALL_COURSE_PREFIX = "LCAT%";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturer1UserId = 0;
let lecturer2UserId = 0;
let noProfileUserId = 0;

let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;

let dep1Id = 0;
let level100Id = 0;
let academicSessionId = 0;
let firstSemesterId = 0;
let secondSemesterId = 0;

let course1Id = 0;
let course2Id = 0;
let courseInactiveId = 0;

let offeringOpen1Id = 0;
let offeringOpen2Id = 0;
let offeringClosedId = 0;
let offeringLec2Id = 0;
let offeringInactiveCourseId = 0;

let networkActive1Id = 0;
let networkActive2Id = 0;
let networkInactiveId = 0;

let locationActive1Id = 0;
let locationActive2Id = 0;
let locationInactiveId = 0;

const ALL_USER_IDS = () => [
  adminUserId,
  studentUserId,
  lecturer1UserId,
  lecturer2UserId,
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
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE $1)
     )`,
    [ALL_COURSE_PREFIX]
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE $1)
     )`,
    [ALL_COURSE_PREFIX]
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE $1)`,
    [ALL_COURSE_PREFIX]
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE $1`, [
    ALL_COURSE_PREFIX,
  ]);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'LCAT%'`);
  await pool.query(
    `DELETE FROM audit_logs
     WHERE user_id = ANY($1::BIGINT[])`,
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
  await pool.query(`DELETE FROM locations WHERE name LIKE 'LCAT-LOC%'`);
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'LCAT-NET%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'LCAT%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'LCAT%'`);
}

before(async () => {
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LCAT Admin', $1, 'ADMIN', 'ACTIVE', $2) RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('LCAT Faculty', 'LCAT-FAC') RETURNING id`
  );
  const facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('LCAT Department', 'LCAT-DEP', $1) RETURNING id`,
    [facId]
  );
  dep1Id = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ('LCAT-2026', true) RETURNING id`
  );
  academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(`SELECT id FROM semesters WHERE name = 'First Semester'`);
  firstSemesterId = Number(sem.rows[0].id);
  const sem2 = await pool.query(`SELECT id FROM semesters WHERE name = 'Second Semester'`);
  secondSemesterId = Number(sem2.rows[0].id);

  const course1 = await pool.query(
    `INSERT INTO courses (course_code, title, department_id, level_id)
     VALUES ('LCAT-101', 'LCAT Course One', $1, $2) RETURNING id`,
    [dep1Id, level100Id]
  );
  course1Id = Number(course1.rows[0].id);

  const course2 = await pool.query(
    `INSERT INTO courses (course_code, title, department_id, level_id)
     VALUES ('LCAT-102', 'LCAT Course Two', $1, $2) RETURNING id`,
    [dep1Id, level100Id]
  );
  course2Id = Number(course2.rows[0].id);

  const courseInactive = await pool.query(
    `INSERT INTO courses (course_code, title, department_id, level_id, status)
     VALUES ('LCAT-103', 'LCAT Course Inactive', $1, $2, 'INACTIVE') RETURNING id`,
    [dep1Id, level100Id]
  );
  courseInactiveId = Number(courseInactive.rows[0].id);

  const offeringOpen1 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course1Id, academicSessionId, firstSemesterId]
  );
  offeringOpen1Id = Number(offeringOpen1.rows[0].id);

  const offeringOpen2 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course2Id, academicSessionId, firstSemesterId]
  );
  offeringOpen2Id = Number(offeringOpen2.rows[0].id);

  const offeringClosed = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'CLOSED') RETURNING id`,
    [course1Id, academicSessionId, secondSemesterId]
  );
  offeringClosedId = Number(offeringClosed.rows[0].id);

  const offeringLec2 = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [course2Id, academicSessionId, secondSemesterId]
  );
  offeringLec2Id = Number(offeringLec2.rows[0].id);

  const offeringInactiveCourse = await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [courseInactiveId, academicSessionId, firstSemesterId]
  );
  offeringInactiveCourseId = Number(offeringInactiveCourse.rows[0].id);

  const netA1 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('LCAT-NET-A1', 'LCAT Network Active One') RETURNING id`
  );
  networkActive1Id = Number(netA1.rows[0].id);

  const netA2 = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('LCAT-NET-A2', 'LCAT Network Active Two') RETURNING id`
  );
  networkActive2Id = Number(netA2.rows[0].id);

  const netI = await pool.query(
    `INSERT INTO attendance_networks (network_code, name, status)
     VALUES ('LCAT-NET-I1', 'LCAT Network Inactive', 'INACTIVE') RETURNING id`
  );
  networkInactiveId = Number(netI.rows[0].id);

  const locA1 = await pool.query(
    `INSERT INTO locations (name) VALUES ('LCAT-LOC-A1') RETURNING id`
  );
  locationActive1Id = Number(locA1.rows[0].id);

  const locA2 = await pool.query(
    `INSERT INTO locations (name) VALUES ('LCAT-LOC-A2') RETURNING id`
  );
  locationActive2Id = Number(locA2.rows[0].id);

  const locI = await pool.query(
    `INSERT INTO locations (name, status) VALUES ('LCAT-LOC-I1', 'INACTIVE') RETURNING id`
  );
  locationInactiveId = Number(locI.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LCAT Student', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
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
     VALUES ('LCAT Lecturer One', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
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
     VALUES ('LCAT Lecturer Two', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  lecturer2UserId = Number(lecturer2.rows[0].id);
  const l2Profile = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [lecturer2UserId, LECTURER_2_STAFF_ID, dep1Id]
  );
  lecturer2ProfileId = Number(l2Profile.rows[0].id);

  const noProfile = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('LCAT No Profile', $1, 'LECTURER', 'ACTIVE', NULL) RETURNING id`,
    [passwordHash]
  );
  noProfileUserId = Number(noProfile.rows[0].id);

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offeringOpen1Id, lecturer1ProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offeringOpen2Id, lecturer1ProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offeringClosedId, lecturer1ProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offeringInactiveCourseId, lecturer1ProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [offeringLec2Id, lecturer2ProfileId]
  );

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

async function noProfileToken(): Promise<string> {
  const token = `lcat-token-${Math.random().toString(36).slice(2)}`;
  await createSession(
    noProfileUserId,
    hashSessionToken(token),
    new Date(Date.now() + 3600_000)
  );
  return token;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("catalog endpoints require authentication", async () => {
  for (const path of [
    "/api/lecturer/attendance-networks",
    "/api/lecturer/locations",
    "/api/lecturer/course-offerings",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 401, `${path} should require auth`);
  }
});

test("students cannot read the lecturer catalog", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  for (const path of [
    "/api/lecturer/attendance-networks",
    "/api/lecturer/locations",
    "/api/lecturer/course-offerings",
  ]) {
    const res = await get(path, cookieHeader(token!));
    assert.equal(res.status, 403, `${path} should reject students`);
    assertErrorCode(await res.json(), "FORBIDDEN");
  }
});

// ---------------------------------------------------------------------------
// Attendance networks
// ---------------------------------------------------------------------------

test("only active networks are returned with safe display fields", async () => {
  const token = await lecturer1Token();
  const res = await get("/api/lecturer/attendance-networks", cookieHeader(token));
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    data: Array<Record<string, unknown>>;
  };
  const ids = body.data.map((n) => n.id);
  assert.ok(
    ids.includes(networkActive1Id) && ids.includes(networkActive2Id),
    "active networks must be included"
  );
  assert.ok(
    !ids.includes(networkInactiveId),
    "inactive networks must be excluded"
  );

  const a1 = body.data.find((n) => n.id === networkActive1Id)!;
  assert.deepEqual(Object.keys(a1).sort(), ["id", "name", "networkCode"]);
  assert.equal(a1.networkCode, "LCAT-NET-A1");
  assert.equal(a1.name, "LCAT Network Active One");
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

test("only active locations are returned with safe display fields", async () => {
  const token = await lecturer1Token();
  const res = await get("/api/lecturer/locations", cookieHeader(token));
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    data: Array<Record<string, unknown>>;
  };
  const ids = body.data.map((l) => l.id);
  assert.ok(ids.includes(locationActive1Id) && ids.includes(locationActive2Id));
  assert.ok(!ids.includes(locationInactiveId), "inactive locations must be excluded");

  const l1 = body.data.find((l) => l.id === locationActive1Id)!;
  assert.deepEqual(Object.keys(l1).sort(), ["description", "id", "name"]);
  assert.equal(l1.name, "LCAT-LOC-A1");
  assert.equal(l1.description, null);
});

// ---------------------------------------------------------------------------
// Course offerings
// ---------------------------------------------------------------------------

test("lecturer sees only their own open offerings on active courses", async () => {
  const token = await lecturer1Token();
  const res = await get("/api/lecturer/course-offerings", cookieHeader(token));
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    data: Array<Record<string, unknown>>;
  };
  const offerings = body.data;
  const ids = offerings.map((o) => o.id);

  assert.deepEqual(new Set(ids), new Set([offeringOpen1Id, offeringOpen2Id]));
  assert.ok(!ids.includes(offeringClosedId), "closed offerings must be excluded");
  assert.ok(
    !ids.includes(offeringInactiveCourseId),
    "offerings on inactive courses must be excluded"
  );
  assert.ok(!ids.includes(offeringLec2Id), "other lecturers' offerings must be excluded");

  const open1 = offerings.find((o) => o.id === offeringOpen1Id)!;
  assert.deepEqual(
    Object.keys(open1).sort(),
    ["academicSessionName", "courseCode", "courseTitle", "id", "levelName", "semesterName", "status"]
  );
  assert.equal(open1.courseCode, "LCAT-101");
  assert.equal(open1.courseTitle, "LCAT Course One");
  assert.equal(open1.academicSessionName, "LCAT-2026");
  assert.equal(open1.semesterName, "First Semester");
  assert.equal(open1.levelName, 100);
  assert.equal(open1.status, "OPEN");
});

test("each lecturer sees only their own offerings", async () => {
  const token = await lecturer2Token();
  const res = await get("/api/lecturer/course-offerings", cookieHeader(token));
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    data: Array<Record<string, unknown>>;
  };
  const ids = body.data.map((o) => o.id);
  assert.deepEqual(new Set(ids), new Set([offeringLec2Id]));
});

test("a lecturer without a profile row gets LECTURER_NOT_FOUND", async () => {
  const token = await noProfileToken();
  const res = await get("/api/lecturer/course-offerings", cookieHeader(token));
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "LECTURER_NOT_FOUND");
});