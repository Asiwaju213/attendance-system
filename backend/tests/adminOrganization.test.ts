import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-org-test-password";
const ADMIN_USERNAME = "admin_org_admin";
const STUDENT_MATRIC = "AUTH/ADM/STU";
const LECTURER_STAFF_ID = "AUTH/ADM/LEC";

const FACULTY_A_CODE = "ADMORG-API1";
const FACULTY_B_CODE = "ADMORG-API3";
const DEPARTMENT_CODE = "ADMORG-DEP1";

let server: Server;
let baseUrl: string;
let passwordHash: string;
let profileFacultyId: number;
let profileDepartmentId: number;
let level100Id: number;

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

before(async () => {
  // Remove leftovers from a previously interrupted run (safe re-run).
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
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMORG%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMORG%'`);

  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Org Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Admin Org Base Faculty', 'ADMORGFAC')
     RETURNING id`
  );
  profileFacultyId = Number(faculty.rows[0].id);

  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Admin Org Base Department', 'ADMORGDEPT', $1)
     RETURNING id`,
    [profileFacultyId]
  );
  profileDepartmentId = Number(department.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Org Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [studentUserId, STUDENT_MATRIC, profileDepartmentId, level100Id]
  );

  const lecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Org Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturerUserId, LECTURER_STAFF_ID, profileDepartmentId]
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
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMORG%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMORG%'`);
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

function assertInvalidRequest(body: unknown): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, "INVALID_REQUEST");
}

function assertFaculty(faculty: Record<string, unknown>, code: string): void {
  assert.equal(typeof faculty.id, "number");
  assert.equal(typeof faculty.name, "string");
  assert.equal(faculty.code, code);
  assert.equal(faculty.status, "ACTIVE");
  assert.equal(typeof faculty.createdAt, "string");
  assert.equal(typeof faculty.updatedAt, "string");
}

test("admin endpoints require authentication", async () => {
  const res = await get("/api/admin/faculties");
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "UNAUTHENTICATED");
});

test("admin endpoints reject students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/faculties", cookieHeader(token!));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FORBIDDEN");
});

test("admin endpoints reject lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/faculties", cookieHeader(token!));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FORBIDDEN");
});

test("admin can list faculties", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/faculties", cookieHeader(token));

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(body.data));
  const base = body.data.find((f) => f.code === "ADMORGFAC");
  assert.ok(base, "list must include the seeded faculty");
  assert.equal(typeof base!.id, "number");
});

test("admin can create a faculty and the status is always ACTIVE", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/faculties",
    { name: "  Admin Org Api Faculty  ", code: " admorg-api1 ", status: "INACTIVE" },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assertFaculty(body.data, FACULTY_A_CODE);
  assert.equal(body.data.name, "Admin Org Api Faculty");
  assert.equal(body.data.status, "ACTIVE", "client-supplied status must be ignored");
});

test("duplicate faculty codes are rejected with 409", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/faculties",
    { name: "Duplicate Faculty", code: FACULTY_A_CODE },
    cookieHeader(token)
  );

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "CONFLICT");
});

test("invalid faculty create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const noCode = await postJson(
    "/api/admin/faculties",
    { name: "No Code" },
    cookieHeader(token)
  );
  assert.equal(noCode.status, 400);
  assertInvalidRequest(await noCode.json());

  const noName = await postJson(
    "/api/admin/faculties",
    { code: "ADMORG-NONAME" },
    cookieHeader(token)
  );
  assert.equal(noName.status, 400);
  assertInvalidRequest(await noName.json());

  const longName = await postJson(
    "/api/admin/faculties",
    { name: "x".repeat(201), code: "ADMORG-LONG" },
    cookieHeader(token)
  );
  assert.equal(longName.status, 400);
  assertInvalidRequest(await longName.json());
});

test("admin can rename a faculty", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/faculties", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((f) => f.code === FACULTY_A_CODE);
  assert.ok(created, "the created faculty must exist");
  const id = created!.id;

  const rename = await patchJson(
    `/api/admin/faculties/${id}`,
    { name: "Renamed Faculty" },
    cookieHeader(token)
  );
  assert.equal(rename.status, 200);
  const body = (await rename.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "Renamed Faculty");
  assert.equal(body.data.code, FACULTY_A_CODE, "code must be unchanged");
});

