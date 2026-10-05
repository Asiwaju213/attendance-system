import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword, verifyPassword } from "../src/lib/passwords";
import { boundDeviceHeaders } from "./studentSessionTestHelpers";

/**
 * Focused coverage for lecturer account creation and the forced first-login password change.
 *
 * The two halves belong together: a created lecturer must be usable (the temporary password
 * authenticates) but must not be able to touch anything else until the password is replaced. Every
 * secret assertion here reads the database directly rather than trusting the API response.
 */

const FIXTURE_PASSWORD = "acct-fixture-password";
const CREATED_TEMP_PASSWORD = "temp-lecturer-password-1";
const CREATED_NEW_PASSWORD = "replacement-lecturer-password";
const ADMIN_USERNAME = "acct_admin";
const STUDENT_MATRIC = "ACCT/STU/1";
const EXISTING_STAFF_ID = "ACCT/LEC/EXISTING";
const CREATED_STAFF_PREFIX = "ACCT/LEC/";
const CREATED_NAME_PREFIX = "ACCT Created ";

let server: Server;
let baseUrl: string;
let passwordHash: string;
let depId = 0;
let adminUserId = 0;
let studentUserId = 0;
let existingLecturerUserId = 0;

function cookieFrom(res: globalThis.Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.cookieName}=`));
  assert.ok(cookie, "expected a session cookie");
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
): Promise<globalThis.Response> {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string, headers: Record<string, string> = {}): Promise<
  globalThis.Response
> {
  return fetch(baseUrl + path, { headers });
}

/** Read a JSON body once and assert on the error code inside it. */
async function assertJson(res: globalThis.Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(body && typeof body === "object");
  return body;
}

async function adminSessionToken(): Promise<string> {
  const res = await postJson("/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: FIXTURE_PASSWORD,
  });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

async function lecturerSessionToken(staffId: string, password: string): Promise<string> {
  const res = await postJson("/api/auth/lecturer/login", { staffId, password });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

async function createLecturerViaApi(
  adminToken: string,
  overrides: Record<string, unknown> = {}
): Promise<globalThis.Response> {
  return postJson(
    "/api/admin/lecturers",
    {
      staffId: `${CREATED_STAFF_PREFIX}NEW${String(Date.now()).slice(-4)}${Math.random()
        .toString(36)
        .slice(2, 5)}`,
      name: `${CREATED_NAME_PREFIX}Lecturer`,
      departmentId: depId,
      temporaryPassword: CREATED_TEMP_PASSWORD,
      ...overrides,
    },
    cookieHeader(adminToken)
  );
}

async function createdLecturerUser(staffId: string): Promise<{
  id: number;
  name: string;
  role: string;
  status: string;
  username: string | null;
  must_change_password: boolean;
  password_hash: string;
}> {
  const result = await pool.query(
    `SELECT u.id, u.name, u.role, u.status, u.username, u.must_change_password, u.password_hash
       FROM users u
       JOIN lecturers l ON l.user_id = u.id
      WHERE l.staff_id = $1`,
    [staffId]
  );
  assert.equal(result.rows.length, 1, `expected exactly one lecturer with staff id ${staffId}`);
  return result.rows[0];
}

/** Remove every lecturer this file created through the API. */
async function cleanupCreatedLecturers(): Promise<void> {
  const lecturers = await pool.query(
    `SELECT id, user_id FROM lecturers WHERE staff_id LIKE $1`,
    [`${CREATED_STAFF_PREFIX}%`]
  );
  const userIds = lecturers.rows.map((row) => Number(row.user_id));
  const lecturerIds = lecturers.rows.map((row) => Number(row.id));

  if (userIds.length > 0) {
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(
      `DELETE FROM audit_logs
        WHERE user_id = ANY($1::BIGINT[])
           OR (entity_type = 'users' AND entity_id = ANY($1::BIGINT[]))
           OR (entity_type = 'lecturers' AND entity_id = ANY($2::BIGINT[]))`,
      [userIds, lecturerIds]
    );
  }
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE $1`, [`${CREATED_STAFF_PREFIX}%`]);
  await pool.query(`DELETE FROM users WHERE name LIKE $1`, [`${CREATED_NAME_PREFIX}%`]);
}

