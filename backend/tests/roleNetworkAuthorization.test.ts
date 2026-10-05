import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { boundDeviceHeaders } from "./studentSessionTestHelpers";

/**
 * The student-only deployment policy must never turn into a role restriction.
 *
 * Students are served by the K12 edge alone (STUDENT_ACCESS_MODE, see
 * config/access.ts). That policy keys on the deployment, never on the caller's
 * role or address, so this suite pins the two halves that could plausibly leak:
 *
 *   1. LECTURER and ADMIN reach their own portals from an ordinary internet
 *      connection. The test server binds to loopback and every request here
 *      arrives from 127.0.0.1, which is not the campus network, and both roles
 *      must still be served normally.
 *   2. The policy does not become a substitute for role checks. A lecturer still
 *      cannot read the student API and a student still cannot read the lecturer
 *      API, with the same FORBIDDEN the app returned before the policy existed.
 *
 * Cloud-mode behaviour (students refused, staff served) is asserted in
 * studentAccessPolicy.test.ts, which mounts the app in both modes. This file runs
 * as the edge, because it needs a real student session to make the second half
 * meaningful.
 *
 * The suite previously covered admin CRUD for attendance networks and locations.
 * Those endpoints and their tables are gone (migrations 017 and 018): a session no
 * longer records a network or a location, so there was nothing left for an admin to
 * configure. Role separation is now pinned against the configuration endpoints that
 * remain - courses and students - which is the same authorization path.
 */

const TEST_PASSWORD = "role-network-authorization-test-password";
const ADMIN_USERNAME = "netauth_admin";
const STUDENT_MATRIC = "NETAUTH/STU";
const LECTURER_STAFF_ID = "NETAUTH/LEC";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturerUserId = 0;

function userIds(): number[] {
  return [adminUserId, studentUserId, lecturerUserId];
}

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

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

async function cleanupScopedData(): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    userIds(),
  ]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
    userIds(),
  ]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [
    userIds(),
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [
    userIds(),
  ]);
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'NETAUTH%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'NETAUTH%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'NETAUTH%'`);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Role Auth Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Role Auth Faculty', 'NETAUTH-FAC') RETURNING id`
  );
  const facultyId = Number(faculty.rows[0].id);

  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Role Auth Department', 'NETAUTH-DEP', $1) RETURNING id`,
    [facultyId]
  );
  const departmentId = Number(department.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  const levelId = Number(level.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Role Auth Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [studentUserId, STUDENT_MATRIC, departmentId, levelId]
  );

  const lecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Role Auth Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturerUserId, LECTURER_STAFF_ID, departmentId]
  );

  // This file's suites run against the K12 edge (the test runner sets
  // STUDENT_ACCESS_MODE=edge), the only deployment that serves students, so role
  // routing is what refuses the lecturer here. Cloud-mode behaviour is asserted in
  // studentAccessPolicy.test.ts.
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

async function studentToken(): Promise<string> {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  }, await boundDeviceHeaders(STUDENT_MATRIC));
  assert.equal(login.status, 200);
  const token = cookieFrom(login);
  assert.ok(token, "student login should issue a session cookie");
  return token;
}