test("admin can update a faculty code (uppercased and trimmed)", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/faculties", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((f) => f.code === FACULTY_A_CODE);
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/faculties/${created!.id}`,
    { code: " admorg-api2 " },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.code, "ADMORG-API2");
});

test("admin can deactivate and reactivate a faculty", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/faculties", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((f) => f.code === "ADMORG-API2");
  assert.ok(created);

  const deactivate = await patchJson(
    `/api/admin/faculties/${created!.id}`,
    { status: "inactive" },
    cookieHeader(token)
  );
  assert.equal(deactivate.status, 200);
  const inactive = (await deactivate.json()) as { data: Record<string, unknown> };
  assert.equal(inactive.data.status, "INACTIVE", "status must be normalized");
  assert.equal(inactive.data.id, created!.id, "id must be unchanged");

  const reactivate = await patchJson(
    `/api/admin/faculties/${created!.id}`,
    { status: "ACTIVE" },
    cookieHeader(token)
  );
  assert.equal(reactivate.status, 200);
  const active = (await reactivate.json()) as { data: Record<string, unknown> };
  assert.equal(active.data.status, "ACTIVE");
});

test("updating a faculty to a used code returns 409", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/faculties", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((f) => f.code === "ADMORG-API2");
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/faculties/${created!.id}`,
    { code: "ADMORGFAC" },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "CONFLICT");
});

test("updating a nonexistent faculty returns 404", async () => {
  const token = await adminToken();
  const res = await patchJson(
    "/api/admin/faculties/999999",
    { name: "Ghost Faculty" },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "NOT_FOUND");
});

test("invalid faculty patch bodies are rejected with 400", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/faculties", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((f) => f.code === "ADMORG-API2");
  assert.ok(created);
  const id = created!.id;

  const empty = await patchJson(`/api/admin/faculties/${id}`, {}, cookieHeader(token));
  assert.equal(empty.status, 400);
  assertInvalidRequest(await empty.json());

  const badStatus = await patchJson(
    `/api/admin/faculties/${id}`,
    { status: "BOGUS" },
    cookieHeader(token)
  );
  assert.equal(badStatus.status, 400);
  assertInvalidRequest(await badStatus.json());

  const badId = await patchJson("/api/admin/faculties/not-a-number", { name: "X" }, cookieHeader(token));
  assert.equal(badId.status, 400);
  assertInvalidRequest(await badId.json());
});

test("admin can list departments with faculty details", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/departments", cookieHeader(token));

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(body.data));
  const base = body.data.find((d) => d.code === "ADMORGDEPT");
  assert.ok(base, "list must include the seeded department");
  assert.equal(base!.facultyCode, "ADMORGFAC");
  assert.equal(typeof base!.facultyName, "string");
  assert.equal(typeof base!.facultyId, "number");
});

test("admin can create a department under a faculty", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/faculties", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const faculty = all.data.find((f) => f.code === "ADMORG-API2");
  assert.ok(faculty);

  const res = await postJson(
    "/api/admin/departments",
    { name: "Admin Org Department", code: " admorg-dep1 ", facultyId: faculty!.id },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.code, DEPARTMENT_CODE);
  assert.equal(body.data.name, "Admin Org Department");
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(body.data.facultyId, faculty!.id);
  assert.equal(body.data.facultyCode, "ADMORG-API2");
  assert.equal(typeof body.data.facultyName, "string");
});

test("duplicate department codes are rejected with 409", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/departments",
    { name: "Duplicate Department", code: DEPARTMENT_CODE, facultyId: profileFacultyId },
    cookieHeader(token)
  );

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "CONFLICT");
});

test("creating a department for a nonexistent faculty returns 404", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/departments",
    { name: "Orphan Department", code: "ADMORG-DEPX", facultyId: 999999 },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FACULTY_NOT_FOUND");
});