before(async () => {
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    [adminUserId, studentUserId, existingLecturerUserId],
  ]);
  await cleanupCreatedLecturers();
  await pool.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = $1)`, [
    ADMIN_USERNAME,
  ]);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE username = $1)`, [
    ADMIN_USERNAME,
  ]);
  await pool.query(`DELETE FROM students WHERE matric_number = $1`, [STUDENT_MATRIC]);
  await pool.query(`DELETE FROM audit_logs
                     WHERE entity_id IN (
                       SELECT id FROM users
                        WHERE id IN (SELECT user_id FROM students WHERE matric_number = $1)
                     )`, [STUDENT_MATRIC]);
  await pool.query(`DELETE FROM lecturers WHERE staff_id = $1`, [EXISTING_STAFF_ID]);
  await pool.query(
    `DELETE FROM users
      WHERE username = $1
         OR id IN (
           SELECT user_id FROM students WHERE matric_number = $2
           UNION
           SELECT user_id FROM lecturers WHERE staff_id = $3
         )`,
    [ADMIN_USERNAME, STUDENT_MATRIC, EXISTING_STAFF_ID]
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ACCT%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ACCT%'`);

  passwordHash = await hashPassword(FIXTURE_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ACCT Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Account Test', 'ACCT-FAC') RETURNING id`
  );
  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Account Test Department', 'ACCT-DEP', $1)
     RETURNING id`,
    [Number(faculty.rows[0].id)]
  );
  depId = Number(department.rows[0].id);

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ACCT Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     SELECT $1, $2, $3, id FROM levels WHERE name = 100`,
    [studentUserId, STUDENT_MATRIC, depId]
  );

  const existingLecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ACCT Existing Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  existingLecturerUserId = Number(existingLecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id) VALUES ($1, $2, $3)`,
    [existingLecturerUserId, EXISTING_STAFF_ID, depId]
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

  await cleanupCreatedLecturers();
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    [adminUserId, studentUserId, existingLecturerUserId],
  ]);
  await pool.query(
    `DELETE FROM audit_logs
      WHERE user_id = ANY($1::BIGINT[])
         OR (entity_type = 'users' AND entity_id = ANY($1::BIGINT[]))
         OR (entity_type = 'lecturers' AND entity_id = ANY($2::BIGINT[]))`,
    [[adminUserId, studentUserId, existingLecturerUserId], [existingLecturerUserId]]
  );
  await pool.query(`DELETE FROM students WHERE matric_number = $1`, [STUDENT_MATRIC]);
  await pool.query(`DELETE FROM lecturers WHERE staff_id = $1`, [EXISTING_STAFF_ID]);
  await pool.query(
    `DELETE FROM users
      WHERE username = $1
         OR id IN (
           SELECT user_id FROM students WHERE matric_number = $2
           UNION
           SELECT user_id FROM lecturers WHERE staff_id = $3
         )`,
    [ADMIN_USERNAME, STUDENT_MATRIC, EXISTING_STAFF_ID]
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ACCT%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ACCT%'`);

  await pool.end();
});

test("creating a lecturer requires an admin session", async () => {
  const anonymous = await createLecturerViaApi("");
  assert.equal(anonymous.status, 401);

  const lecturerToken = await lecturerSessionToken(EXISTING_STAFF_ID, FIXTURE_PASSWORD);
  const asLecturer = await createLecturerViaApi(lecturerToken);
  assert.equal(asLecturer.status, 403);

  const studentLogin = await postJson(
    "/api/auth/student/login",
    { password: FIXTURE_PASSWORD },
    await boundDeviceHeaders(STUDENT_MATRIC)
  );
  assert.equal(studentLogin.status, 200);
  const asStudent = await createLecturerViaApi(cookieFrom(studentLogin));
  assert.equal(asStudent.status, 403);
});

test("a department listed by the admin departments API can be used to create a lecturer", async () => {
  const adminToken = await adminSessionToken();

  // Take the department straight from the endpoint that populates the admin dropdown, exactly as
  // the browser does. This is the contract the create form depends on: the id the admin selects is
  // the id the create endpoint must accept.
  const listRes = await getJson("/api/admin/departments", cookieHeader(adminToken));
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { data: Array<Record<string, unknown>> };
  const listed = listBody.data.find((entry) => entry.code === "CPE");
  assert.ok(listed, "expected the seeded CPE department to be listed");

  const listedId = listed?.id;
  assert.equal(typeof listedId, "number", "the listed department id must be a JSON number");
  assert.ok(Number.isInteger(listedId as number) && (listedId as number) > 0);

  const staffId = `${CREATED_STAFF_PREFIX}LISTED`;
  const res = await postJson(
    "/api/admin/lecturers",
    {
      staffId,
      name: `${CREATED_NAME_PREFIX}Listed`,
      departmentId: listedId,
      temporaryPassword: CREATED_TEMP_PASSWORD,
    },
    cookieHeader(adminToken)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.departmentId, listedId);
  assert.equal(body.data.departmentCode, "CPE");

  const stored = await createdLecturerUser(staffId);
  const profile = await pool.query(`SELECT department_id FROM lecturers WHERE staff_id = $1`, [
    staffId,
  ]);
  assert.equal(Number(profile.rows[0].department_id), listedId);
  assert.ok(stored.id > 0);
});

