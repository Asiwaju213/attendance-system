import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-course-test-password";
const ADMIN_USERNAME = "admin_crs_admin";
const STUDENT_MATRIC = "AUTH/CRS/STU";
const LECTURER_STAFF_ID = "AUTH/CRS/LEC";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let fac1Id = 0;
let fac2Id = 0;
let dep1Id = 0;
let dep2Id = 0;
let level100Id = 0;
let level200Id = 0;
let level300Id = 0;
let level500Id = 0;

let adminUserId = 0;
let studentUserId = 0;
let lecturerUserId = 0;

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

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

function userIds(): number[] {
  return [adminUserId, studentUserId, lecturerUserId];
}

function rejectsWith(pattern: RegExp) {
  return (error: unknown) => pattern.test((error as Error).message);
}

before(async () => {
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMCRS%')
        OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ADMCRS%')`
  );
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMCRS%'`);
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ADMCRS%'`);
  await pool.query(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT user_id FROM students WHERE matric_number = ANY($1::TEXT[])
       UNION
       SELECT user_id FROM lecturers WHERE staff_id = ANY($1::TEXT[])
       UNION
       SELECT id FROM users WHERE username = $2
     )`,
    [[STUDENT_MATRIC, LECTURER_STAFF_ID], ADMIN_USERNAME]
  );
  await pool.query(`DELETE FROM students WHERE matric_number = $1`, [STUDENT_MATRIC]);
  await pool.query(`DELETE FROM lecturers WHERE staff_id = $1`, [LECTURER_STAFF_ID]);
  await pool.query(
    `DELETE FROM users
     WHERE username = $1
        OR id IN (
          SELECT user_id FROM students WHERE matric_number = $2
          UNION
          SELECT user_id FROM lecturers WHERE staff_id = $3
        )`,
    [ADMIN_USERNAME, STUDENT_MATRIC, LECTURER_STAFF_ID]
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMCRS%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMCRS%'`);

  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Course Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac1 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Course Test A', 'ADMCRS-FAC') RETURNING id`
  );
  fac1Id = Number(fac1.rows[0].id);

  const fac2 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Course Test B', 'ADMCRS-FAC2') RETURNING id`
  );
  fac2Id = Number(fac2.rows[0].id);

  const dep1 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ('Course Test Department A', 'ADMCRS-DEP', $1) RETURNING id`,
    [fac1Id]
  );
  dep1Id = Number(dep1.rows[0].id);

  const dep2 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ('Course Test Department B', 'ADMCRS-DEP2', $1) RETURNING id`,
    [fac2Id]
  );
  dep2Id = Number(dep2.rows[0].id);

  const levelRes = await pool.query(`SELECT id, name FROM levels WHERE name IN (100, 200, 300, 500)`);
  const levelIds = new Map<number, number>();
  for (const row of levelRes.rows) {
    levelIds.set(Number(row.name), Number(row.id));
  }
  level100Id = levelIds.get(100)!;
  level200Id = levelIds.get(200)!;
  level300Id = levelIds.get(300)!;
  level500Id = levelIds.get(500)!;

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Course Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [studentUserId, STUDENT_MATRIC, dep1Id, level100Id]
  );

  const lecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Course Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturerUserId, LECTURER_STAFF_ID, dep1Id]
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

  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    userIds(),
  ]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
    userIds(),
  ]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [
    userIds(),
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds()]);
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ADMCRS%')
        OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ADMCRS%')`
  );
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMCRS%'`);
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'ADMCRS%'`);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMCRS%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMCRS%'`);
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

