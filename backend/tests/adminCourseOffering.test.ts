import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-offering-test-password";
const ADMIN_USERNAME = "admin_cof_admin";
const STUDENT_MATRIC = "ADMCOF/STU";
const LECTURER_1_STAFF_ID = "ADMCOF/LEC1";
const LECTURER_2_STAFF_ID = "ADMCOF/LEC2";
const INACTIVE_LECTURER_STAFF_ID = "ADMCOF/LECI";
const NON_LECTURER_STAFF_ID = "ADMCOF/NL";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturer1UserId = 0;
let lecturer2UserId = 0;
let inactiveLecturerUserId = 0;
let nonLecturerUserId = 0;

let studentProfileId = 0;
let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;
let inactiveLecturerProfileId = 0;
let nonLecturerProfileId = 0;

let fac1Id = 0;
let fac2Id = 0;
let dep1Id = 0;
let dep2Id = 0;
let level100Id = 0;
let level200Id = 0;
let level500Id = 0;

let session2026Id = 0;
let session2027Id = 0;
let firstSemesterId = 0;
let secondSemesterId = 0;

let courseA1Id = 0;
let courseD1Id = 0;

let offeringId1 = 0;
let offeringId2 = 0;
let offeringId3 = 0;
let offeringId4 = 0;

const ALL_USER_IDS = () => [
  adminUserId,
  studentUserId,
  lecturer1UserId,
  lecturer2UserId,
  inactiveLecturerUserId,
  nonLecturerUserId,
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

async function patchJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function deleteVia(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { method: "DELETE", headers });
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

async function cleanupScopedData(): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_records
     WHERE session_id IN (
       SELECT id FROM attendance_sessions
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMCOF%')
            OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ADMCOF%')
       )
     )`
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMCOF%')
          OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ADMCOF%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMCOF%')
          OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ADMCOF%')
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMCOF%')
          OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ADMCOF%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMCOF%')
        OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ADMCOF%')`
  );
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMCOF%'`);
  await pool.query(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT user_id FROM students WHERE matric_number = ANY($1::TEXT[])
       UNION
       SELECT user_id FROM lecturers WHERE staff_id = ANY($1::TEXT[])
       UNION
       SELECT id FROM users WHERE username = $2
     )`,
    [[STUDENT_MATRIC, LECTURER_1_STAFF_ID], ADMIN_USERNAME]
  );
  await pool.query(`DELETE FROM students WHERE matric_number = $1`, [STUDENT_MATRIC]);
  await pool.query(
    `DELETE FROM lecturers
     WHERE staff_id = ANY($1::TEXT[])`,
    [
      [
        LECTURER_1_STAFF_ID,
        LECTURER_2_STAFF_ID,
        INACTIVE_LECTURER_STAFF_ID,
        NON_LECTURER_STAFF_ID,
      ],
    ]
  );
  await pool.query(
    `DELETE FROM users
     WHERE username = $1
        OR id IN (
          SELECT user_id FROM students WHERE matric_number = $2
          UNION
          SELECT user_id FROM lecturers WHERE staff_id = ANY($3::TEXT[])
        )`,
    [
      ADMIN_USERNAME,
      STUDENT_MATRIC,
      [LECTURER_1_STAFF_ID, LECTURER_2_STAFF_ID, INACTIVE_LECTURER_STAFF_ID, NON_LECTURER_STAFF_ID],
    ]
  );
  await pool.query(`DELETE FROM attendance_networks WHERE network_code LIKE 'ADMCOF%'`);
  await pool.query(`DELETE FROM locations WHERE name LIKE 'ADMCOF%'`);
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ADMCOF%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMCOF%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMCOF%'`);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Offering Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac1 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Offering A', 'ADMCOF-FAC') RETURNING id`
  );
  fac1Id = Number(fac1.rows[0].id);
  const fac2 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Offering B', 'ADMCOF-FAC2') RETURNING id`
  );
  fac2Id = Number(fac2.rows[0].id);

  const dep1 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Offering Department A', 'ADMCOF-DEP', $1) RETURNING id`,
    [fac1Id]
  );
  dep1Id = Number(dep1.rows[0].id);
  const dep2 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Offering Department B', 'ADMCOF-DEP2', $1) RETURNING id`,
    [fac2Id]
  );
  dep2Id = Number(dep2.rows[0].id);

  const levelRes = await pool.query(
    `SELECT id, name FROM levels WHERE name IN (100, 200, 500)`
  );
  const levelIds = new Map<number, number>();
  for (const row of levelRes.rows) {
    levelIds.set(Number(row.name), Number(row.id));
  }
  level100Id = levelIds.get(100)!;
  level200Id = levelIds.get(200)!;
  level500Id = levelIds.get(500)!;

  const sessionRes = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ('ADMCOF-2026', true), ('ADMCOF-2027', false)
     RETURNING id, name`
  );
  const sessionIds = new Map<string, number>();
  for (const row of sessionRes.rows) {
    sessionIds.set(row.name, Number(row.id));
  }
  session2026Id = sessionIds.get("ADMCOF-2026")!;
  session2027Id = sessionIds.get("ADMCOF-2027")!;

  const semesterRes = await pool.query(`SELECT id, name FROM semesters`);
  const semesterIds = new Map<string, number>();
  for (const row of semesterRes.rows) {
    semesterIds.set(row.name, Number(row.id));
  }
  firstSemesterId = semesterIds.get("First Semester")!;
  secondSemesterId = semesterIds.get("Second Semester")!;

  const courseA1 = await pool.query(
    `INSERT INTO courses (course_code, title, level_id, faculty_id)
     VALUES ('ADMCOF-A1', 'Offering Course A1', $1, $2) RETURNING id`,
    [level100Id, fac1Id]
  );
  courseA1Id = Number(courseA1.rows[0].id);
  await pool.query(
    `INSERT INTO courses (course_code, title, level_id, department_id)
     VALUES ('ADMCOF-B2', 'Offering Course B2', $1, $2)`,
    [level200Id, dep1Id]
  );
  await pool.query(
    `INSERT INTO courses (course_code, title, level_id, faculty_id, status)
     VALUES ('ADMCOF-C1', 'Offering Course C1', $1, $2, 'INACTIVE')`,
    [level100Id, fac1Id]
  );
  const courseD1 = await pool.query(
    `INSERT INTO courses (course_code, title, level_id, faculty_id)
     VALUES ('ADMCOF-D1', 'Offering Course D1', $1, $2) RETURNING id`,
    [level500Id, fac1Id]
  );
  courseD1Id = Number(courseD1.rows[0].id);
  await pool.query(
    `INSERT INTO courses (course_code, title, level_id, department_id)
     VALUES ('ADMCOF-E2', 'Offering Course E2', $1, $2)`,
    [level200Id, dep2Id]
  );

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Offering Test Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  const studentProfile = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [studentUserId, STUDENT_MATRIC, dep1Id, level100Id]
  );
  studentProfileId = Number(studentProfile.rows[0].id);

  async function makeLecturer(userName: string, staffId: string, active: boolean) {
    const user = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
      [userName, passwordHash, "LECTURER", active ? "ACTIVE" : "INACTIVE"]
    );
    const profile = await pool.query(
      `INSERT INTO lecturers (user_id, staff_id, department_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [Number(user.rows[0].id), staffId, dep1Id]
    );
    return { userId: Number(user.rows[0].id), profileId: Number(profile.rows[0].id) };
  }

  const lecturer1 = await makeLecturer("Offering Lecturer One", LECTURER_1_STAFF_ID, true);
  lecturer1UserId = lecturer1.userId;
  lecturer1ProfileId = lecturer1.profileId;
  const lecturer2 = await makeLecturer("Offering Lecturer Two", LECTURER_2_STAFF_ID, true);
  lecturer2UserId = lecturer2.userId;
  lecturer2ProfileId = lecturer2.profileId;
  const inactiveLecturer = await makeLecturer(
    "Offering Lecturer Inactive",
    INACTIVE_LECTURER_STAFF_ID,
    false
  );
  inactiveLecturerUserId = inactiveLecturer.userId;
  inactiveLecturerProfileId = inactiveLecturer.profileId;

  const nonLecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Offering Test Non Lecturer', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  nonLecturerUserId = Number(nonLecturer.rows[0].id);
  const nonLecturerProfile = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [nonLecturerUserId, NON_LECTURER_STAFF_ID, dep1Id]
  );
  nonLecturerProfileId = Number(nonLecturerProfile.rows[0].id);

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
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [ALL_USER_IDS()]);
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