test("a department id sent as a digit string is the same department as the number", async () => {
  // A <select> value is a string, and every other admin endpoint (departments, students, course
  // offerings) normalizes it through `parseIdParam`. Lecturer creation must accept the identical
  // id rather than failing on its JSON type.
  const adminToken = await adminSessionToken();
  const listRes = await getJson("/api/admin/departments", cookieHeader(adminToken));
  const listBody = (await listRes.json()) as { data: Array<Record<string, unknown>> };
  const listed = listBody.data.find((entry) => entry.code === "CPE");
  assert.ok(listed);
  const listedId = Number(listed?.id);

  const staffId = `${CREATED_STAFF_PREFIX}STRINGID`;
  const res = await postJson(
    "/api/admin/lecturers",
    {
      staffId,
      name: `${CREATED_NAME_PREFIX}StringId`,
      departmentId: String(listedId),
      temporaryPassword: CREATED_TEMP_PASSWORD,
    },
    cookieHeader(adminToken)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.departmentId, listedId);

  const profile = await pool.query(`SELECT department_id FROM lecturers WHERE staff_id = $1`, [
    staffId,
  ]);
  assert.equal(Number(profile.rows[0].department_id), listedId);
});

test("a department id that is not a positive integer is still rejected", async () => {
  const adminToken = await adminSessionToken();
  const payload = {
    staffId: `${CREATED_STAFF_PREFIX}BADID`,
    name: `${CREATED_NAME_PREFIX}BadId`,
    temporaryPassword: CREATED_TEMP_PASSWORD,
  };

  for (const departmentId of ["not-a-number", "12abc", "", -1, 0, 1.5, null, true, {}]) {
    const res = await postJson(
      "/api/admin/lecturers",
      { ...payload, departmentId },
      cookieHeader(adminToken)
    );
    assert.equal(res.status, 400, `expected 400 for departmentId ${JSON.stringify(departmentId)}`);
    assert.equal((await assertJson(res)).error, "INVALID_REQUEST");
  }

  const orphans = await pool.query(
    `SELECT count(*)::int AS count FROM lecturers WHERE staff_id = $1`,
    [`${CREATED_STAFF_PREFIX}BADID`]
  );
  assert.equal(orphans.rows[0].count, 0);
});

test("a created lecturer gets an ACTIVE LECTURER account with a forced change and an argon2id hash", async () => {
  const adminToken = await adminSessionToken();
  const res = await createLecturerViaApi(adminToken, {
    staffId: `${CREATED_STAFF_PREFIX}FORCED`,
    name: `${CREATED_NAME_PREFIX}Forced`,
  });
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.temporaryPassword, CREATED_TEMP_PASSWORD);
  const data = body.data as Record<string, unknown>;
  assert.equal(data.staffId, `${CREATED_STAFF_PREFIX}FORCED`);
  assert.equal(data.name, `${CREATED_NAME_PREFIX}Forced`);
  assert.equal(data.departmentId, depId);
  assert.equal(data.status, "ACTIVE");
  assert.equal(data.mustChangePassword, true);

  const stored = await createdLecturerUser(`${CREATED_STAFF_PREFIX}FORCED`);
  assert.equal(stored.role, "LECTURER");
  assert.equal(stored.status, "ACTIVE");
  assert.equal(stored.username, null, "lecturers sign in with their staff ID, not a username");
  assert.equal(stored.must_change_password, true);
  assert.match(stored.password_hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(stored.password_hash, CREATED_TEMP_PASSWORD), true);
  assert.equal(
    stored.password_hash.includes(CREATED_TEMP_PASSWORD),
    false,
    "the stored hash must not contain the plaintext password"
  );

  const profile = await pool.query(
    `SELECT l.department_id, l.staff_id, u.name
       FROM lecturers l
       JOIN users u ON u.id = l.user_id
      WHERE l.staff_id = $1`,
    [`${CREATED_STAFF_PREFIX}FORCED`]
  );
  assert.equal(Number(profile.rows[0].department_id), depId);
  assert.equal(profile.rows[0].name, `${CREATED_NAME_PREFIX}Forced`);

  const audit = await pool.query(
    `SELECT action, description FROM audit_logs
      WHERE user_id = $1 OR (entity_type = 'users' AND entity_id = $1)
      ORDER BY id`,
    [stored.id]
  );
  assert.ok(
    audit.rows.some(
      (row) =>
        row.action === "LECTURER_ACCOUNT_CREATED" &&
        typeof row.description === "string" &&
        row.description.includes(`${CREATED_STAFF_PREFIX}FORCED`)
    ),
    "expected a LECTURER_ACCOUNT_CREATED audit row naming the lecturer"
  );
  const auditText = JSON.stringify(audit.rows);
  assert.equal(
    auditText.includes(CREATED_TEMP_PASSWORD),
    false,
    "the audit trail must not store the password"
  );
  assert.equal(auditText.includes(stored.password_hash), false, "no hash in the audit trail");
  assert.equal(auditText.includes("$argon2"), false);
});

