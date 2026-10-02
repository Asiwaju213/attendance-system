import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { boundDeviceHeaders } from "./studentSessionTestHelpers";

const TEST_PASSWORD = "admin-lecturer-test-password";
const ADMIN_USERNAME = "admin_lec_admin";
const STUDENT_MATRIC = "ADM/LEC/STU";
const LECTURER_STAFF_ACTIVE = "ADM/LEC/LEC1";
const LECTURER_STAFF_INACTIVE = "ADM/LEC/LEC2";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let depId = 0;
let activeLecturerId = 0;

let adminUserId = 0;
let studentUserId = 0;
let activeLecturerUserId = 0;
let inactiveLecturerUserId = 0;

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

function allUserIds(): number[] {
  return [adminUserId, studentUserId, activeLecturerUserId, inactiveLecturerUserId];
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

before(async () => {
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    allUserIds(),
  ]);
  await pool.query(`DELETE FROM students WHERE matric_number = $1`, [STUDENT_MATRIC]);
  await pool.query(
    `DELETE FROM lecturers WHERE staff_id = ANY($1::TEXT[])`,
    [[LECTURER_STAFF_ACTIVE, LECTURER_STAFF_INACTIVE]]
  );
  await pool.query(
    `DELETE FROM users
     WHERE username = $1
        OR id IN (
          SELECT user_id FROM students WHERE matric_number = $2
          UNION
          SELECT user_id FROM lecturers WHERE staff_id = ANY($3::TEXT[])
        )`,
    [ADMIN_USERNAME, STUDENT_MATRIC, [LECTURER_STAFF_ACTIVE, LECTURER_STAFF_INACTIVE]]
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMLEC%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMLEC%'`);

  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Lecturer Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Lecturer Test', 'ADMLEC-FAC') RETURNING id`
  );
  const facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ('Lecturer Test Department', 'ADMLEC-DEP', $1) RETURNING id`,
    [facId]
  );
  depId = Number(dep.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Lecturer Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     SELECT $1, $2, $3, id FROM levels WHERE name = 100`,
    [studentUserId, STUDENT_MATRIC, depId]
  );

  const activeLecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Lecturer One', $1, 'LECTURER', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  activeLecturerUserId = Number(activeLecturer.rows[0].id);
  const activeProfile = await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [activeLecturerUserId, LECTURER_STAFF_ACTIVE, depId]
  );
  activeLecturerId = Number(activeProfile.rows[0].id);

  const inactiveLecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Admin Lecturer Two', $1, 'LECTURER', 'INACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  inactiveLecturerUserId = Number(inactiveLecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [inactiveLecturerUserId, LECTURER_STAFF_INACTIVE, depId]
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
    allUserIds(),
  ]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
    allUserIds(),
  ]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [
    allUserIds(),
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [allUserIds()]);
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMLEC%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMLEC%'`);
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

test("lecturer listing requires authentication", async () => {
  const res = await get("/api/admin/lecturers");
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

test("lecturer listing rejects students", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  }, await boundDeviceHeaders(STUDENT_MATRIC));
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/lecturers", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("lecturer listing rejects lecturers", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ACTIVE,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/admin/lecturers", cookieHeader(token!));
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

test("admin can list active lecturers", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/lecturers", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };

  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 2);

  const active = body.data.find((l) => l.staffId === LECTURER_STAFF_ACTIVE);
  assert.ok(active, "the active lecturer should be listed");
  assert.equal(active!.id, activeLecturerId);
  assert.equal(active!.userId, activeLecturerUserId);
  assert.equal(active!.name, "Admin Lecturer One");
  assert.equal(active!.departmentId, depId);
  assert.equal(active!.departmentName, "Lecturer Test Department");
  assert.equal(active!.departmentCode, "ADMLEC-DEP");
  assert.equal(active!.status, "ACTIVE");
});

test("inactive lecturers are excluded from the listing", async () => {
  const token = await adminToken();
  const res = await get("/api/admin/lecturers", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };

  const inactive = body.data.find((l) => l.staffId === LECTURER_STAFF_INACTIVE);
  assert.equal(inactive, undefined, "the inactive lecturer should not be listed");
});