async function offeringsList(
  token: string,
  query = ""
): Promise<Array<Record<string, unknown>>> {
  const res = await get("/api/admin/course-offerings" + query, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

async function createOffering(
  token: string,
  courseId: number,
  academicSessionId: number,
  semesterId: number
): Promise<globalThis.Response> {
  return postJson(
    "/api/admin/course-offerings",
    { courseId, academicSessionId, semesterId },
    cookieHeader(token)
  );
}

function byCourse(list: Array<Record<string, unknown>>, code: string): Record<string, unknown> | undefined {
  return list.find((o) => o.courseCode === code);
}

function assertInvalidRequest(body: unknown): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, "INVALID_REQUEST");
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("course offering endpoints require authentication", async () => {
  const res = await get("/api/admin/course-offerings");
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("course offering endpoints reject students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);
  const res = await get("/api/admin/course-offerings", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("course offering endpoints reject lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_1_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);
  const res = await get("/api/admin/course-offerings", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("admin can list course offerings", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/course-offerings", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown };
  assert.ok(Array.isArray(body.data));
});

// ---------------------------------------------------------------------------
// Offering creation
// ---------------------------------------------------------------------------

test("admin can create a valid offering with joined information", async () => {
  const token = await adminToken();
  const res = await createOffering(token, courseA1Id, session2026Id, firstSemesterId);

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  offeringId1 = Number(body.data.id);

  assert.equal(body.data.courseId, courseA1Id);
  assert.equal(body.data.courseCode, "ADMCOF-A1");
  assert.equal(body.data.courseTitle, "Offering Course A1");
  assert.equal(body.data.levelId, level100Id);
  assert.equal(body.data.levelName, 100);
  assert.equal(body.data.academicSessionId, session2026Id);
  assert.equal(body.data.academicSessionName, "ADMCOF-2026");
  assert.equal(body.data.semesterId, firstSemesterId);
  assert.equal(body.data.semesterName, "First Semester");
  assert.equal(body.data.status, "OPEN");
  assert.equal(typeof body.data.createdAt, "string");
  assert.equal(typeof body.data.updatedAt, "string");
});

test("duplicate course/session/semester combinations are rejected with 409", async () => {
  const token = await adminToken();
  const res = await createOffering(token, courseA1Id, session2026Id, firstSemesterId);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "CONFLICT");
});

test("creating an offering for a nonexistent course returns 404", async () => {
  const token = await adminToken();
  const res = await createOffering(token, 999999, session2026Id, firstSemesterId);
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "COURSE_NOT_FOUND");
});

test("creating an offering for a nonexistent academic session returns 404", async () => {
  const token = await adminToken();
  const res = await createOffering(token, courseA1Id, 999999, firstSemesterId);
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "ACADEMIC_SESSION_NOT_FOUND");
});

test("creating an offering for a nonexistent semester returns 404", async () => {
  const token = await adminToken();
  const res = await createOffering(token, courseA1Id, session2026Id, 999999);
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SEMESTER_NOT_FOUND");
});

test("an inactive course cannot receive a new offering", async () => {
  const token = await adminToken();
  const inactiveCourse = await pool.query(
    `SELECT id FROM courses WHERE course_code = 'ADMCOF-C1'`
  );
  const res = await createOffering(token, Number(inactiveCourse.rows[0].id), session2026Id, secondSemesterId);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "COURSE_NOT_ACTIVE");
});

test("client-supplied status cannot create an unexpected status", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/course-offerings",
    {
      courseId: courseA1Id,
      academicSessionId: session2027Id,
      semesterId: firstSemesterId,
      status: "CLOSED",
    },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  offeringId2 = Number(body.data.id);
  assert.equal(body.data.status, "OPEN", "client-supplied status must be ignored");
});

test("invalid offering create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const missingCourse = await postJson(
    "/api/admin/course-offerings",
    { academicSessionId: session2026Id, semesterId: firstSemesterId },
    cookieHeader(token)
  );
  assert.equal(missingCourse.status, 400);
  assertInvalidRequest(await missingCourse.json());

  const stringCourse = await postJson(
    "/api/admin/course-offerings",
    { courseId: "5", academicSessionId: session2026Id, semesterId: firstSemesterId },
    cookieHeader(token)
  );
  assert.equal(stringCourse.status, 400);
  assertInvalidRequest(await stringCourse.json());

  const negativeSemester = await postJson(
    "/api/admin/course-offerings",
    { courseId: courseA1Id, academicSessionId: session2026Id, semesterId: -1 },
    cookieHeader(token)
  );
  assert.equal(negativeSemester.status, 400);
  assertInvalidRequest(await negativeSemester.json());
});