test("rejects unknown fields, short passwords and unknown departments", async () => {
  const adminToken = await adminSessionToken();

  const withExtraField = await createLecturerViaApi(adminToken, {
    staffId: `${CREATED_STAFF_PREFIX}EXTRA`,
    mustChangePassword: false,
  });
  assert.equal(withExtraField.status, 400);
  assert.equal((await assertJson(withExtraField)).error, "INVALID_REQUEST");

  const withShortPassword = await createLecturerViaApi(adminToken, {
    staffId: `${CREATED_STAFF_PREFIX}SHORT`,
    temporaryPassword: "short",
  });
  assert.equal(withShortPassword.status, 400);

  const withUnknownDepartment = await createLecturerViaApi(adminToken, {
    staffId: `${CREATED_STAFF_PREFIX}NODEP`,
    departmentId: depId + 999999,
  });
  assert.equal(withUnknownDepartment.status, 404);
  assert.equal((await assertJson(withUnknownDepartment)).error, "DEPARTMENT_NOT_FOUND");

  const orphanRows = await pool.query(
    `SELECT count(*)::int AS count FROM lecturers WHERE staff_id = ANY($1::TEXT[])`,
    [[`${CREATED_STAFF_PREFIX}EXTRA`, `${CREATED_STAFF_PREFIX}SHORT`, `${CREATED_STAFF_PREFIX}NODEP`]]
  );
  assert.equal(orphanRows.rows[0].count, 0, "a rejected request must not create a lecturer");
});

test("rejects a duplicate staff ID without creating a second account", async () => {
  const adminToken = await adminSessionToken();
  const staffId = `${CREATED_STAFF_PREFIX}DUP`;
  const first = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(first.status, 201);
  await first.json();

  const second = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(second.status, 409);
  assert.equal((await assertJson(second)).error, "CONFLICT");

  const rows = await pool.query(
    `SELECT count(*)::int AS count FROM lecturers WHERE staff_id = $1`,
    [staffId]
  );
  assert.equal(rows.rows[0].count, 1);
});

test("the lecturer list never exposes credential material", async () => {
  const adminToken = await adminSessionToken();
  const staffId = `${CREATED_STAFF_PREFIX}LIST`;
  const created = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(created.status, 201);
  await created.json();

  const res = await getJson("/api/admin/lecturers", cookieHeader(adminToken));
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.equal(raw.includes(CREATED_TEMP_PASSWORD), false, "the list must not echo the password");
  assert.equal(raw.includes("passwordHash"), false);
  assert.equal(raw.includes("password_hash"), false);

  const body = JSON.parse(raw) as { data: Array<Record<string, unknown>> };
  const row = body.data.find((entry) => entry.staffId === staffId);
  assert.ok(row, "the new lecturer should appear in the list");
  // The pending-change flag is fine to show an administrator; credential material is not.
  assert.equal(row?.mustChangePassword, true);
  assert.equal(row?.password, undefined);
  assert.equal(row?.passwordHash, undefined);
});

