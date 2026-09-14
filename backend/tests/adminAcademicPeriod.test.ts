import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-academic-period-test-password";
const ADMIN_USERNAME = "admin_acpd_admin";
const STUDENT_MATRIC = "AUTH/ACP/STU";
const LECTURER_STAFF_ID = "AUTH/ACP/LEC";

const SESSION_PREFIX = "ADMACD";

let server: Server;
let baseUrl: string;
let passwordHash: string;
let profileFacultyId: number;
let profileDepartmentId: number;
let level100Id: number;

let adminUserId = 0;
let studentUserId = 0;
let lecturerUserId = 0;
let preExistingActiveSessionId: number | null = null;

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

async function cleanupTestUsers(): Promise<void> {
  await pool.query(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT user_id FROM students WHERE matric_number = $1
       UNION
       SELECT user_id FROM lecturers WHERE staff_id = $2
       UNION
       SELECT id FROM users WHERE username = $3
     )`,
    [STUDENT_MATRIC, LECTURER_STAFF_ID, ADMIN_USERNAME]
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
  await pool.query(`DELETE FROM departments WHERE code = 'ADMACD-DEP'`);
  await pool.query(`DELETE FROM faculties WHERE code = 'ADMACD-FAC'`);
}

before(async () => {
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMACD%'`);
  await cleanupTestUsers();

  const activeAgg = await pool.query(
    `SELECT max(id) AS id FROM academic_sessions WHERE is_active = true`
  );
  const activeId = activeAgg.rows[0]?.id;
  preExistingActiveSessionId = activeId === null || activeId === undefined
    ? null
    : Number(activeId);

  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Academic Period Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Academic Period Test Faculty', 'ADMACD-FAC')
     RETURNING id`
  );
  profileFacultyId = Number(faculty.rows[0].id);

  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Academic Period Test Department', 'ADMACD-DEP', $1)
     RETURNING id`,
    [profileFacultyId]
  );
  profileDepartmentId = Number(department.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Academic Period Student', $1, 'STUDENT', 'ACTIVE', NULL)
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
     VALUES ('Academic Period Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
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

  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'ADMACD%'`);
  await pool.query(`UPDATE academic_sessions SET is_active = false`);
  if (preExistingActiveSessionId !== null) {
    await pool.query(`UPDATE academic_sessions SET is_active = true WHERE id = $1`, [
      preExistingActiveSessionId,
    ]);
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
  await pool.query(`DELETE FROM departments WHERE code = 'ADMACD-DEP'`);
  await pool.query(`DELETE FROM faculties WHERE code = 'ADMACD-FAC'`);
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

function assertAcademicSessionShape(session: Record<string, unknown>): void {
  assert.equal(typeof session.id, "number");
  assert.equal(typeof session.name, "string");
  assert.equal(typeof session.isActive, "boolean");
  assert.equal(typeof session.createdAt, "string");
  assert.equal(typeof session.updatedAt, "string");
}

function assertSemesterShape(semester: Record<string, unknown>): void {
  assert.equal(typeof semester.id, "number");
  assert.equal(typeof semester.name, "string");
  assert.equal(typeof semester.createdAt, "string");
  assert.equal(typeof semester.updatedAt, "string");
}

async function findSession(
  token: string,
  name: string
): Promise<Record<string, unknown> | undefined> {
  const res = await get("/api/admin/academic-sessions", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Academic sessions
// ---------------------------------------------------------------------------

test("academic-sessions endpoints require authentication", async () => {
  const res = await get("/api/admin/academic-sessions");
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "UNAUTHENTICATED");
});

test("academic-sessions endpoints reject students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/academic-sessions", cookieHeader(token!));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FORBIDDEN");
});

test("academic-sessions endpoints reject lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/academic-sessions", cookieHeader(token!));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FORBIDDEN");
});

test("admin can list academic sessions", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/academic-sessions", cookieHeader(token));

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(body.data));
  for (const session of body.data) {
    assertAcademicSessionShape(session);
  }
  const leftovers = body.data.filter((s) =>
    String(s.name).startsWith(SESSION_PREFIX)
  );
  assert.equal(leftovers.length, 0, "no test sessions should exist yet");
});

test("admin can create an academic session that defaults to inactive", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/academic-sessions",
    { name: "  ADMACD-2024/2025  " },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assertAcademicSessionShape(body.data);
  assert.equal(body.data.name, "ADMACD-2024/2025", "name must be trimmed");
  assert.equal(body.data.isActive, false, "new sessions must default to inactive");
  assert.match(res.headers.get("location") ?? "", /\/api\/admin\/academic-sessions\/\d+$/);
});

test("creating an academic session never activates it", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/academic-sessions",
    { name: "ADMACD-NEVER-ACTIVE", isActive: true },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "ADMACD-NEVER-ACTIVE");
  assert.equal(
    body.data.isActive,
    false,
    "client-supplied isActive must be ignored on create"
  );
});

test("duplicate academic session names are rejected with 409", async () => {
  const token = await adminToken();
  await postJson(
    "/api/admin/academic-sessions",
    { name: "ADMACD-2025/2026" },
    cookieHeader(token)
  );

  const res = await postJson(
    "/api/admin/academic-sessions",
    { name: "ADMACD-2025/2026" },
    cookieHeader(token)
  );

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "CONFLICT");
});

test("invalid academic session create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const noName = await postJson(
    "/api/admin/academic-sessions",
    {},
    cookieHeader(token)
  );
  assert.equal(noName.status, 400);
  assertInvalidRequest(await noName.json());

  const blankName = await postJson(
    "/api/admin/academic-sessions",
    { name: "   " },
    cookieHeader(token)
  );
  assert.equal(blankName.status, 400);
  assertInvalidRequest(await blankName.json());

  const longName = await postJson(
    "/api/admin/academic-sessions",
    { name: "x".repeat(201) },
    cookieHeader(token)
  );
  assert.equal(longName.status, 400);
  assertInvalidRequest(await longName.json());

  const nonStringName = await postJson(
    "/api/admin/academic-sessions",
    { name: 123 },
    cookieHeader(token)
  );
  assert.equal(nonStringName.status, 400);
  assertInvalidRequest(await nonStringName.json());
});

test("admin can rename an academic session", async () => {
  const token = await adminToken();
  const created = await findSession(token, "ADMACD-2024/2025");
  assert.ok(created, "the created session must exist");

  const res = await patchJson(
    `/api/admin/academic-sessions/${created!.id}`,
    { name: "ADMACD-2024/2025 Renamed" },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "ADMACD-2024/2025 Renamed");
  assert.equal(body.data.id, created!.id, "id must be unchanged");
  assert.equal(body.data.isActive, false, "rename must not change activity");
});

test("admin can activate an academic session", async () => {
  const token = await adminToken();
  const created = await findSession(token, "ADMACD-2025/2026");
  assert.ok(created);

  const res = await patchJson(
    `/api/admin/academic-sessions/${created!.id}`,
    { isActive: true },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.isActive, true);
});

test("activating a second session deactivates the previous one in one step", async () => {
  const token = await adminToken();
  const renamed = await findSession(token, "ADMACD-2024/2025 Renamed");
  assert.ok(renamed);

  const res = await patchJson(
    `/api/admin/academic-sessions/${renamed!.id}`,
    { isActive: true },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.isActive, true);

  const first = await findSession(token, "ADMACD-2025/2026");
  assert.equal(first!.isActive, false, "the previous active session must be deactivated");
});

test("admin can deactivate the active academic session", async () => {
  const token = await adminToken();
  const renamed = await findSession(token, "ADMACD-2024/2025 Renamed");
  assert.ok(renamed);

  const res = await patchJson(
    `/api/admin/academic-sessions/${renamed!.id}`,
    { isActive: false },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.isActive, false);
});

test("renaming to a used academic session name returns 409", async () => {
  const token = await adminToken();
  const renamed = await findSession(token, "ADMACD-2024/2025 Renamed");
  assert.ok(renamed);

  const res = await patchJson(
    `/api/admin/academic-sessions/${renamed!.id}`,
    { name: "ADMACD-2025/2026" },
    cookieHeader(token)
  );

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "CONFLICT");
});

test("updating a nonexistent academic session returns 404", async () => {
  const token = await adminToken();
  const res = await patchJson(
    "/api/admin/academic-sessions/999999",
    { name: "Ghost Session" },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "ACADEMIC_SESSION_NOT_FOUND");
});

test("combining a rename with an activation is atomic", async () => {
  const token = await adminToken();
  const renamed = await findSession(token, "ADMACD-2024/2025 Renamed");
  assert.ok(renamed);

  const res = await patchJson(
    `/api/admin/academic-sessions/${renamed!.id}`,
    { name: "ADMACD-COMBO", isActive: true },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "ADMACD-COMBO");
  assert.equal(body.data.isActive, true);

  const other = await findSession(token, "ADMACD-2025/2026");
  assert.equal(other!.isActive, false, "swapping must also deactivate the previous active session");
});

test("invalid academic session patch bodies are rejected with 400", async () => {
  const token = await adminToken();
  const created = await findSession(token, "ADMACD-COMBO");
  assert.ok(created);
  const id = created!.id;

  const empty = await patchJson(`/api/admin/academic-sessions/${id}`, {}, cookieHeader(token));
  assert.equal(empty.status, 400);
  assertInvalidRequest(await empty.json());

  const badType = await patchJson(
    `/api/admin/academic-sessions/${id}`,
    { isActive: "yes" },
    cookieHeader(token)
  );
  assert.equal(badType.status, 400);
  assertInvalidRequest(await badType.json());

  const blankName = await patchJson(
    `/api/admin/academic-sessions/${id}`,
    { name: "   " },
    cookieHeader(token)
  );
  assert.equal(blankName.status, 400);
  assertInvalidRequest(await blankName.json());

  const badId = await patchJson(
    "/api/admin/academic-sessions/not-a-number",
    { name: "X" },
    cookieHeader(token)
  );
  assert.equal(badId.status, 400);
  assertInvalidRequest(await badId.json());

  const zeroId = await patchJson(
    "/api/admin/academic-sessions/0",
    { isActive: true },
    cookieHeader(token)
  );
  assert.equal(zeroId.status, 400);
  assertInvalidRequest(await zeroId.json());
});

test("simultaneous activations never leave more than one active session", async () => {
  const token = await adminToken();

  async function createSession(name: string): Promise<number> {
    const res = await postJson(
      "/api/admin/academic-sessions",
      { name },
      cookieHeader(token)
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    return body.data.id as number;
  }

  const baselineId = await createSession("ADMACD-CONC-BASELINE");
  const bId = await createSession("ADMACD-CONC-B");
  const cId = await createSession("ADMACD-CONC-C");

  const baseline = await patchJson(
    `/api/admin/academic-sessions/${baselineId}`,
    { isActive: true },
    cookieHeader(token)
  );
  assert.equal(baseline.status, 200);

  await Promise.all([
    patchJson(`/api/admin/academic-sessions/${bId}`, { isActive: true }, cookieHeader(token)),
    patchJson(`/api/admin/academic-sessions/${cId}`, { isActive: true }, cookieHeader(token)),
  ]);

  const active = await pool.query(
    `SELECT id FROM academic_sessions
     WHERE is_active = true AND name LIKE 'ADMACD%'
     ORDER BY id ASC`
  );
  assert.equal(active.rowCount, 1, "exactly one ADMACD session may be active");
  const activeId = Number(active.rows[0].id);
  assert.ok(
    activeId === bId || activeId === cId,
    "the surviving active session must be one of the concurrent targets"
  );
});

// ---------------------------------------------------------------------------
// Semesters
// ---------------------------------------------------------------------------

test("semesters endpoints require authentication", async () => {
  const res = await get("/api/admin/semesters");
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "UNAUTHENTICATED");
});

test("semesters endpoints reject students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/semesters", cookieHeader(token!));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FORBIDDEN");
});

test("semesters endpoints reject lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/semesters", cookieHeader(token!));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "FORBIDDEN");
});

test("admin can list the seeded semesters", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/semesters", cookieHeader(token));

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(body.data));
  for (const semester of body.data) {
    assertSemesterShape(semester);
  }
  const names = body.data.map((s) => s.name);
  assert.ok(names.includes("First Semester"), "seeded semester must be listed");
  assert.ok(names.includes("Second Semester"), "seeded semester must be listed");
});

test("duplicate semester names are rejected with 409 (after trim)", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/semesters",
    { name: "  First Semester  " },
    cookieHeader(token)
  );

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "CONFLICT");
});

test("invalid semester create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const notAllowed = await postJson(
    "/api/admin/semesters",
    { name: "Third Semester" },
    cookieHeader(token)
  );
  assert.equal(notAllowed.status, 400);
  assertInvalidRequest(await notAllowed.json());

  const blankName = await postJson(
    "/api/admin/semesters",
    { name: "   " },
    cookieHeader(token)
  );
  assert.equal(blankName.status, 400);
  assertInvalidRequest(await blankName.json());

  const noName = await postJson("/api/admin/semesters", {}, cookieHeader(token));
  assert.equal(noName.status, 400);
  assertInvalidRequest(await noName.json());
});

test("admin can update a semester name (trimmed, unchanged value)", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/semesters", cookieHeader(token));
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  const first = body.data.find((s) => s.name === "First Semester");
  assert.ok(first);

  const patch = await patchJson(
    `/api/admin/semesters/${first!.id}`,
    { name: " First Semester " },
    cookieHeader(token)
  );

  assert.equal(patch.status, 200);
  const updated = (await patch.json()) as { data: Record<string, unknown> };
  assertSemesterShape(updated.data);
  assert.equal(updated.data.id, first!.id, "id must be unchanged");
  assert.equal(updated.data.name, "First Semester", "name must be trimmed");
});

test("renaming a semester to a used name returns 409", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/semesters", cookieHeader(token));
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  const first = body.data.find((s) => s.name === "First Semester");
  assert.ok(first);

  const patch = await patchJson(
    `/api/admin/semesters/${first!.id}`,
    { name: "Second Semester" },
    cookieHeader(token)
  );

  assert.equal(patch.status, 409);
  const json = await patch.json();
  assert.equal((json as { error: string }).error, "CONFLICT");
});

test("semester patches accept no fields other than name", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/semesters", cookieHeader(token));
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  const first = body.data.find((s) => s.name === "First Semester");
  assert.ok(first);

  const patch = await patchJson(
    `/api/admin/semesters/${first!.id}`,
    { isActive: true },
    cookieHeader(token)
  );

  assert.equal(patch.status, 400);
  assertInvalidRequest(await patch.json());
});

test("updating a nonexistent semester returns 404", async () => {
  const token = await adminToken();
  const res = await patchJson(
    "/api/admin/semesters/999999",
    { name: "First Semester" },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "SEMESTER_NOT_FOUND");
});

test("invalid semester patch bodies are rejected with 400", async () => {
  const token = await adminToken();

  const empty = await patchJson(
    "/api/admin/semesters/1",
    {},
    cookieHeader(token)
  );
  assert.equal(empty.status, 400);
  assertInvalidRequest(await empty.json());

  const notAllowed = await patchJson(
    "/api/admin/semesters/1",
    { name: "Fourth Semester" },
    cookieHeader(token)
  );
  assert.equal(notAllowed.status, 400);
  assertInvalidRequest(await notAllowed.json());

  const badId = await patchJson(
    "/api/admin/semesters/not-a-number",
    { name: "First Semester" },
    cookieHeader(token)
  );
  assert.equal(badId.status, 400);
  assertInvalidRequest(await badId.json());
});