test("admin can create more offerings for list/filter coverage", async () => {
  const token = await adminToken();
  const b2 = await pool.query(`SELECT id FROM courses WHERE course_code = 'ADMCOF-B2'`);
  const e2 = await pool.query(`SELECT id FROM courses WHERE course_code = 'ADMCOF-E2'`);
  const b2Id = Number(b2.rows[0].id);
  const e2Id = Number(e2.rows[0].id);

  const o3 = await createOffering(token, b2Id, session2026Id, secondSemesterId);
  assert.equal(o3.status, 201);
  offeringId3 = Number(((await o3.json()) as { data: { id: number } }).data.id);

  const o4 = await createOffering(token, courseA1Id, session2026Id, secondSemesterId);
  assert.equal(o4.status, 201);
  offeringId4 = Number(((await o4.json()) as { data: { id: number } }).data.id);

  const o5 = await createOffering(token, courseD1Id, session2026Id, firstSemesterId);
  assert.equal(o5.status, 201);

  const o6 = await createOffering(token, e2Id, session2026Id, firstSemesterId);
  assert.equal(o6.status, 201);
});

// ---------------------------------------------------------------------------
// Listing / filtering
// ---------------------------------------------------------------------------

test("offerings are ordered by academic session, semester, then course code", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?facultyId=${fac1Id}`);
  const ours = data.map((o) => [
    o.academicSessionName,
    o.semesterName,
    o.courseCode,
  ]);

  assert.deepEqual(ours, [
    ["ADMCOF-2026", "First Semester", "ADMCOF-A1"],
    ["ADMCOF-2026", "First Semester", "ADMCOF-D1"],
    ["ADMCOF-2026", "Second Semester", "ADMCOF-A1"],
    ["ADMCOF-2026", "Second Semester", "ADMCOF-B2"],
    ["ADMCOF-2027", "First Semester", "ADMCOF-A1"],
  ]);
});

test("offerings can be filtered by course", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?courseId=${courseA1Id}`);
  const codes = data.map((o) => o.courseCode);
  assert.deepEqual(codes, ["ADMCOF-A1", "ADMCOF-A1", "ADMCOF-A1"]);
});

