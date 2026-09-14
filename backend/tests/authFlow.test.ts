import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { requireAdmin, requireAuth } from "../src/middleware/authenticate";

const TEST_PASSWORD = "auth-flow-test-password";
const ONE_HOUR_MS = 60 * 60 * 1000;

let server: Server;
let baseUrl: string;
let departmentId: number;
let levelId: number;
let passwordHash: string;
let facultyId: number;

let activeStudentId = 0;
let inactiveStudentId = 0;
let activeLecturerId = 0;
let inactiveLecturerId = 0;
let activeAdminId = 0;
let inactiveAdminId = 0;

const userCreds = {
  activeStudent: { matricNumber: "AUTH/STU/0001", password: TEST_PASSWORD },
  inactiveStudent: { matricNumber: "AUTH/STU/0002", password: TEST_PASSWORD },
  activeLecturer: { staffId: "AUTH/LEC/0001", password: TEST_PASSWORD },
  inactiveLecturer: { staffId: "AUTH/LEC/0002", password: TEST_PASSWORD },
  activeAdmin: { username: "auth_admin", password: TEST_PASSWORD },
  inactiveAdmin: { username: "auth_admin_inactive", password: TEST_PASSWORD },
};

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

before(async () => {
  await pool.query(
    `INSERT INTO faculties (name, code)
     VALUES ('Auth Flow Test Faculty', 'AUTHFLOWFAC')
     ON CONFLICT (code) DO NOTHING`
  );
  const facultyRes = await pool.query(
    `SELECT id FROM faculties WHERE code = 'AUTHFLOWFAC'`
  );
  facultyId = Number(facultyRes.rows[0].id);

  const dept = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Auth Flow Test Department', 'AUTHFLOW', $1)
     ON CONFLICT (code) DO NOTHING`,
    [facultyId]
  );
  if ((dept.rowCount ?? 0) === 0) {
    const existing = await pool.query(
      `SELECT id FROM departments WHERE code = 'AUTHFLOW'`
    );
    departmentId = existing.rows[0].id;
  } else {
    const created = await pool.query(
      `SELECT id FROM departments WHERE code = 'AUTHFLOW'`
    );
    departmentId = created.rows[0].id;
  }
  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelId = level.rows[0].id;

  passwordHash = await hashPassword(TEST_PASSWORD);

  async function insertUser(
    name: string,
    role: string,
    status: string,
    username: string | null
  ): Promise<number> {
    const result = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, passwordHash, role, status, username]
    );
    return Number(result.rows[0].id);
  }

  activeStudentId = await insertUser("Active Student", "STUDENT", "ACTIVE", null);
  inactiveStudentId = await insertUser("Inactive Student", "STUDENT", "INACTIVE", null);
  activeLecturerId = await insertUser("Active Lecturer", "LECTURER", "ACTIVE", null);
  inactiveLecturerId = await insertUser("Inactive Lecturer", "LECTURER", "INACTIVE", null);
  activeAdminId = await insertUser("Active Admin", "ADMIN", "ACTIVE", userCreds.activeAdmin.username);
  inactiveAdminId = await insertUser("Inactive Admin", "ADMIN", "INACTIVE", userCreds.inactiveAdmin.username);

  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [activeStudentId, userCreds.activeStudent.matricNumber, departmentId, levelId]
  );
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [inactiveStudentId, userCreds.inactiveStudent.matricNumber, departmentId, levelId]
  );
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [activeLecturerId, userCreds.activeLecturer.staffId, departmentId]
  );
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [inactiveLecturerId, userCreds.inactiveLecturer.staffId, departmentId]
  );

  app.get("/api/test/admin-only", requireAuth, requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });

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

  const userIds = [
    activeStudentId,
    inactiveStudentId,
    activeLecturerId,
    inactiveLecturerId,
    activeAdminId,
    inactiveAdminId,
  ];

  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(`DELETE FROM departments WHERE code = 'AUTHFLOW'`);
  await pool.query(`DELETE FROM faculties WHERE code = 'AUTHFLOWFAC'`);
  await pool.end();
});

function assertGenericCredentialFailure(body: unknown): void {
  assert.deepEqual(body, { error: "INVALID_CREDENTIALS" });
}

function assertSafeUser(
  user: Record<string, unknown>,
  role: string,
  identifierField: string,
  identifier: string
): void {
  assert.equal(typeof user.id, "number");
  assert.equal(typeof user.name, "string");
  assert.ok(user.name.length > 0);
  assert.equal(user.role, role);
  assert.equal(user[identifierField], identifier);
  assert.ok(!("password_hash" in user), "must never expose password_hash");
  assert.ok(!("passwordHash" in user), "must never expose password hash");
  assert.ok(!("token" in user), "must never expose the raw token");
  assert.ok(!("session_token_hash" in user), "must never expose the token hash");
}

test("student login with valid credentials succeeds", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: userCreds.activeStudent.matricNumber,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: Record<string, unknown> };
  const setCookie = res.headers.getSetCookie();
  assert.ok(setCookie.length === 1, "a session cookie should be set");
  assert.ok(setCookie[0].includes("HttpOnly"), "cookie must be HttpOnly");
  assertSafeUser(body.user, "STUDENT", "matricNumber", userCreds.activeStudent.matricNumber);
});

test("student login with wrong password fails generically", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: userCreds.activeStudent.matricNumber,
    password: "totally-wrong-password",
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
  assert.equal(res.headers.getSetCookie().length, 0, "no cookie on failure");
});

test("student login with a nonexistent matric number fails generically", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: "AUTH/STU/DOES-NOT-EXIST",
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("inactive student cannot log in", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: userCreds.inactiveStudent.matricNumber,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("lecturer login with valid credentials succeeds", async () => {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId: userCreds.activeLecturer.staffId,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: Record<string, unknown> };
  assert.equal(res.headers.getSetCookie().length, 1);
  assertSafeUser(body.user, "LECTURER", "staffId", userCreds.activeLecturer.staffId);
});

test("lecturer login with wrong password fails", async () => {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId: userCreds.activeLecturer.staffId,
    password: "totally-wrong-password",
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("lecturer login with a nonexistent staff ID fails generically", async () => {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId: "AUTH/LEC/DOES-NOT-EXIST",
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("inactive lecturer cannot log in", async () => {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId: userCreds.inactiveLecturer.staffId,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("admin login with valid credentials succeeds", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: userCreds.activeAdmin.username,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: Record<string, unknown> };
  assertSafeUser(body.user, "ADMIN", "username", userCreds.activeAdmin.username);
});

test("admin login with wrong password fails", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: userCreds.activeAdmin.username,
    password: "totally-wrong-password",
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("admin login with a nonexistent username fails generically", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: "auth_admin_does_not_exist",
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("inactive admin cannot log in", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: userCreds.inactiveAdmin.username,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 401);
  assertGenericCredentialFailure(await res.json());
});

test("malformed login requests are rejected with INVALID_REQUEST", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: 12345,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "INVALID_REQUEST");
});

test("a role supplied by the client is ignored", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: userCreds.activeStudent.matricNumber,
    password: TEST_PASSWORD,
    role: "ADMIN",
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: Record<string, unknown> };
  assert.equal(body.user.role, "STUDENT", "role must come from the database");
});

test("successful login creates a database session and stores only the hash", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: userCreds.activeAdmin.username,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(res);
  assert.ok(token, "login should issue a session cookie");

  const count = await pool.query(
    `SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = $1`,
    [activeAdminId]
  );
  assert.ok(count.rows[0].c > 0, "a session row must be created");

  const stored = await pool.query(
    `SELECT session_token_hash FROM sessions
     WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [activeAdminId]
  );
  assert.notEqual(stored.rows[0].session_token_hash, token, "raw token must not be stored");
  assert.equal(stored.rows[0].session_token_hash, hashSessionToken(token));
});