test("invalid department create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const noFaculty = await postJson(
    "/api/admin/departments",
    { name: "No Faculty", code: "ADMORG-NOFAC" },
    cookieHeader(token)
  );
  assert.equal(noFaculty.status, 400);
  assertInvalidRequest(await noFaculty.json());

  const negativeFaculty = await postJson(
    "/api/admin/departments",
    { name: "Negative Faculty", code: "ADMORG-NEGFAC", facultyId: -1 },
    cookieHeader(token)
  );
  assert.equal(negativeFaculty.status, 400);
  assertInvalidRequest(await negativeFaculty.json());

  const noName = await postJson(
    "/api/admin/departments",
    { code: "ADMORG-NONAME", facultyId: profileFacultyId },
    cookieHeader(token)
  );
  assert.equal(noName.status, 400);
  assertInvalidRequest(await noName.json());
});

test("admin can rename a department", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/departments", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((d) => d.code === DEPARTMENT_CODE);
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/departments/${created!.id}`,
    { name: "Renamed Department" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "Renamed Department");
  assert.equal(body.data.code, DEPARTMENT_CODE);
  assert.equal(body.data.facultyCode, "ADMORG-API2", "faculty must be unchanged");
});

test("admin can move a department to another faculty", async () => {
  const token = await adminToken();

  const facultyPost = await postJson(
    "/api/admin/faculties",
    { name: "Admin Org Faculty B", code: FACULTY_B_CODE },
    cookieHeader(token)
  );
  assert.equal(facultyPost.status, 201);
  const facultyB = (await facultyPost.json()) as { data: Record<string, unknown> };

  const all = (await (await get("/api/admin/departments", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((d) => d.code === DEPARTMENT_CODE);
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/departments/${created!.id}`,
    { facultyId: facultyB.data.id },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.facultyId, facultyB.data.id);
  assert.equal(body.data.facultyCode, FACULTY_B_CODE);
});

test("moving a department to a nonexistent faculty returns 404", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/departments", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((d) => d.code === DEPARTMENT_CODE);
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/departments/${created!.id}`,
    { facultyId: 999999 },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FACULTY_NOT_FOUND");
});

test("admin can deactivate a department", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/departments", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((d) => d.code === DEPARTMENT_CODE);
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/departments/${created!.id}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "INACTIVE");
  assert.equal(body.data.facultyCode, FACULTY_B_CODE, "faculty must be preserved");
});

test("updating a department to a used code returns 409", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/departments", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((d) => d.code === DEPARTMENT_CODE);
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/departments/${created!.id}`,
    { code: "ADMORGDEPT" },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "CONFLICT");
});

test("updating a nonexistent department returns 404", async () => {
  const token = await adminToken();
  const res = await patchJson(
    "/api/admin/departments/999999",
    { name: "Ghost Department" },
    cookieHeader(token)
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "NOT_FOUND");
});

test("invalid department patch bodies are rejected with 400", async () => {
  const token = await adminToken();
  const all = (await (await get("/api/admin/departments", cookieHeader(token))).json()) as {
    data: Array<Record<string, unknown>>;
  };
  const created = all.data.find((d) => d.code === DEPARTMENT_CODE);
  assert.ok(created);
  const id = created!.id;

  const empty = await patchJson(`/api/admin/departments/${id}`, {}, cookieHeader(token));
  assert.equal(empty.status, 400);
  assertInvalidRequest(await empty.json());

  const badFacultyId = await patchJson(
    `/api/admin/departments/${id}`,
    { facultyId: 0 },
    cookieHeader(token)
  );
  assert.equal(badFacultyId.status, 400);
  assertInvalidRequest(await badFacultyId.json());

  const badId = await patchJson("/api/admin/departments/not-a-number", { name: "X" }, cookieHeader(token));
  assert.equal(badId.status, 400);
  assertInvalidRequest(await badId.json());
});

test("department listing reflects created, renamed, and moved departments", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/departments", cookieHeader(token));

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  const created = body.data.find((d) => d.code === DEPARTMENT_CODE);
  assert.ok(created);
  assert.equal(created!.name, "Renamed Department");
  assert.equal(created!.status, "INACTIVE");
  assert.equal(created!.facultyCode, FACULTY_B_CODE);
});