test("offerings can be filtered by academic session", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?academicSessionId=${session2026Id}`);
  const sessions = new Set(data.map((o) => o.academicSessionId));
  assert.ok(data.length >= 4);
  assert.deepEqual(Array.from(sessions), [session2026Id]);
});

test("offerings can be filtered by semester", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?semesterId=${firstSemesterId}`);
  const semesters = new Set(data.map((o) => o.semesterId));
  assert.ok(data.length >= 3);
  assert.deepEqual(Array.from(semesters), [firstSemesterId]);
});

test("offerings can be filtered by status", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?status=OPEN`);
  assert.ok(data.every((o) => o.status === "OPEN"));
});

test("offerings can be filtered by faculty using ownership relationships", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?facultyId=${fac2Id}`);
  const codes = data.map((o) => o.courseCode);
  assert.ok(codes.includes("ADMCOF-E2"), "department-specific course in fac2 included");
  assert.ok(!codes.includes("ADMCOF-B2"), "department-specific course in fac1 excluded");
  assert.ok(!codes.includes("ADMCOF-A1"), "faculty-wide course in fac1 excluded");
});

test("offerings can be filtered by department", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?departmentId=${dep1Id}`);
  const codes = data.map((o) => o.courseCode);
  assert.deepEqual(codes, ["ADMCOF-B2"]);
});

test("offerings can be filtered by level", async () => {
  const token = await adminToken();
  const data = await offeringsList(token, `?levelId=${level100Id}`);
  const codes = data.map((o) => o.courseCode);
  assert.ok(codes.includes("ADMCOF-A1"));
  assert.ok(!codes.includes("ADMCOF-B2"));
  assert.ok(!codes.includes("ADMCOF-D1"));
});

test("invalid offering filters are rejected with 400", async () => {
  const token = await adminToken();
  const badStatus = await get("/api/admin/course-offerings?status=BOGUS", cookieHeader(token));
  assert.equal(badStatus.status, 400);
  assertInvalidRequest(await badStatus.json());
  const badLevel = await get("/api/admin/course-offerings?levelId=abc", cookieHeader(token));
  assert.equal(badLevel.status, 400);
  assertInvalidRequest(await badLevel.json());
});

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

test("admin can close an offering", async () => {
  const token = await adminToken();
  const res = await patchJson(
    `/api/admin/course-offerings/${offeringId4}`,
    { status: "CLOSED" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "CLOSED");
});

test("identity changes are allowed when the offering has no dependents", async () => {
  const token = await adminToken();
  const e2 = await pool.query(`SELECT id FROM courses WHERE course_code = 'ADMCOF-E2'`);
  const e2Id = Number(e2.rows[0].id);

  const created = await createOffering(token, e2Id, session2027Id, firstSemesterId);
  assert.equal(created.status, 201);
  const o7 = Number(((await created.json()) as { data: { id: number } }).data.id);

  const moveCourse = await patchJson(
    `/api/admin/course-offerings/${o7}`,
    { courseId: courseD1Id },
    cookieHeader(token)
  );
  assert.equal(moveCourse.status, 200);
  const moveBody = (await moveCourse.json()) as { data: Record<string, unknown> };
  assert.equal(moveBody.data.courseId, courseD1Id);

  const moveSemester = await patchJson(
    `/api/admin/course-offerings/${o7}`,
    { semesterId: secondSemesterId },
    cookieHeader(token)
  );
  assert.equal(moveSemester.status, 200);
  const semBody = (await moveSemester.json()) as { data: Record<string, unknown> };
  assert.equal(semBody.data.semesterId, secondSemesterId);

  const moveSession = await patchJson(
    `/api/admin/course-offerings/${o7}`,
    { academicSessionId: session2026Id },
    cookieHeader(token)
  );
  assert.equal(moveSession.status, 200);
  const sessBody = (await moveSession.json()) as { data: Record<string, unknown> };
  assert.equal(sessBody.data.academicSessionId, session2026Id);
  assert.equal(sessBody.data.courseId, courseD1Id);
});

test("identity changes are rejected when registrations exist", async () => {
  const token = await adminToken();
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id)
     VALUES ($1, $2)`,
    [studentProfileId, offeringId1]
  );

  const res = await patchJson(
    `/api/admin/course-offerings/${offeringId1}`,
    { semesterId: secondSemesterId },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "HAS_REGISTRATIONS");
});