async function coursesList(
  token: string,
  query = ""
): Promise<Array<Record<string, unknown>>> {
  const res = await get("/api/admin/courses" + query, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

function byCode(list: Array<Record<string, unknown>>, code: string): Record<string, unknown> | undefined {
  return list.find((c) => c.courseCode === code);
}

function assertInvalidRequest(body: unknown): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, "INVALID_REQUEST");
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

test("course endpoints require authentication", async () => {
  const res = await get("/api/admin/courses");
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("course endpoints reject students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/courses", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("course endpoints reject lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/courses", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("admin can list courses", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/courses", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown };
  assert.ok(Array.isArray(body.data));
});

test("admin can create a faculty-wide course", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    { courseCode: " admcrs-c1 ", title: "  Course One  ", levelId: level100Id, facultyId: fac1Id },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.courseCode, "ADMCRS-C1");
  assert.equal(body.data.title, "Course One");
  assert.equal(body.data.levelId, level100Id);
  assert.equal(body.data.levelName, 100);
  assert.equal(body.data.scope, "FACULTY");
  assert.equal(body.data.facultyId, fac1Id);
  assert.equal(typeof body.data.facultyName, "string");
  assert.equal(body.data.departmentId, null);
  assert.equal(body.data.departmentName, null);
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(typeof body.data.createdAt, "string");
  assert.equal(typeof body.data.updatedAt, "string");
});

test("admin can create a department-specific course", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-C2", title: "Course Two", levelId: level200Id, departmentId: dep1Id },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.courseCode, "ADMCRS-C2");
  assert.equal(body.data.scope, "DEPARTMENT");
  assert.equal(body.data.departmentId, dep1Id);
  assert.equal(typeof body.data.departmentName, "string");
  assert.equal(body.data.facultyId, fac1Id, "faculty must be derived from the department");
  assert.equal(typeof body.data.facultyName, "string");
});

test("duplicate course codes are rejected with 409", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-C1", title: "Duplicate", levelId: level200Id, facultyId: fac1Id },
    cookieHeader(token)
  );

  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "CONFLICT");
});

test("creating a course for a nonexistent faculty returns 404", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-NOFAC", title: "No Faculty", levelId: level100Id, facultyId: 999999 },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "FACULTY_NOT_FOUND");
});

test("creating a course for a nonexistent department returns 404", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-NODEP", title: "No Department", levelId: level100Id, departmentId: 999999 },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "DEPARTMENT_NOT_FOUND");
});

test("creating a course for a nonexistent level returns 404", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-NOLVL", title: "No Level", levelId: 600, facultyId: fac1Id },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "LEVEL_NOT_FOUND");
});

test("creating a course with both facultyId and departmentId is rejected", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    {
      courseCode: "ADMCRS-BOTH",
      title: "Both Owners",
      levelId: level100Id,
      facultyId: fac1Id,
      departmentId: dep1Id,
    },
    cookieHeader(token)
  );

  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("creating a course with neither owner is rejected", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-NONE", title: "No Owners", levelId: 100 },
    cookieHeader(token)
  );

  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("invalid course create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const noTitle = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-NOTITLE", levelId: level100Id, facultyId: fac1Id },
    cookieHeader(token)
  );
  assert.equal(noTitle.status, 400);
  assertInvalidRequest(await noTitle.json());

  const longCode = await postJson(
    "/api/admin/courses",
    { courseCode: "x".repeat(33), title: "Long Code", levelId: level100Id, facultyId: fac1Id },
    cookieHeader(token)
  );
  assert.equal(longCode.status, 400);
  assertInvalidRequest(await longCode.json());

  const badLevel = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-BADLVL", title: "Bad Level", levelId: "abc", facultyId: fac1Id },
    cookieHeader(token)
  );
  assert.equal(badLevel.status, 400);
  assertInvalidRequest(await badLevel.json());

  const stringFaculty = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-STRFAC", title: "String Faculty", levelId: level100Id, facultyId: "5" },
    cookieHeader(token)
  );
  assert.equal(stringFaculty.status, 400);
  assertInvalidRequest(await stringFaculty.json());
});

test("client-supplied status cannot create an inactive course", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/courses",
    {
      courseCode: "ADMCRS-C3",
      title: "Course Three",
      levelId: level100Id,
      facultyId: fac1Id,
      status: "INACTIVE",
    },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "ACTIVE", "client-supplied status must be ignored");
});

test("list returns courses ordered by level then course code", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/courses",
    { courseCode: "ADMCRS-C4", title: "Course Four", levelId: level500Id, facultyId: fac2Id },
    cookieHeader(token)
  );
  assert.equal(created.status, 201);

  const data = await coursesList(token);
  const ours = data
    .filter((c) => typeof c.courseCode === "string" && (c.courseCode as string).startsWith("ADMCRS"))
    .map((c) => c.courseCode as string);

  assert.deepEqual(ours, ["ADMCRS-C1", "ADMCRS-C3", "ADMCRS-C2", "ADMCRS-C4"]);
});