test("login with the temporary password succeeds and reports the pending change", async () => {
  const adminToken = await adminSessionToken();
  const staffId = `${CREATED_STAFF_PREFIX}LOGIN`;
  const created = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(created.status, 201);
  await created.json();

  const login = await postJson("/api/auth/lecturer/login", {
    staffId,
    password: CREATED_TEMP_PASSWORD,
  });
  assert.equal(login.status, 200);
  const raw = await login.text();
  assert.equal(raw.includes(CREATED_TEMP_PASSWORD), false, "login must not echo the password");
  const body = JSON.parse(raw) as { user: Record<string, unknown> };
  assert.equal(body.user.role, "LECTURER");
  assert.equal(body.user.mustChangePassword, true);
  assert.equal(body.user.password, undefined);
  assert.equal(body.user.passwordHash, undefined);
});

test("a lecturer who still owes a password change is blocked from every other API", async () => {
  const adminToken = await adminSessionToken();
  const staffId = `${CREATED_STAFF_PREFIX}BLOCKED`;
  const created = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(created.status, 201);
  await created.json();

  const token = await lecturerSessionToken(staffId, CREATED_TEMP_PASSWORD);

  const me = await getJson("/api/auth/me", cookieHeader(token));
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { user: Record<string, unknown> }).user.mustChangePassword, true);

  const ownRole = await getJson("/api/lecturer/locations", cookieHeader(token));
  assert.equal(ownRole.status, 403);
  assert.equal((await assertJson(ownRole)).error, "PASSWORD_CHANGE_REQUIRED");

  const asAdmin = await getJson("/api/admin/departments", cookieHeader(token));
  assert.equal(asAdmin.status, 403);
  assert.equal((await assertJson(asAdmin)).error, "PASSWORD_CHANGE_REQUIRED");

  const asStudent = await getJson("/api/student/attendance/history", cookieHeader(token));
  assert.equal(asStudent.status, 403);
  assert.equal((await assertJson(asStudent)).error, "PASSWORD_CHANGE_REQUIRED");

  const anonymousAdmin = await getJson("/api/admin/departments");
  assert.equal(anonymousAdmin.status, 401, "the guard must not weaken anonymous handling");
});

test("the password change rejects a wrong current password and leaves the account pending", async () => {
  const adminToken = await adminSessionToken();
  const staffId = `${CREATED_STAFF_PREFIX}WRONGCUR`;
  const created = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(created.status, 201);
  await created.json();
  const token = await lecturerSessionToken(staffId, CREATED_TEMP_PASSWORD);

  const res = await postJson(
    "/api/auth/change-password",
    {
      currentPassword: `${CREATED_TEMP_PASSWORD}-wrong`,
      newPassword: CREATED_NEW_PASSWORD,
      confirmPassword: CREATED_NEW_PASSWORD,
    },
    cookieHeader(token)
  );
  assert.equal(res.status, 401);
  assert.equal((await assertJson(res)).error, "CURRENT_PASSWORD_INVALID");

  const stored = await createdLecturerUser(staffId);
  assert.equal(stored.must_change_password, true);
  assert.equal(await verifyPassword(stored.password_hash, CREATED_TEMP_PASSWORD), true);
});

test("the password change validates the new password and confirmation", async () => {
  const adminToken = await adminSessionToken();
  const staffId = `${CREATED_STAFF_PREFIX}VALIDATE`;
  const created = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(created.status, 201);
  await created.json();
  const token = await lecturerSessionToken(staffId, CREATED_TEMP_PASSWORD);

  const tooShort = await postJson(
    "/api/auth/change-password",
    { currentPassword: CREATED_TEMP_PASSWORD, newPassword: "short", confirmPassword: "short" },
    cookieHeader(token)
  );
  assert.equal(tooShort.status, 400);

  const mismatch = await postJson(
    "/api/auth/change-password",
    {
      currentPassword: CREATED_TEMP_PASSWORD,
      newPassword: CREATED_NEW_PASSWORD,
      confirmPassword: `${CREATED_NEW_PASSWORD}-different`,
    },
    cookieHeader(token)
  );
  assert.equal(mismatch.status, 400);
  assert.equal((await assertJson(mismatch)).error, "INVALID_REQUEST");

  const unchanged = await postJson(
    "/api/auth/change-password",
    {
      currentPassword: CREATED_TEMP_PASSWORD,
      newPassword: CREATED_TEMP_PASSWORD,
      confirmPassword: CREATED_TEMP_PASSWORD,
    },
    cookieHeader(token)
  );
  assert.equal(unchanged.status, 400);
  assert.equal((await assertJson(unchanged)).error, "PASSWORD_UNCHANGED");

  const withExtraField = await postJson(
    "/api/auth/change-password",
    {
      currentPassword: CREATED_TEMP_PASSWORD,
      newPassword: CREATED_NEW_PASSWORD,
      confirmPassword: CREATED_NEW_PASSWORD,
      role: "ADMIN",
    },
    cookieHeader(token)
  );
  assert.equal(withExtraField.status, 400);
});