test("status changes remain possible when registrations exist", async () => {
  const token = await adminToken();
  const res = await patchJson(
    `/api/admin/course-offerings/${offeringId1}`,
    { status: "CLOSED" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "CLOSED");
});

test("identity changes are rejected when attendance records exist", async () => {
  const token = await adminToken();
  const network = await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ('ADMCOF-NET', 'Offering Test Network') RETURNING id`
  );
  const location = await pool.query(
    `INSERT INTO locations (name) VALUES ('Offering Test Location') RETURNING id`
  );
  const session = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id, location_id,
        start_time, end_time, status)
     VALUES ($1, $2, $3, $4, now() - interval '1 hour', now(), 'ENDED')
     RETURNING id`,
    [
      offeringId2,
      lecturer1ProfileId,
      Number(network.rows[0].id),
      Number(location.rows[0].id),
    ]
  );
  const sessionId = Number(session.rows[0].id);
  await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status)
     VALUES ($1, $2, 'PRESENT')`,
    [sessionId, studentProfileId]
  );

  const res = await patchJson(
    `/api/admin/course-offerings/${offeringId2}`,
    { courseId: courseD1Id },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "HAS_ATTENDANCE");

  const statusRes = await patchJson(
    `/api/admin/course-offerings/${offeringId2}`,
    { status: "CLOSED" },
    cookieHeader(token)
  );
  assert.equal(statusRes.status, 200);
});

test("update validation rejects malformed payloads", async () => {
  const token = await adminToken();
  const res = await patchJson(
    `/api/admin/course-offerings/${offeringId3}`,
    { status: "BOGUS" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("updating a nonexistent offering returns 404", async () => {
  const token = await adminToken();
  const res = await patchJson(
    "/api/admin/course-offerings/999999",
    { status: "CLOSED" },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "NOT_FOUND");
});

test("there is no DELETE endpoint for offerings", async () => {
  const token = await adminToken();
  const res = await deleteVia(`/api/admin/course-offerings/${offeringId3}`, cookieHeader(token));
  assert.equal(res.status, 404);
  const data = await offeringsList(token, `?courseId=${courseA1Id}`);
  assert.ok(data.length >= 2);
});

// ---------------------------------------------------------------------------
// Lecturer assignment
// ---------------------------------------------------------------------------

test("an admin can assign a lecturer to an offering", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: lecturer1ProfileId },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.id, lecturer1ProfileId);
  assert.equal(body.data.userId, lecturer1UserId);
  assert.equal(body.data.staffId, LECTURER_1_STAFF_ID);
  assert.equal(typeof body.data.name, "string");
  assert.equal(typeof body.data.assignedAt, "string");
});

test("multiple lecturers can be assigned to the same offering", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: lecturer2ProfileId },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);

  const listRes = await get(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    cookieHeader(token)
  );
  assert.equal(listRes.status, 200);
  const body = (await listRes.json()) as { data: Array<Record<string, unknown>> };
  const ids = body.data.map((l) => l.id).sort();
  assert.deepEqual(ids, [lecturer1ProfileId, lecturer2ProfileId].sort());
});

test("duplicate lecturer assignment is rejected", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: lecturer1ProfileId },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "ALREADY_ASSIGNED");
});

test("assigning a nonexistent lecturer returns 404", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: 999999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "LECTURER_NOT_FOUND");
});

test("assigning an inactive lecturer is rejected", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: inactiveLecturerProfileId },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "LECTURER_NOT_ACTIVE");
});

test("assigning a user that is not a lecturer is rejected", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: nonLecturerProfileId },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertErrorCode(await res.json(), "NOT_A_LECTURER");
});

test("assigning to a nonexistent offering returns 404", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/course-offerings/999999/lecturers",
    { lecturerId: lecturer1ProfileId },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "NOT_FOUND");
});

test("assigned lecturers are listed with profile information", async () => {
  const token = await adminToken();
  const listRes = await get(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    cookieHeader(token)
  );
  assert.equal(listRes.status, 200);
  const body = (await listRes.json()) as { data: Array<Record<string, unknown>> };
  const lecturer1 = body.data.find((l) => l.id === lecturer1ProfileId);
  assert.ok(lecturer1);
  assert.equal(lecturer1!.userId, lecturer1UserId);
  assert.equal(lecturer1!.staffId, LECTURER_1_STAFF_ID);
  assert.equal(typeof lecturer1!.name, "string");
  assert.equal(typeof lecturer1!.assignedAt, "string");
});

test("a lecturer can teach multiple offerings", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId3}/lecturers`,
    { lecturerId: lecturer2ProfileId },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);

  const listRes = await get(
    `/api/admin/course-offerings/${offeringId3}/lecturers`,
    cookieHeader(token)
  );
  const body = (await listRes.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.some((l) => l.id === lecturer2ProfileId));
});