test("a faculty-wide course returns faculty information", async () => {
  const token = await adminToken();
  const data = await coursesList(token);
  const c1 = byCode(data, "ADMCRS-C1");
  assert.ok(c1);
  assert.equal(c1!.scope, "FACULTY");
  assert.equal(c1!.facultyId, fac1Id);
  assert.equal(typeof c1!.facultyName, "string");
  assert.equal(c1!.departmentId, null);
  assert.equal(c1!.departmentName, null);
});

test("a department-specific course returns department and faculty information", async () => {
  const token = await adminToken();
  const data = await coursesList(token);
  const c2 = byCode(data, "ADMCRS-C2");
  assert.ok(c2);
  assert.equal(c2!.scope, "DEPARTMENT");
  assert.equal(c2!.departmentId, dep1Id);
  assert.equal(typeof c2!.departmentName, "string");
  assert.equal(c2!.facultyId, fac1Id, "faculty must come from the department");
  assert.equal(typeof c2!.facultyName, "string");
});

test("courses can be filtered by faculty", async () => {
  const token = await adminToken();
  const data = await coursesList(token, `?facultyId=${fac1Id}`);
  const codes = data.map((c) => c.courseCode);

  assert.ok(codes.includes("ADMCRS-C1"), "faculty-wide course of the faculty");
  assert.ok(
    codes.includes("ADMCRS-C2"),
    "department-specific course whose department belongs to the faculty"
  );
  assert.ok(codes.includes("ADMCRS-C3"));
  assert.ok(!codes.includes("ADMCRS-C4"), "other faculty must be excluded");

  const fac2Data = await coursesList(token, `?facultyId=${fac2Id}`);
  const fac2Codes = fac2Data.map((c) => c.courseCode);
  assert.ok(fac2Codes.includes("ADMCRS-C4"));
  assert.ok(!fac2Codes.includes("ADMCRS-C1"));
});

test("courses can be filtered by department", async () => {
  const token = await adminToken();
  const data = await coursesList(token, `?departmentId=${dep1Id}`);
  const codes = data.map((c) => c.courseCode);

  assert.ok(codes.includes("ADMCRS-C2"));
  assert.ok(!codes.includes("ADMCRS-C1"), "faculty-wide courses have no department");
  assert.ok(!codes.includes("ADMCRS-C3"));
});

test("courses can be filtered by level", async () => {
  const token = await adminToken();
  const data = await coursesList(token, `?levelId=${level100Id}`);
  const codes = data.map((c) => c.courseCode);

  assert.ok(codes.includes("ADMCRS-C1"));
  assert.ok(codes.includes("ADMCRS-C3"));
  assert.ok(!codes.includes("ADMCRS-C2"), `level 200 course must be excluded`);
  assert.ok(!codes.includes("ADMCRS-C4"), `level 500 course must be excluded`);
});

test("invalid course filters are rejected with 400", async () => {
  const token = await adminToken();

  const badLevel = await get("/api/admin/courses?levelId=abc", cookieHeader(token));
  assert.equal(badLevel.status, 400);
  assertInvalidRequest(await badLevel.json());

  const badStatus = await get("/api/admin/courses?status=BOGUS", cookieHeader(token));
  assert.equal(badStatus.status, 400);
  assertInvalidRequest(await badStatus.json());

  const badFaculty = await get("/api/admin/courses?facultyId=-1", cookieHeader(token));
  assert.equal(badFaculty.status, 400);
  assertInvalidRequest(await badFaculty.json());
});

test("admin can update a course title without touching ownership", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2");
  assert.ok(c2);

  const res = await patchJson(`/api/admin/courses/${c2!.id}`, { title: "Updated Title" }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.title, "Updated Title");
  assert.equal(body.data.scope, "DEPARTMENT");
  assert.equal(body.data.departmentId, dep1Id, "ownership must be unchanged");
});

test("admin can update a course code (uppercased and trimmed)", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2");
  assert.ok(c2);

  const res = await patchJson(`/api/admin/courses/${c2!.id}`, { courseCode: " admcrs-c2x " }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.courseCode, "ADMCRS-C2X");
});

test("admin can update a course level", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2X");
  assert.ok(c2);

  const res = await patchJson(`/api/admin/courses/${c2!.id}`, { levelId: level300Id }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.levelId, level300Id);
  assert.equal(body.data.levelName, 300);
});

