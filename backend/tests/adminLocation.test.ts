import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-location-test-password";
const ADMIN_USERNAME = "admin_loc_admin";
const STUDENT_MATRIC = "ADMLOC/STU";
const LECTURER_STAFF_ID = "ADMLOC/LEC";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturerUserId = 0;

let fac1Id = 0;
let dep1Id = 0;
let level100Id = 0;

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

async function cleanupScopedData(): Promise<void> {
  await pool.query(`DELETE FROM locations WHERE name LIKE 'ADMLOC%'`);
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
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMLOC%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMLOC%'`);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Location Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac1 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Location Test Faculty', 'ADMLOC-FAC') RETURNING id`
  );
  fac1Id = Number(fac1.rows[0].id);

  const dep1 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Location Test Department', 'ADMLOC-DEP', $1) RETURNING id`,
    [fac1Id]
  );
  dep1Id = Number(dep1.rows[0].id);

  const levelRes = await pool.query(
    `SELECT id, name FROM levels WHERE name = 100`
  );
  level100Id = Number(levelRes.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Location Test Student', $1, 'STUDENT', 'ACTIVE', NULL)
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
     VALUES ('Location Test Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
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

  await cleanupScopedData();
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

async function locationsList(
  token: string,
  query = ""
): Promise<Array<Record<string, unknown>>> {
  const res = await get("/api/admin/locations" + query, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

function fixtureLocations(
  list: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return list.filter(
    (l) => typeof l.name === "string" && (l.name as string).startsWith("ADMLOC")
  );
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

test("location endpoints require authentication", async () => {
  const res = await get("/api/admin/locations");
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("location endpoints reject students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/locations", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("location endpoints reject lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/locations", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

test("admin can list locations", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/locations", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown };
  assert.ok(Array.isArray(body.data));
});

test("locations list is ordered deterministically by name then id", async () => {
  const token = await adminToken();
  await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-OrderZ", description: "Z" },
    cookieHeader(token)
  );
  await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-OrderA", description: "A" },
    cookieHeader(token)
  );
  await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-OrderA", description: "Second A" },
    cookieHeader(token)
  );

  const ours = fixtureLocations(await locationsList(token)).filter(
    (l) => l.name === "ADMLOC-OrderA" || l.name === "ADMLOC-OrderZ"
  );
  assert.equal(ours.length, 3);
  assert.equal(ours[0].name, "ADMLOC-OrderA");
  assert.equal(ours[1].name, "ADMLOC-OrderA");
  assert.equal(ours[2].name, "ADMLOC-OrderZ");
});

test("locations can be filtered by status", async () => {
  const token = await adminToken();
  await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-FilterActive" },
    cookieHeader(token)
  );
  const createInactive = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-FilterInactive" },
    cookieHeader(token)
  );
  const inactive = (await createInactive.json()) as { data: { id: number } };
  const patch = await patchJson(
    `/api/admin/locations/${inactive.data.id}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(patch.status, 200);

  const activeNames = fixtureLocations(await locationsList(token, "?status=ACTIVE"))
    .map((l) => l.name as string)
    .filter((n) => n === "ADMLOC-FilterActive" || n === "ADMLOC-FilterInactive");
  assert.deepEqual(activeNames, ["ADMLOC-FilterActive"]);

  const inactiveNames = fixtureLocations(await locationsList(token, "?status=INACTIVE"))
    .map((l) => l.name as string)
    .filter((n) => n === "ADMLOC-FilterActive" || n === "ADMLOC-FilterInactive");
  assert.deepEqual(inactiveNames, ["ADMLOC-FilterInactive"]);
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test("admin can create a location", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-1", description: "Computer Lab" },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "ADMLOC-1");
  assert.equal(body.data.description, "Computer Lab");
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(typeof body.data.id, "number");
  assert.equal(typeof body.data.createdAt, "string");
});

test("location name and description are trimmed and normalized", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/locations",
    { name: "  ADMLOC-2  ", description: "  Main Lecture Hall  " },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "ADMLOC-2");
  assert.equal(body.data.description, "Main Lecture Hall");
});

test("a missing or blank description is stored as null", async () => {
  const token = await adminToken();

  const absent = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-3" },
    cookieHeader(token)
  );
  assert.equal(absent.status, 201);
  assert.equal((await absent.json()).data.description, null);

  const blank = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-4", description: "   " },
    cookieHeader(token)
  );
  assert.equal(blank.status, 201);
  assert.equal((await blank.json()).data.description, null);

  const explicitNull = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-5", description: null },
    cookieHeader(token)
  );
  assert.equal(explicitNull.status, 201);
  assert.equal((await explicitNull.json()).data.description, null);
});

test("location creation always defaults to ACTIVE", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-6", description: "Lab", status: "INACTIVE" },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "ACTIVE", "client-supplied status must be ignored");
});

test("duplicate location names are allowed", async () => {
  const token = await adminToken();
  const first = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-DUP", description: "First" },
    cookieHeader(token)
  );
  const second = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-DUP", description: "Second" },
    cookieHeader(token)
  );

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstBody = (await first.json()) as { data: { id: number } };
  const secondBody = (await second.json()) as { data: { id: number } };
  assert.notEqual(firstBody.data.id, secondBody.data.id);
});

test("invalid location create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const missingName = await postJson(
    "/api/admin/locations",
    {},
    cookieHeader(token)
  );
  assert.equal(missingName.status, 400);
  assertInvalidRequest(await missingName.json());

  const emptyName = await postJson(
    "/api/admin/locations",
    { name: "   " },
    cookieHeader(token)
  );
  assert.equal(emptyName.status, 400);
  assertInvalidRequest(await emptyName.json());

  const longName = await postJson(
    "/api/admin/locations",
    { name: "x".repeat(201) },
    cookieHeader(token)
  );
  assert.equal(longName.status, 400);
  assertInvalidRequest(await longName.json());

  const nonStringDescription = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-BADDESC", description: 42 },
    cookieHeader(token)
  );
  assert.equal(nonStringDescription.status, 400);
  assertInvalidRequest(await nonStringDescription.json());

  const longDescription = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-LONGDESC", description: "x".repeat(1001) },
    cookieHeader(token)
  );
  assert.equal(longDescription.status, 400);
  assertInvalidRequest(await longDescription.json());
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

test("location name can be updated", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-U1", description: "Original" },
    cookieHeader(token)
  );
  const { data: location } = (await created.json()) as { data: { id: number } };

  const res = await patchJson(
    `/api/admin/locations/${location.id}`,
    { name: "ADMLOC-U1-RENAMED" },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "ADMLOC-U1-RENAMED");
  assert.equal(body.data.description, "Original");
});

test("location description can be updated and cleared", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-U2", description: "Original" },
    cookieHeader(token)
  );
  const { data: location } = (await created.json()) as { data: { id: number } };

  const updateRes = await patchJson(
    `/api/admin/locations/${location.id}`,
    { description: "Renovated" },
    cookieHeader(token)
  );
  assert.equal(updateRes.status, 200);
  assert.equal((await updateRes.json()).data.description, "Renovated");

  const clearRes = await patchJson(
    `/api/admin/locations/${location.id}`,
    { description: null },
    cookieHeader(token)
  );
  assert.equal(clearRes.status, 200);
  assert.equal((await clearRes.json()).data.description, null);

  const blankRes = await patchJson(
    `/api/admin/locations/${location.id}`,
    { description: "   " },
    cookieHeader(token)
  );
  assert.equal(blankRes.status, 200);
  assert.equal((await blankRes.json()).data.description, null);
});

test("location can be deactivated and reactivated", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-U3" },
    cookieHeader(token)
  );
  const { data: location } = (await created.json()) as { data: { id: number } };

  const deactivate = await patchJson(
    `/api/admin/locations/${location.id}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(deactivate.status, 200);
  assert.equal((await deactivate.json()).data.status, "INACTIVE");

  const reactivate = await patchJson(
    `/api/admin/locations/${location.id}`,
    { status: "ACTIVE" },
    cookieHeader(token)
  );
  assert.equal(reactivate.status, 200);
  assert.equal((await reactivate.json()).data.status, "ACTIVE");
});

test("updating a nonexistent location returns 404", async () => {
  const token = await adminToken();
  const res = await patchJson(
    "/api/admin/locations/999999",
    { name: "Nope" },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "NOT_FOUND");
});

test("an invalid location id is rejected", async () => {
  const token = await adminToken();

  const letters = await patchJson(
    "/api/admin/locations/abc",
    { name: "Bad" },
    cookieHeader(token)
  );
  assert.equal(letters.status, 400);
  assertInvalidRequest(await letters.json());

  const zero = await patchJson(
    "/api/admin/locations/0",
    { name: "Bad" },
    cookieHeader(token)
  );
  assert.equal(zero.status, 400);
  assertInvalidRequest(await zero.json());
});

test("an invalid location status is rejected", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/locations",
    { name: "ADMLOC-U4" },
    cookieHeader(token)
  );
  const { data: location } = (await created.json()) as { data: { id: number } };

  const res = await patchJson(
    `/api/admin/locations/${location.id}`,
    { status: "BOGUS" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  const badFilter = await get("/api/admin/locations?status=BOGUS", cookieHeader(token));
  assert.equal(badFilter.status, 400);
  assertInvalidRequest(await badFilter.json());
});