test("an assignment can be removed without deleting the lecturer or offering", async () => {
  const token = await adminToken();
  const del = await deleteVia(
    `/api/admin/course-offerings/${offeringId1}/lecturers/${lecturer1ProfileId}`,
    cookieHeader(token)
  );
  assert.equal(del.status, 204);

  const listRes = await get(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    cookieHeader(token)
  );
  const body = (await listRes.json()) as { data: Array<Record<string, unknown>> };
  assert.deepEqual(body.data.map((l) => l.id), [lecturer2ProfileId]);

  const offeringList = await offeringsList(token, `?courseId=${courseA1Id}`);
  assert.ok(byCourse(offeringList, "ADMCOF-A1"), "offering must still exist");

  const reassign = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: lecturer1ProfileId },
    cookieHeader(token)
  );
  assert.equal(reassign.status, 201, "lecturer must still exist and be assignable");
});

test("removing an unassigned relationship returns 404", async () => {
  const token = await adminToken();
  const del = await deleteVia(
    `/api/admin/course-offerings/${offeringId2}/lecturers/${lecturer1ProfileId}`,
    cookieHeader(token)
  );
  assert.equal(del.status, 404);
  assertErrorCode(await del.json(), "NOT_ASSIGNED");
});

test("removing a lecturer from a nonexistent offering returns 404", async () => {
  const token = await adminToken();
  const del = await deleteVia(
    "/api/admin/course-offerings/999999/lecturers/999999",
    cookieHeader(token)
  );
  assert.equal(del.status, 404);
});

