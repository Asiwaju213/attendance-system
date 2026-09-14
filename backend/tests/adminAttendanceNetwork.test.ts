import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-network-test-password";
const ADMIN_USERNAME = "admin_net_admin";
const STUDENT_MATRIC = "ADMNET/STU";
const LECTURER_STAFF_ID = "ADMNET/LEC";

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
  await pool.query(
    `DELETE FROM attendance_networks WHERE network_code LIKE 'ADMNET%'`
  );
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
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMNET%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMNET%'`);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Network Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac1 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Network Test Faculty', 'ADMNET-FAC') RETURNING id`
  );
  fac1Id = Number(fac1.rows[0].id);

  const dep1 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Network Test Department', 'ADMNET-DEP', $1) RETURNING id`,
    [fac1Id]
  );
  dep1Id = Number(dep1.rows[0].id);

  const levelRes = await pool.query(
    `SELECT id, name FROM levels WHERE name = 100`
  );
  level100Id = Number(levelRes.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Network Test Student', $1, 'STUDENT', 'ACTIVE', NULL)
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
     VALUES ('Network Test Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
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

async function networksList(
  token: string,
  query = ""
): Promise<Array<Record<string, unknown>>> {
  const res = await get("/api/admin/attendance-networks" + query, cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

function byCode(
  list: Array<Record<string, unknown>>,
  code: string
): Record<string, unknown> | undefined {
  return list.find((n) => n.networkCode === code);
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

test("attendance network endpoints require authentication", async () => {
  const res = await get("/api/admin/attendance-networks");
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("attendance network endpoints reject students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/attendance-networks", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("attendance network endpoints reject lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/attendance-networks", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

test("admin can list attendance networks", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/attendance-networks", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown };
  assert.ok(Array.isArray(body.data));
});

test("attendance networks list is ordered deterministically by code", async () => {
  const token = await adminToken();
  await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-OZB", name: "Order B" },
    cookieHeader(token)
  );
  await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-OZA", name: "Order A" },
    cookieHeader(token)
  );

  const codes = (await networksList(token))
    .filter((n) => typeof n.networkCode === "string" &&
      (n.networkCode as string).startsWith("ADMNET-OZ"))
    .map((n) => n.networkCode as string);

  assert.deepEqual(codes, ["ADMNET-OZA", "ADMNET-OZB"]);
});

test("attendance networks can be filtered by status", async () => {
  const token = await adminToken();
  await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-FAC", name: "Filter Active" },
    cookieHeader(token)
  );
  const createInactive = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-FIC", name: "Filter Inactive" },
    cookieHeader(token)
  );
  const inactive = (await createInactive.json()) as { data: { id: number } };
  const patch = await patchJson(
    `/api/admin/attendance-networks/${inactive.data.id}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(patch.status, 200);

  const active = (await networksList(token, "?status=ACTIVE")).filter(
    (n) => n.networkCode === "ADMNET-FAC"
  );
  assert.equal(active.length, 1);

  const inactiveList = (await networksList(token, "?status=INACTIVE")).filter(
    (n) => n.networkCode === "ADMNET-FIC"
  );
  assert.equal(inactiveList.length, 1);
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test("admin can create an attendance network", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-C1", name: "Network One" },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.networkCode, "ADMNET-C1");
  assert.equal(body.data.name, "Network One");
  assert.equal(body.data.status, "ACTIVE");
  assert.equal(typeof body.data.id, "number");
  assert.equal(typeof body.data.createdAt, "string");
});

test("attendance network code is normalized to uppercase and strings are trimmed", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: " admnet-c2 ", name: "  Network Two  " },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.networkCode, "ADMNET-C2");
  assert.equal(body.data.name, "Network Two");
});

test("attendance network creation always defaults to ACTIVE", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-C3", name: "Network Three", status: "INACTIVE" },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "ACTIVE", "client-supplied status must be ignored");
});

test("a duplicate attendance network code is rejected", async () => {
  const token = await adminToken();
  const res = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-C1", name: "Network One Again" },
    cookieHeader(token)
  );

  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "CONFLICT");
});

test("invalid attendance network create bodies are rejected with 400", async () => {
  const token = await adminToken();

  const missingName = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-NONAME" },
    cookieHeader(token)
  );
  assert.equal(missingName.status, 400);
  assertInvalidRequest(await missingName.json());

  const missingCode = await postJson(
    "/api/admin/attendance-networks",
    { name: "No Code" },
    cookieHeader(token)
  );
  assert.equal(missingCode.status, 400);
  assertInvalidRequest(await missingCode.json());

  const emptyName = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-EMPTY", name: "   " },
    cookieHeader(token)
  );
  assert.equal(emptyName.status, 400);
  assertInvalidRequest(await emptyName.json());

  const longCode = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "x".repeat(33), name: "Long Code" },
    cookieHeader(token)
  );
  assert.equal(longCode.status, 400);
  assertInvalidRequest(await longCode.json());

  const longName = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-LONGNAME", name: "x".repeat(201) },
    cookieHeader(token)
  );
  assert.equal(longName.status, 400);
  assertInvalidRequest(await longName.json());
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

test("attendance network name can be updated", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-U1", name: "Network U1" },
    cookieHeader(token)
  );
  const { data: network } = (await created.json()) as { data: { id: number } };

  const res = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { name: "Network U1 Renamed" },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.name, "Network U1 Renamed");
  assert.equal(body.data.networkCode, "ADMNET-U1");
});

test("attendance network networkCode cannot be changed", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-U2", name: "Network U2" },
    cookieHeader(token)
  );
  const { data: network } = (await created.json()) as { data: { id: number } };

  const res = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { networkCode: "ADMNET-CHANGED", name: "Network U2 Kept" },
    cookieHeader(token)
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.networkCode, "ADMNET-U2", "networkCode must remain unchanged");
  assert.equal(body.data.name, "Network U2 Kept");
});

test("attendance network can be deactivated and reactivated", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-U3", name: "Network U3" },
    cookieHeader(token)
  );
  const { data: network } = (await created.json()) as { data: { id: number } };

  const deactivate = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(deactivate.status, 200);
  assert.equal((await deactivate.json()).data.status, "INACTIVE");

  const reactivate = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { status: "ACTIVE" },
    cookieHeader(token)
  );
  assert.equal(reactivate.status, 200);
  assert.equal((await reactivate.json()).data.status, "ACTIVE");
});

test("updating a nonexistent attendance network returns 404", async () => {
  const token = await adminToken();
  const res = await patchJson(
    "/api/admin/attendance-networks/999999",
    { name: "Nope" },
    cookieHeader(token)
  );

  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "NOT_FOUND");
});

test("an invalid attendance network id is rejected", async () => {
  const token = await adminToken();

  const letters = await patchJson(
    "/api/admin/attendance-networks/abc",
    { name: "Bad" },
    cookieHeader(token)
  );
  assert.equal(letters.status, 400);
  assertInvalidRequest(await letters.json());

  const zero = await patchJson(
    "/api/admin/attendance-networks/0",
    { name: "Bad" },
    cookieHeader(token)
  );
  assert.equal(zero.status, 400);
  assertInvalidRequest(await zero.json());
});

test("an invalid attendance network status is rejected", async () => {
  const token = await adminToken();
  const created = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "ADMNET-U4", name: "Network U4" },
    cookieHeader(token)
  );
  const { data: network } = (await created.json()) as { data: { id: number } };

  const res = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { status: "BOGUS" },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertInvalidRequest(await res.json());

  const badFilter = await get(
    "/api/admin/attendance-networks?status=BOGUS",
    cookieHeader(token)
  );
  assert.equal(badFilter.status, 400);
  assertInvalidRequest(await badFilter.json());
});

test("attendance network list shapes match the API contract", async () => {
  const token = await adminToken();
  const data = await networksList(token);
  const c1 = byCode(data, "ADMNET-C1");
  assert.ok(c1);
  assert.equal(c1!.networkCode, "ADMNET-C1");
  assert.equal(typeof c1!.name, "string");
  assert.equal(typeof c1!.id, "number");
  assert.equal(typeof c1!.createdAt, "string");
  assert.equal(typeof c1!.updatedAt, "string");
});