test("the password change is refused for an account that owes nothing and for non-lecturers", async () => {
  const existingToken = await lecturerSessionToken(EXISTING_STAFF_ID, FIXTURE_PASSWORD);
  const notRequired = await postJson(
    "/api/auth/change-password",
    {
      currentPassword: FIXTURE_PASSWORD,
      newPassword: `${CREATED_NEW_PASSWORD}-x`,
      confirmPassword: `${CREATED_NEW_PASSWORD}-x`,
    },
    cookieHeader(existingToken)
  );
  assert.equal(notRequired.status, 409);
  assert.equal((await assertJson(notRequired)).error, "PASSWORD_CHANGE_NOT_REQUIRED");

  const adminToken = await adminSessionToken();
  const asAdmin = await postJson(
    "/api/auth/change-password",
    {
      currentPassword: FIXTURE_PASSWORD,
      newPassword: `${CREATED_NEW_PASSWORD}-y`,
      confirmPassword: `${CREATED_NEW_PASSWORD}-y`,
    },
    cookieHeader(adminToken)
  );
  assert.equal(asAdmin.status, 403);
});

test("a successful change clears the flag, replaces the hash, revokes other sessions and unblocks the account", async () => {
  const adminToken = await adminSessionToken();
  const staffId = `${CREATED_STAFF_PREFIX}HAPPY`;
  const created = await createLecturerViaApi(adminToken, { staffId });
  assert.equal(created.status, 201);
  await created.json();

  const token = await lecturerSessionToken(staffId, CREATED_TEMP_PASSWORD);
  const secondToken = await lecturerSessionToken(staffId, CREATED_TEMP_PASSWORD);

  const res = await postJson(
    "/api/auth/change-password",
    {
      currentPassword: CREATED_TEMP_PASSWORD,
      newPassword: CREATED_NEW_PASSWORD,
      confirmPassword: CREATED_NEW_PASSWORD,
    },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);

  const stored = await createdLecturerUser(staffId);
  assert.equal(stored.must_change_password, false);
  assert.equal(await verifyPassword(stored.password_hash, CREATED_NEW_PASSWORD), true);
  assert.equal(await verifyPassword(stored.password_hash, CREATED_TEMP_PASSWORD), false);
  assert.equal(stored.password_hash.includes(CREATED_NEW_PASSWORD), false);

  const oldPasswordLogin = await postJson("/api/auth/lecturer/login", {
    staffId,
    password: CREATED_TEMP_PASSWORD,
  });
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await postJson("/api/auth/lecturer/login", {
    staffId,
    password: CREATED_NEW_PASSWORD,
  });
  assert.equal(newPasswordLogin.status, 200);
  assert.equal(
    ((await newPasswordLogin.json()) as { user: Record<string, unknown> }).user.mustChangePassword,
    false
  );

  // The session that performed the change stays usable; the other one was revoked.
  const stillBlocked = await getJson("/api/lecturer/locations", cookieHeader(secondToken));
  assert.equal(stillBlocked.status, 401, "other sessions must be revoked by the change");

  const unblocked = await getJson("/api/lecturer/locations", cookieHeader(token));
  assert.equal(unblocked.status, 200);

  const me = await getJson("/api/auth/me", cookieHeader(token));
  assert.equal(((await me.json()) as { user: Record<string, unknown> }).user.mustChangePassword, false);

  const audit = await pool.query(
    `SELECT action, description FROM audit_logs WHERE user_id = $1 ORDER BY id`,
    [stored.id]
  );
  assert.ok(
    audit.rows.some(
      (row) =>
        row.action === "PASSWORD_CHANGED" &&
        typeof row.description === "string" &&
        !row.description.includes(CREATED_TEMP_PASSWORD) &&
        !row.description.includes(CREATED_NEW_PASSWORD)
    ),
    "expected a PASSWORD_CHANGED audit row without secrets"
  );
});
