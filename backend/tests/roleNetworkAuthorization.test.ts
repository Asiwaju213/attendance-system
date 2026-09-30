import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

/**
 * Role authorization for the attendance network / location configuration and
 * for the portals that must stay reachable from an ordinary internet connection.
 *
 * The K12 attendance router restriction is a STUDENT-only rule. This suite pins
 * the two halves of that rule that are enforceable today:
 *
 *   1. Attendance networks and attendance locations are configuration. Only
 *      ADMIN may list, create, update, activate or deactivate them. LECTURER
 *      and STUDENT are refused with 403.
 *   2. LECTURER and ADMIN are never gated by the student network restriction.
 *      The test server binds to loopback, so every request here arrives from
 *      127.0.0.1 - a connection that is provably not the attendance router
 *      network - and the lecturer and admin portals must still answer normally.
 *
 * NOT covered here: the STUDENT-side network gate itself. The
 * `attendance_networks` table currently stores only `network_code`, `name` and
 * `status` - it has no address, subnet or SSID column - and no request-level
 * IP check exists yet. The K12 router address is still to be supplied, and it
 * must not be guessed, so no student network assertion is written yet. Those
 * tests belong here once the router details land.
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
  await pool.query(`DELETE FROM locations WHERE name LIKE 'NETAUTH%'`);
  await pool.query(
    `DELETE FROM attendance_networks WHERE network_code LIKE 'NETAUTH%'`
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

  const level = await pool.query(
    `SELECT id FROM levels WHERE name = 100`
  );
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
  });
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
// Students may not configure networks or locations
// ---------------------------------------------------------------------------

test("a student cannot list attendance networks", async () => {
  const token = await studentToken();
  const res = await get("/api/admin/attendance-networks", cookieHeader(token));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("a student cannot create an attendance network", async () => {
  const token = await studentToken();
  const res = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "NETAUTH-S1", name: "Student Attempt" },
    cookieHeader(token)
  );
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("a student cannot update or deactivate an attendance network", async () => {
  const admin = await adminToken();
  const created = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "NETAUTH-S2", name: "Student Target" },
    cookieHeader(admin)
  );
  assert.equal(created.status, 201);
  const { data: network } = (await created.json()) as { data: { id: number } };

  const token = await studentToken();
  const res = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");

  const unchanged = await get("/api/admin/attendance-networks", cookieHeader(admin));
  const list = (await unchanged.json()) as { data: Array<{ id: number; status: string }> };
  assert.equal(
    list.data.find((n) => n.id === network.id)?.status,
    "ACTIVE",
    "a rejected student request must not mutate the network"
  );
});

test("a student cannot manage attendance locations", async () => {
  const token = await studentToken();

  const list = await get("/api/admin/locations", cookieHeader(token));
  assert.equal(list.status, 403);
  assertErrorCode(await list.json(), "FORBIDDEN");

  const create = await postJson(
    "/api/admin/locations",
    { name: "NETAUTH-Student Attempt" },
    cookieHeader(token)
  );
  assert.equal(create.status, 403);
  assertErrorCode(await create.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Lecturers may not configure networks or locations
// ---------------------------------------------------------------------------

test("a lecturer cannot list or create attendance networks", async () => {
  const token = await lecturerToken();

  const list = await get("/api/admin/attendance-networks", cookieHeader(token));
  assert.equal(list.status, 403);
  assertErrorCode(await list.json(), "FORBIDDEN");

  const create = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "NETAUTH-L1", name: "Lecturer Attempt" },
    cookieHeader(token)
  );
  assert.equal(create.status, 403);
  assertErrorCode(await create.json(), "FORBIDDEN");
});

test("a lecturer cannot update, deactivate or reactivate an attendance network", async () => {
  const admin = await adminToken();
  const created = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "NETAUTH-L2", name: "Lecturer Target" },
    cookieHeader(admin)
  );
  assert.equal(created.status, 201);
  const { data: network } = (await created.json()) as { data: { id: number } };

  const token = await lecturerToken();
  const deactivate = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(deactivate.status, 403);
  assertErrorCode(await deactivate.json(), "FORBIDDEN");

  const reactivate = await patchJson(
    `/api/admin/attendance-networks/${network.id}`,
    { status: "ACTIVE" },
    cookieHeader(token)
  );
  assert.equal(reactivate.status, 403);
  assertErrorCode(await reactivate.json(), "FORBIDDEN");

  const listed = await get("/api/admin/attendance-networks", cookieHeader(admin));
  const list = (await listed.json()) as { data: Array<{ id: number; status: string }> };
  assert.equal(
    list.data.find((n) => n.id === network.id)?.status,
    "ACTIVE",
    "a rejected lecturer request must not mutate the network"
  );
});

test("a lecturer cannot manage attendance locations", async () => {
  const token = await lecturerToken();

  const list = await get("/api/admin/locations", cookieHeader(token));
  assert.equal(list.status, 403);
  assertErrorCode(await list.json(), "FORBIDDEN");

  const create = await postJson(
    "/api/admin/locations",
    { name: "NETAUTH-Lecturer Attempt" },
    cookieHeader(token)
  );
  assert.equal(create.status, 403);
  assertErrorCode(await create.json(), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Only ADMIN manages the configuration
// ---------------------------------------------------------------------------

test("an admin can create, rename, deactivate and reactivate an attendance network", async () => {
  const token = await adminToken();

  const created = await postJson(
    "/api/admin/attendance-networks",
    { networkCode: "NETAUTH-A1", name: "Admin Network" },
    cookieHeader(token)
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { data: Record<string, unknown> };
  assert.equal(createdBody.data.networkCode, "NETAUTH-A1");
  assert.equal(createdBody.data.status, "ACTIVE");
  const networkId = createdBody.data.id as number;

  const renamed = await patchJson(
    `/api/admin/attendance-networks/${networkId}`,
    { name: "Admin Network Renamed" },
    cookieHeader(token)
  );
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).data.name, "Admin Network Renamed");

  const deactivated = await patchJson(
    `/api/admin/attendance-networks/${networkId}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(deactivated.status, 200);
  assert.equal((await deactivated.json()).data.status, "INACTIVE");

  const reactivated = await patchJson(
    `/api/admin/attendance-networks/${networkId}`,
    { status: "ACTIVE" },
    cookieHeader(token)
  );
  assert.equal(reactivated.status, 200);
  assert.equal((await reactivated.json()).data.status, "ACTIVE");
});

test("an admin can create, rename, deactivate and reactivate an attendance location", async () => {
  const token = await adminToken();

  const created = await postJson(
    "/api/admin/locations",
    { name: "NETAUTH-Admin Location", description: "Block A" },
    cookieHeader(token)
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { data: Record<string, unknown> };
  assert.equal(createdBody.data.status, "ACTIVE");
  const locationId = createdBody.data.id as number;

  const renamed = await patchJson(
    `/api/admin/locations/${locationId}`,
    { name: "NETAUTH-Admin Location Renamed" },
    cookieHeader(token)
  );
  assert.equal(renamed.status, 200);
  assert.equal(
    (await renamed.json()).data.name,
    "NETAUTH-Admin Location Renamed"
  );

  const deactivated = await patchJson(
    `/api/admin/locations/${locationId}`,
    { status: "INACTIVE" },
    cookieHeader(token)
  );
  assert.equal(deactivated.status, 200);
  assert.equal((await deactivated.json()).data.status, "INACTIVE");

  const reactivated = await patchJson(
    `/api/admin/locations/${locationId}`,
    { status: "ACTIVE" },
    cookieHeader(token)
  );
  assert.equal(reactivated.status, 200);
  assert.equal((await reactivated.json()).data.status, "ACTIVE");
});

// ---------------------------------------------------------------------------
// The student network restriction must never reach LECTURER or ADMIN
// ---------------------------------------------------------------------------

test("a lecturer reaches the lecturer portal over a non-campus connection", async () => {
  // Requests arrive from 127.0.0.1, which is not the attendance router
  // network. The student network restriction must not apply here.
  const token = await lecturerToken();

  const networks = await get("/api/lecturer/attendance-networks", cookieHeader(token));
  assert.equal(networks.status, 200, "lecturer must not be blocked by the student network rule");
  assert.ok(Array.isArray((await networks.json()).data));

  const locations = await get("/api/lecturer/locations", cookieHeader(token));
  assert.equal(locations.status, 200, "lecturer must not be blocked by the student network rule");
  assert.ok(Array.isArray((await locations.json()).data));

  const offerings = await get("/api/lecturer/course-offerings", cookieHeader(token));
  assert.equal(offerings.status, 200, "lecturer must not be blocked by the student network rule");
});

test("an admin reaches the admin portal over a non-campus connection", async () => {
  const token = await adminToken();

  const networks = await get("/api/admin/attendance-networks", cookieHeader(token));
  assert.equal(networks.status, 200, "admin must not be blocked by the student network rule");

  const locations = await get("/api/admin/locations", cookieHeader(token));
  assert.equal(locations.status, 200, "admin must not be blocked by the student network rule");
});

test("the student network restriction does not leak into role routing", async () => {
  // A lecturer must not be able to reach a student-only route, and a student
  // must not be able to reach a lecturer-only route. The restriction under
  // test is role-based, not network-based.
  const lecturer = await lecturerToken();
  const studentRoutes = await get("/api/student/attendance/eligible", cookieHeader(lecturer));
  assert.equal(studentRoutes.status, 403);
  assertErrorCode(await studentRoutes.json(), "FORBIDDEN");

  const student = await studentToken();
  const lecturerRoutes = await get("/api/lecturer/attendance-networks", cookieHeader(student));
  assert.equal(lecturerRoutes.status, 403);
  assertErrorCode(await lecturerRoutes.json(), "FORBIDDEN");
});