test("invalid lecturer assignment payloads are rejected", async () => {
  const token = await adminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    { lecturerId: "abc" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

// ---------------------------------------------------------------------------
// Data integrity
// ---------------------------------------------------------------------------

test("the database still rejects an offering whose course does not exist", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
       VALUES (999999, $1, $2)`,
      [session2026Id, firstSemesterId]
    ),
    rejectsWith(/violates foreign key constraint/)
  );
});

test("a course with offerings cannot be deleted", async () => {
  await assert.rejects(
    pool.query(`DELETE FROM courses WHERE id = $1`, [courseA1Id]),
    rejectsWith(/RESTRICT/)
  );
});

test("closing an offering preserves registrations and the offering row", async () => {
  const token = await adminToken();
  const regs = await pool.query(
    `SELECT id FROM course_registrations WHERE course_offering_id = $1`,
    [offeringId1]
  );
  assert.ok(regs.rows.length >= 1, "registration from earlier test must still exist");

  const res = await patchJson(
    `/api/admin/course-offerings/${offeringId1}`,
    { status: "CLOSED" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);

  const data = await offeringsList(token, `?courseId=${courseA1Id}&status=CLOSED`);
  const closed = data.filter((o) => Number(o.id) === offeringId1);
  assert.ok(closed.length === 1, "closed offering must still be listed");

  const stillRegs = await pool.query(
    `SELECT id FROM course_registrations WHERE course_offering_id = $1`,
    [offeringId1]
  );
  assert.equal(stillRegs.rows.length, regs.rows.length);
});

test("closing an offering preserves attendance history", async () => {
  const records = await pool.query(
    `SELECT ar.id
     FROM attendance_records ar
     JOIN attendance_sessions sess ON sess.id = ar.session_id
     WHERE sess.course_offering_id = $1`,
    [offeringId2]
  );
  assert.ok(records.rows.length >= 1, "attendance record from earlier test must still exist");

  const after = await pool.query(
    `SELECT ar.id
     FROM attendance_records ar
     JOIN attendance_sessions sess ON sess.id = ar.session_id
     WHERE sess.course_offering_id = $1`,
    [offeringId2]
  );
  assert.equal(after.rows.length, records.rows.length);
});

test("assignments to a closed offering remain listed", async () => {
  const token = await adminToken();
  const listRes = await get(
    `/api/admin/course-offerings/${offeringId1}/lecturers`,
    cookieHeader(token)
  );
  assert.equal(listRes.status, 200);
  const body = (await listRes.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(body.data.length >= 1);
});

function rejectsWith(pattern: RegExp) {
  return (error: unknown) => pattern.test((error as Error).message);
}