async function lecturerToken(): Promise<string> {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
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

// ---------------------------------------------------------------------------
// Students and lecturers may not administer configuration
// ---------------------------------------------------------------------------

test("a student cannot list or create courses", async () => {
  const token = await studentToken();

  const list = await get("/api/admin/courses", cookieHeader(token));
  assert.equal(list.status, 403);
  assertErrorCode(await list.json(), "FORBIDDEN");

  const create = await postJson(
    "/api/admin/courses",
    { courseCode: "NETAUTH-S1", title: "Student Attempt" },
    cookieHeader(token)
  );
  assert.equal(create.status, 403);
  assertErrorCode(await create.json(), "FORBIDDEN");
});

test("a student cannot list or create locations, because the endpoints are gone", async () => {
  // The attendance location API and its table were removed with the rest of the
  // network/location metadata (migrations 017 and 018). The route must not reappear
  // in any form, so this asserts a 404 rather than a 403.
  const token = await studentToken();
  const res = await get("/api/admin/locations", cookieHeader(token));
  assert.equal(res.status, 404);

  const networks = await get("/api/admin/attendance-networks", cookieHeader(token));
  assert.equal(networks.status, 404);
});

test("a lecturer cannot list or create courses", async () => {
  const token = await lecturerToken();

  const list = await get("/api/admin/courses", cookieHeader(token));
  assert.equal(list.status, 403);
  assertErrorCode(await list.json(), "FORBIDDEN");

  const create = await postJson(
    "/api/admin/courses",
    { courseCode: "NETAUTH-L1", title: "Lecturer Attempt" },
    cookieHeader(token)
  );
  assert.equal(create.status, 403);
  assertErrorCode(await create.json(), "FORBIDDEN");
});

test("a rejected non-admin request must not mutate the configuration", async () => {
  const admin = await adminToken();
  const created = await postJson(
    "/api/admin/courses",
    { courseCode: "NETAUTH-C1", title: "Admin Course" },
    cookieHeader(admin)
  );
  assert.equal(created.status, 201);
  const { data: course } = (await created.json()) as { data: { id: number } };

  const token = await lecturerToken();
  const res = await patchJson(
    `/api/admin/courses/${course.id}`,
    { title: "Lecturer Rename Attempt" },
    cookieHeader(token)
  );
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");

  const unchanged = await get("/api/admin/courses", cookieHeader(admin));
  const list = (await unchanged.json()) as { data: Array<{ id: number; title: string }> };
  assert.equal(
    list.data.find((c) => c.id === course.id)?.title,
    "Admin Course",
    "a rejected lecturer request must not mutate the course"
  );
});

// ---------------------------------------------------------------------------
// Only ADMIN administers the configuration
// ---------------------------------------------------------------------------

test("an admin can create and rename a course", async () => {
  const token = await adminToken();

  const created = await postJson(
    "/api/admin/courses",
    { courseCode: "NETAUTH-A1", title: "Admin Course" },
    cookieHeader(token)
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { data: Record<string, unknown> };
  assert.equal(createdBody.data.courseCode, "NETAUTH-A1");
  const courseId = createdBody.data.id as number;

  const renamed = await patchJson(
    `/api/admin/courses/${courseId}`,
    { title: "Admin Course Renamed" },
    cookieHeader(token)
  );
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).data.title, "Admin Course Renamed");
});

// ---------------------------------------------------------------------------
// The student-only deployment policy must never reach LECTURER or ADMIN
// ---------------------------------------------------------------------------

test("a lecturer reaches the lecturer portal over a non-campus connection", async () => {
  // Requests arrive from 127.0.0.1, which is not the campus network. The
  // student-only policy must not apply here.
  const token = await lecturerToken();

  const offerings = await get("/api/lecturer/course-offerings", cookieHeader(token));
  assert.equal(offering.status, 200, "lecturer must not be blocked by the student policy");
  assert.ok(Array.isArray((await offerings.json()).data));

  const sessions = await get("/api/lecturer/attendance-sessions", cookieHeader(token));
  assert.equal(sessions.status, 200, "lecturer must not be blocked by the student policy");
});

test("an admin reaches the admin portal over a non-campus connection", async () => {
  const token = await adminToken();

  const courses = await get("/api/admin/courses", cookieHeader(token));
  assert.equal(courses.status, 200, "admin must not be blocked by the student policy");

  const students = await get("/api/admin/students", cookieHeader(token));
  assert.equal(students.status, 200, "admin must not be blocked by the student policy");
});

test("the student policy does not leak into role routing", async () => {
  // A lecturer must not be able to reach a student-only route, and a student
  // must not be able to reach a lecturer-only route. The restriction under
  // test is role-based, not deployment-based.
  const lecturer = await lecturerToken();
  const studentRoutes = await get("/api/student/attendance/eligible", cookieHeader(lecturer));
  assert.equal(studentRoutes.status, 403);
  // Role routing, not deployment routing: on the edge the role check is what
  // refuses the lecturer, exactly as before.
  assertErrorCode(await studentRoutes.json(), "FORBIDDEN");

  const student = await studentToken();
  const lecturerRoutes = await get("/api/lecturer/course-offerings", cookieHeader(student));
  assert.equal(lecturerRoutes.status, 403);
  assertErrorCode(await lecturerRoutes.json(), "FORBIDDEN");
});