test("GET /api/auth/me works with the session cookie", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: userCreds.activeLecturer.staffId,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await get("/api/auth/me", cookieHeader(token));

  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: Record<string, unknown> };
  assertSafeUser(body.user, "LECTURER", "staffId", userCreds.activeLecturer.staffId);
  assert.equal(body.user.id, activeLecturerId);
});

test("GET /api/auth/me requires authentication", async () => {
  const res = await get("/api/auth/me");

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal((body as { error: string }).error, "UNAUTHENTICATED");
});

test("a revoked session fails authentication", async () => {
  const login = await postJson("/api/auth/admin/login", {
    username: userCreds.activeAdmin.username,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [activeAdminId]
  );

  const res = await get("/api/auth/me", cookieHeader(token));
  assert.equal(res.status, 401);
});

test("an expired session fails authentication", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: userCreds.activeStudent.matricNumber,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  await pool.query(
    `UPDATE sessions
     SET expires_at = now() - ($2::text)::interval
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [activeStudentId, `${ONE_HOUR_MS} milliseconds`]
  );

  const res = await get("/api/auth/me", cookieHeader(token));
  assert.equal(res.status, 401);
});

test("logout revokes the session, keeps the row, and clears the cookie", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: userCreds.activeLecturer.staffId,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  const res = await postJson("/api/auth/logout", {}, cookieHeader(token));
  assert.equal(res.status, 200);

  const cleared = res.headers.getSetCookie();
  assert.ok(cleared.length === 1, "logout must clear the cookie");
  assert.ok(cleared[0].startsWith(`${authConfig.cookieName}=`));

  const stored = await pool.query(
    `SELECT revoked_at FROM sessions WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [activeLecturerId]
  );
  assert.ok(stored.rows[0], "session row must be retained for audit history");
  assert.ok(stored.rows[0].revoked_at, "session must be marked revoked");

  const afterLogout = await get("/api/auth/me", cookieHeader(token));
  assert.equal(afterLogout.status, 401, "revoked session must no longer work");
});