test("admin can move a faculty-wide course to another faculty", async () => {
  const token = await adminToken();
  const c4 = byCode(await coursesList(token), "ADMCRS-C4");
  assert.ok(c4);
  assert.equal(c4!.facultyId, fac2Id, "precondition: belongs to the second faculty");

  const res = await patchJson(`/api/admin/courses/${c4!.id}`, { facultyId: fac1Id }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.scope, "FACULTY");
  assert.equal(body.data.facultyId, fac1Id);
  assert.equal(body.data.departmentId, null);
});

test("admin can move a department-specific course to another department", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2X");
  assert.ok(c2);

  const res = await patchJson(`/api/admin/courses/${c2!.id}`, { departmentId: dep2Id }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.scope, "DEPARTMENT");
  assert.equal(body.data.departmentId, dep2Id);
  assert.equal(body.data.facultyId, fac2Id, "faculty must now come from the new department");
});

test("admin can change a faculty-wide course to department-specific", async () => {
  const token = await adminToken();
  const c1 = byCode(await coursesList(token), "ADMCRS-C1");
  assert.ok(c1);
  assert.equal(c1!.scope, "FACULTY", "precondition: faculty-wide");

  const res = await patchJson(`/api/admin/courses/${c1!.id}`, { departmentId: dep1Id }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.scope, "DEPARTMENT");
  assert.equal(body.data.departmentId, dep1Id);
  assert.equal(body.data.facultyId, fac1Id);
});

test("admin can change a department-specific course to faculty-wide", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2X");
  assert.ok(c2);
  assert.equal(c2!.scope, "DEPARTMENT", "precondition: department-specific");

  const res = await patchJson(`/api/admin/courses/${c2!.id}`, { facultyId: fac1Id }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.scope, "FACULTY");
  assert.equal(body.data.facultyId, fac1Id);
  assert.equal(body.data.departmentId, null);
});

test("updating with both owners is rejected", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2X");
  assert.ok(c2);

  const res = await patchJson(
    `/api/admin/courses/${c2!.id}`,
    { facultyId: fac1Id, departmentId: dep1Id },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());
});

test("updating a course to a used code returns 409", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2X");
  assert.ok(c2);

  const res = await patchJson(`/api/admin/courses/${c2!.id}`, { courseCode: "ADMCRS-C1" }, cookieHeader(token));
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "CONFLICT");
});

test("deactivating a course does not delete it", async () => {
  const token = await adminToken();
  const c1 = byCode(await coursesList(token), "ADMCRS-C1");
  assert.ok(c1);

  const res = await patchJson(`/api/admin/courses/${c1!.id}`, { status: "INACTIVE" }, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "INACTIVE");
  assert.equal(body.data.id, c1!.id, "id must remain stable");

  const after = await pool.query(
    `SELECT COUNT(*)::int AS count FROM courses WHERE course_code = 'ADMCRS-C1'`
  );
  assert.equal(after.rows[0].count, 1, "the course row must not be deleted");

  const inactiveData = await coursesList(token, "?status=INACTIVE");
  const inactiveCodes = inactiveData.map((c) => c.courseCode);
  assert.ok(inactiveCodes.includes("ADMCRS-C1"));
  assert.ok(!inactiveCodes.includes("ADMCRS-C2X"));
  assert.ok(!inactiveCodes.includes("ADMCRS-C3"));
  assert.ok(!inactiveCodes.includes("ADMCRS-C4"));

  const activeData = await coursesList(token, "?status=ACTIVE");
  const activeCodes = activeData.map((c) => c.courseCode);
  assert.ok(!activeCodes.includes("ADMCRS-C1"));
  assert.ok(activeCodes.includes("ADMCRS-C3"));
});