test("logout is safe and idempotent when already logged out", async () => {
  const noCookie = await postJson("/api/auth/logout", {});
  assert.equal(noCookie.status, 200);

  const bogusToken = await postJson("/api/auth/logout", {}, cookieHeader("not-a-real-session-token"));
  assert.equal(bogusToken.status, 200);
  assert.equal(bogusToken.headers.getSetCookie().length, 1, "cookie should still be cleared");
});

test("last_seen_at updates without extending expires_at", async () => {
  const login = await postJson("/api/auth/admin/login", {
    username: userCreds.activeAdmin.username,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);

  const before = await pool.query(
    `SELECT expires_at, last_seen_at FROM sessions
     WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [activeAdminId]
  );

  const me = await get("/api/auth/me", cookieHeader(token));
  assert.equal(me.status, 200);

  const afterUpdate = await pool.query(
    `SELECT expires_at, last_seen_at FROM sessions
     WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [activeAdminId]
  );

  assert.equal(
    Math.abs(afterUpdate.rows[0].expires_at.getTime() - before.rows[0].expires_at.getTime()) <= 5,
    true,
    "expires_at must not be extended by activity"
  );
  assert.ok(
    afterUpdate.rows[0].last_seen_at.getTime() >= before.rows[0].last_seen_at.getTime(),
    "last_seen_at should refresh"
  );
});

test("a deactivated account cannot keep using an existing session", async () => {
  const login = await postJson("/api/auth/lecturer/login", {
    staffId: userCreds.activeLecturer.staffId,
    password: TEST_PASSWORD,
  });
  const token = cookieFrom(login);
  assert.ok(token);

  await pool.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [
    activeLecturerId,
  ]);

  try {
    const res = await get("/api/auth/me", cookieHeader(token));
    assert.equal(res.status, 401, "deactivated user must be rejected");
  } finally {
    await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [
      activeLecturerId,
    ]);
  }
});

test("role middleware rejects unauthenticated users and wrong roles", async () => {
  const unauthenticated = await get("/api/test/admin-only");
  assert.equal(unauthenticated.status, 401);

  const studentLogin = await postJson("/api/auth/student/login", {
    matricNumber: userCreds.activeStudent.matricNumber,
    password: TEST_PASSWORD,
  });
  const studentToken = cookieFrom(studentLogin);

  const forbidden = await get("/api/test/admin-only", cookieHeader(studentToken!));
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as { error: string }).error, "FORBIDDEN");

  const adminLogin = await postJson("/api/auth/admin/login", {
    username: userCreds.activeAdmin.username,
    password: TEST_PASSWORD,
  });
  const adminToken = cookieFrom(adminLogin);

  const allowed = await get("/api/test/admin-only", cookieHeader(adminToken!));
  assert.equal(allowed.status, 200);
});