test("invalid course patch bodies are rejected", async () => {
  const token = await adminToken();
  const c2 = byCode(await coursesList(token), "ADMCRS-C2X");
  assert.ok(c2);
  const id = c2!.id;

  const empty = await patchJson(`/api/admin/courses/${id}`, {}, cookieHeader(token));
  assert.equal(empty.status, 400);
  assertInvalidRequest(await empty.json());

  const badStatus = await patchJson(`/api/admin/courses/${id}`, { status: "BOGUS" }, cookieHeader(token));
  assert.equal(badStatus.status, 400);
  assertInvalidRequest(await badStatus.json());

  const badId = await patchJson("/api/admin/courses/not-a-number", { title: "X" }, cookieHeader(token));
  assert.equal(badId.status, 400);
  assertInvalidRequest(await badId.json());

  const ghost = await patchJson("/api/admin/courses/999999", { title: "Ghost" }, cookieHeader(token));
  assert.equal(ghost.status, 404);
  assertErrorCode(await ghost.json(), "NOT_FOUND");

  const badLevel = await patchJson(`/api/admin/courses/${id}`, { levelId: 600 }, cookieHeader(token));
  assert.equal(badLevel.status, 404);
  assertErrorCode(await badLevel.json(), "LEVEL_NOT_FOUND");

  const badFaculty = await patchJson(`/api/admin/courses/${id}`, { facultyId: 999999 }, cookieHeader(token));
  assert.equal(badFaculty.status, 404);
  assertErrorCode(await badFaculty.json(), "FACULTY_NOT_FOUND");

  const badDepartment = await patchJson(`/api/admin/courses/${id}`, { departmentId: 999999 }, cookieHeader(token));
  assert.equal(badDepartment.status, 404);
  assertErrorCode(await badDepartment.json(), "DEPARTMENT_NOT_FOUND");
});

test("deactivating a course leaves offer/registration relationships intact", async () => {
  const c1 = await pool.query(`SELECT id FROM courses WHERE course_code = 'ADMCRS-C1'`);
  const c1Id = Number(c1.rows[0].id);

  const session = await pool.query(
    `INSERT INTO academic_sessions (name) VALUES ('ADMCRS-2026/2027') RETURNING id`
  );
  const sessionId = Number(session.rows[0].id);
  const semester = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  const semesterId = Number(semester.rows[0].id);

  try {
    const offering = await pool.query(
      `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [c1Id, sessionId, semesterId]
    );
    assert.ok(Number(offering.rows[0].id) > 0, "an INACTIVE course can still be offered");

    const registration = await pool.query(
      `SELECT COUNT(*)::int AS count FROM course_registrations WHERE course_offering_id = $1`,
      [Number(offering.rows[0].id)]
    );
    assert.equal(registration.rows[0].count, 0, "no registrations are injected by the API");
  } finally {
    await pool.query(`DELETE FROM course_offerings WHERE academic_session_id = $1`, [
      sessionId,
    ]);
    await pool.query(`DELETE FROM academic_sessions WHERE id = $1`, [sessionId]);
  }
});

test("database constraints remain effective: a faculty with courses cannot be deleted", async () => {
  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Course FK Faculty', 'ADMCRS-FAC3') RETURNING id`
  );
  const facultyId = Number(faculty.rows[0].id);
  const course = await pool.query(
    `INSERT INTO courses (course_code, title, level_id, faculty_id)
     VALUES ('ADMCRS-FKFAC', 'FK Faculty Course', $1, $2) RETURNING id`,
    [level100Id, facultyId]
  );
  const courseId = Number(course.rows[0].id);

  await assert.rejects(
    pool.query(`DELETE FROM faculties WHERE id = $1`, [facultyId]),
    rejectsWith(/foreign key constraint/)
  );

  await pool.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
  await pool.query(`DELETE FROM faculties WHERE id = $1`, [facultyId]);
});

test("database constraints remain effective: a department with courses cannot be deleted", async () => {
  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Course FK Department', 'ADMCRS-DEP3', $1) RETURNING id`,
    [fac1Id]
  );
  const departmentId = Number(department.rows[0].id);
  const course = await pool.query(
    `INSERT INTO courses (course_code, title, level_id, department_id)
     VALUES ('ADMCRS-FKDEP', 'FK Department Course', $1, $2) RETURNING id`,
    [level100Id, departmentId]
  );
  const courseId = Number(course.rows[0].id);

  await assert.rejects(
    pool.query(`DELETE FROM departments WHERE id = $1`, [departmentId]),
    rejectsWith(/foreign key constraint/)
  );

  await pool.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
  await pool.query(`DELETE FROM departments WHERE id = $1`, [departmentId]);
});

test("the database check constraint still enforces a single course owner", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO courses (course_code, title, level_id, faculty_id, department_id)
       VALUES ('ADMCRS-CHECK', 'Both Owners', $1, $2, $3)`,
      [level100Id, fac1Id, dep1Id]
    ),
    rejectsWith(/violates check constraint/)
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO courses (course_code, title, level_id)
       VALUES ('ADMCRS-CHECK2', 'No Owners', $1)`,
      [level100Id]
    ),
    rejectsWith(/violates check constraint/)
  );
});