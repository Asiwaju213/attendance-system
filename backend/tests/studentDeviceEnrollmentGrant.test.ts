import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { readEnrollmentGrantForStudent } from "../src/services/studentDeviceEnrollmentGrantStore";
import { resetStudentDeviceLoginLimiters } from "../src/services/studentDeviceLoginService";
import { createSession } from "../src/services/sessionStore";
import { generateSessionToken } from "../src/lib/sessions";
import {
  buildRegistrationResponse,
  createTestAuthenticator,
  type TestAuthenticator,
} from "./webauthnTestHelpers";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

/**
 * Enrollment-grant lifecycle.
 *
 * A matric number + password is not a session. It either produces an enrollment grant (no ACTIVE
 * device yet) or is refused outright (an ACTIVE device exists and only an admin can replace it).
 * These tests pin that contract, the narrow scope of a grant, its single-use and expiry rules, and
 * the admin-reset path that eventually lets a student enroll again.
 */

const TEST_PASSWORD = "grant-test-password";
const RUN_ID = Date.now().toString(36).toUpperCase();

let server: Server;
let baseUrl: string;
let departmentId: number;
let levelId: number;

interface TestUser {
  userId: number;
  studentId: number;
  matric: string;
  name: string;
}

let fresh: TestUser; // no device at all -> the first-device flow
let enrolled: TestUser; // given an ACTIVE device -> the replacement-refusal flow
let other: TestUser; // a second no-device account, used to prove grants are student-bound
let adminUserId = 0;

/**
 * Every account this file creates, by user id.
 *
 * Tracked separately from the fixture objects so cleanup does not depend on them having been
 * assigned: if `before` fails part-way, the accounts it did create still get removed.
 */
const accountIds: number[] = [];

/** Sessions minted directly for the accounts that need one (the admin). */
const sessionTokens: Record<number, string> = {};

const postJson = async (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const getJson = (path: string, headers: Record<string, string> = {}) =>
  fetch(baseUrl + path, { headers });

/** Read a cookie's value out of a Set-Cookie header list. */
function cookieValue(setCookies: string[], name: string): string | undefined {
  const hit = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!hit) {
    return undefined;
  }
  const end = hit.indexOf(";");
  return hit.slice(hit.indexOf("=") + 1, end === -1 ? undefined : end);
}

const grantHeader = (token: string): Record<string, string> => ({
  cookie: `${authConfig.enrollmentGrantCookieName}=${token}`,
});

const sessionHeader = (userId: number): Record<string, string> => ({
  cookie: `${authConfig.cookieName}=${sessionTokens[userId]}`,
});

/** Drive a full first-device WebAuthn ceremony using the enrollment grant. */
async function enrollFirstDevice(
  grantToken: string
): Promise<{ credentialId: string; response: Response }> {
  const optionsRes = await postJson(
    "/api/student/device/enrollment/options",
    {},
    grantHeader(grantToken)
  );
  assert.equal(optionsRes.status, 200, "a valid grant must open the enrollment ceremony");

  const optionsBody = (await optionsRes.json()) as {
    data: { challenge: string };
    enrollmentMode: string;
  };
  assert.equal(optionsBody.enrollmentMode, "ENROLL");

  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: optionsBody.data.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const response = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    grantHeader(grantToken)
  );
  // `credential.id` is the base64url credential id the server records.
  return { credentialId: credential.id, response };
}

beforeEach(() => {
  // This file logs in repeatedly for the same students on purpose. Reset the student-login
  // rate limiter so a test is never throttled by an earlier one.
  resetStudentDeviceLoginLimiters();
});

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  await pool.query(
    `INSERT INTO faculties (name, code)
     VALUES ('Grant Fac', 'GRANDFAC')
     ON CONFLICT (code) DO NOTHING`
  );
  const facultyId = Number(
    (await pool.query(`SELECT id FROM faculties WHERE code = 'GRANDFAC'`)).rows[0].id
  );

  await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Grant Dept', 'GRAND', $1)
     ON CONFLICT (code) DO NOTHING`,
    [facultyId]
  );
  departmentId = Number(
    (await pool.query(`SELECT id FROM departments WHERE code = 'GRAND'`)).rows[0].id
  );

  // Levels are seeded by the project migrations; reuse one rather than inventing a row.
  levelId = Number(
    (await pool.query(`SELECT id FROM levels WHERE name = 100`)).rows[0].id
  );

  const passwordHash = await hashPassword(TEST_PASSWORD);

  const makeStudent = async (label: string): Promise<TestUser> => {
    const matric = `${label}/${RUN_ID}`;
    const user = await pool.query(
      `INSERT INTO users (name, password_hash, role, status)
       VALUES ($1, $2, 'STUDENT', 'ACTIVE') RETURNING id`,
      [`Grant ${label}`, passwordHash]
    );
    const student = await pool.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.rows[0].id, matric, departmentId, levelId]
    );
    accountIds.push(Number(user.rows[0].id));
    return {
      userId: Number(user.rows[0].id),
      studentId: Number(student.rows[0].id),
      matric,
      name: `Grant ${label}`,
    };
  };

  fresh = await makeStudent("Fresh");
  enrolled = await makeStudent("Enrolled");
  other = await makeStudent("Other");

  const admin = await pool.query(
    `INSERT INTO users (name, username, password_hash, role, status)
     VALUES ('Grant Admin', $1, $2, 'ADMIN', 'ACTIVE') RETURNING id`,
    [`grant_admin_${RUN_ID}`, passwordHash]
  );
  adminUserId = Number(admin.rows[0].id);
  accountIds.push(adminUserId);
  const adminToken = generateSessionToken();
  await createSession(
    adminUserId,
    hashSessionToken(adminToken),
    new Date(Date.now() + 3_600_000)
  );
  sessionTokens[adminUserId] = adminToken;

  // Give `enrolled` a real, ACTIVE, discoverable device so the replacement-refusal path is
  // exercised against a genuine credential rather than a fixture row.
  const credentialId = `grant-enrolled-${RUN_ID}`;
  await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, status, discoverable)
     VALUES ($1, $2, $3, 1, 'ACTIVE', TRUE)`,
    [enrolled.studentId, credentialId, Buffer.from([0xa0, 0x01])]
  );
});

after(async () => {
  // Clean up whatever accounts were created, and never let a cleanup error skip `pool.end()`:
  // an unclosed pool keeps the process alive, so a failure would look like a hang.
  try {
    if (accountIds.length > 0) {
      await pool.query(
        `DELETE FROM student_device_enrollment_challenges
          WHERE student_id IN (SELECT id FROM students WHERE user_id = ANY($1::BIGINT[]))`,
        [accountIds]
      );
      // Grants are ON DELETE RESTRICT against students, so they must go first.
      await pool.query(
        `DELETE FROM student_device_enrollment_grants
          WHERE student_id IN (SELECT id FROM students WHERE user_id = ANY($1::BIGINT[]))`,
        [accountIds]
      );
      await pool.query(
        `DELETE FROM student_devices
          WHERE student_id IN (SELECT id FROM students WHERE user_id = ANY($1::BIGINT[]))`,
        [accountIds]
      );
      await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
        accountIds,
      ]);
      await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
        accountIds,
      ]);
      await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [accountIds]);
    }
    await pool.query(`DELETE FROM departments WHERE code = 'GRAND'`);
    await pool.query(`DELETE FROM faculties WHERE code = 'GRANDFAC'`);
  } finally {
    await pool.end();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

// ---------------------------------------------------------------------------
// 1. A password alone never opens a session
// ---------------------------------------------------------------------------

test("GRANT: correct credentials with no ACTIVE device return a grant and no session", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enrollmentRequired: true });

  const setCookies = res.headers.getSetCookie();
  assert.equal(
    setCookies.filter((c) => c.startsWith(`${authConfig.cookieName}=`)).length,
    0,
    "no session cookie may be issued before a device is enrolled"
  );

  const grant = cookieValue(setCookies, authConfig.enrollmentGrantCookieName);
  assert.ok(grant, "an enrollment grant cookie must be issued");
  assert.ok(grant.length >= 32, "the grant must carry real entropy");

  const grantCookie = setCookies.find((c) =>
    c.startsWith(`${authConfig.enrollmentGrantCookieName}=`)
  )!;
  assert.ok(grantCookie.includes("HttpOnly"), "the grant cookie must be HttpOnly");
  assert.ok(grantCookie.includes("SameSite=Lax"), "the grant cookie must be SameSite=Lax");
  assert.ok(
    !/Domain=/i.test(grantCookie),
    "the grant cookie must be host-only so it is not shared across subdomains"
  );

  const stored = await readEnrollmentGrantForStudent(fresh.studentId);
  assert.equal(stored?.status, "ACTIVE");
  assert.equal(stored?.consumedAt, null);

  // The raw token is never persisted; only its SHA-256 hash is.
  const row = await pool.query(
    `SELECT grant_hash FROM student_device_enrollment_grants WHERE student_id = $1`,
    [fresh.studentId]
  );
  assert.equal(row.rows[0].grant_hash, hashSessionToken(grant));
  assert.notEqual(row.rows[0].grant_hash, grant);
});

test("GRANT: a wrong password does not produce a grant", async () => {
  const before = await readEnrollmentGrantForStudent(fresh.studentId);

  const res = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: `${TEST_PASSWORD}-wrong`,
  });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "INVALID_CREDENTIALS" });
  assert.equal(
    res.headers
      .getSetCookie()
      .filter((c) => c.startsWith(`${authConfig.enrollmentGrantCookieName}=`))
      .length,
    0,
    "a failed login must not issue a grant"
  );

  const after = await readEnrollmentGrantForStudent(fresh.studentId);
  assert.equal(after?.createdAt.getTime(), before?.createdAt.getTime());
});

// ---------------------------------------------------------------------------
// 2. A grant is narrow: enrollment only
// ---------------------------------------------------------------------------

test("GRANT: a grant authorizes the enrollment endpoints", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });
  const grant = cookieValue(login.headers.getSetCookie(), authConfig.enrollmentGrantCookieName)!;

  const status = await getJson("/api/student/device", grantHeader(grant));
  assert.equal(status.status, 200);
  const body = (await status.json()) as { enrollmentMode: string; device: unknown };
  assert.equal(body.enrollmentMode, "ENROLL", "a student with no device needs to enroll");
  assert.equal(body.device, null);

  const options = await postJson(
    "/api/student/device/enrollment/options",
    {},
    grantHeader(grant)
  );
  assert.equal(options.status, 200);
});

test("GRANT: a grant is rejected by every non-enrollment student API", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });
  const grant = cookieValue(login.headers.getSetCookie(), authConfig.enrollmentGrantCookieName)!;

  for (const path of [
    "/api/auth/me",
    "/api/student/attendance/history",
    "/api/student/courses",
    "/api/student/attendance/device-challenge",
  ]) {
    const res = await getJson(path, grantHeader(grant));
    assert.equal(res.status, 401, `${path} must not accept an enrollment grant`);
  }
});

test("GRANT: a grant does not authenticate the lecturer or admin login", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });
  const grant = cookieValue(login.headers.getSetCookie(), authConfig.enrollmentGrantCookieName)!;

  const res = await postJson(
    "/api/auth/lecturer/login",
    { staffId: grant, password: TEST_PASSWORD },
    grantHeader(grant)
  );
  assert.equal(res.status, 401);
});

test("GRANT: an unknown or malformed grant is refused", async () => {
  for (const token of ["", "   ", "not-a-real-grant", "a".repeat(64)]) {
    const res = await getJson("/api/student/device", grantHeader(token));
    assert.equal(res.status, 401, `grant "${token}" must not be accepted`);
  }
});

// ---------------------------------------------------------------------------
// 3. Grants are single-use and time-bounded
// ---------------------------------------------------------------------------

test("GRANT: a second login supersedes the previous grant", async () => {
  const first = await postJson("/api/auth/student/login", {
    matricNumber: other.matric,
    password: TEST_PASSWORD,
  });
  const firstGrant = cookieValue(
    first.headers.getSetCookie(),
    authConfig.enrollmentGrantCookieName
  )!;

  const second = await postJson("/api/auth/student/login", {
    matricNumber: other.matric,
    password: TEST_PASSWORD,
  });
  const secondGrant = cookieValue(
    second.headers.getSetCookie(),
    authConfig.enrollmentGrantCookieName
  )!;

  assert.notEqual(firstGrant, secondGrant);

  // The superseded grant is dead; only the newest one works.
  const stale = await getJson("/api/student/device", grantHeader(firstGrant));
  assert.equal(stale.status, 401, "a superseded grant must stop working");

  const live = await getJson("/api/student/device", grantHeader(secondGrant));
  assert.equal(live.status, 200);

  const rows = await pool.query(
    `SELECT status FROM student_device_enrollment_grants
      WHERE student_id = $1 ORDER BY id`,
    [other.studentId]
  );
  assert.ok(
    rows.rows.some((r: { status: string }) => r.status === "EXPIRED"),
    "the superseded grant must be marked EXPIRED"
  );
  assert.ok(
    rows.rows.some((r: { status: string }) => r.status === "ACTIVE"),
    "exactly one grant stays ACTIVE"
  );
});

test("GRANT: an expired grant cannot open the ceremony", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: other.matric,
    password: TEST_PASSWORD,
  });
  const grant = cookieValue(login.headers.getSetCookie(), authConfig.enrollmentGrantCookieName)!;

  await pool.query(
    `UPDATE student_device_enrollment_grants
        SET expires_at = now() - interval '1 minute'
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [other.studentId]
  );

  const status = await getJson("/api/student/device", grantHeader(grant));
  assert.equal(status.status, 401, "an expired grant must be refused");

  const options = await postJson(
    "/api/student/device/enrollment/options",
    {},
    grantHeader(grant)
  );
  assert.equal(options.status, 401, "an expired grant must not open enrollment");
});

test("GRANT: the grant carries a bounded lifetime", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: other.matric,
    password: TEST_PASSWORD,
  });
  const grantCookie = login.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.enrollmentGrantCookieName}=`))!;

  // Server-side ceiling, independent of anything the client honours.
  const stored = await readEnrollmentGrantForStudent(other.studentId);
  const lifetimeMs = stored!.expiresAt.getTime() - stored!.createdAt.getTime();
  // `now()` is evaluated per statement, so allow a small tolerance for rounding.
  assert.ok(
    Math.abs(lifetimeMs - authConfig.enrollmentGrantLifetimeMs) < 1000,
    `grant lifetime should be ${authConfig.enrollmentGrantLifetimeMs}ms, got ${lifetimeMs}`
  );
  assert.ok(
    lifetimeMs <= 10 * 60 * 1000,
    "an enrollment grant must not outlive ten minutes"
  );

  // And the cookie itself must not be long-lived.
  const maxAge = /Max-Age=(\d+)/i.exec(grantCookie);
  assert.ok(maxAge, "the grant cookie must carry a Max-Age");
  assert.ok(
    Number(maxAge[1]) * 1000 <= 10 * 60 * 1000,
    "the grant cookie must expire within ten minutes"
  );
});

// ---------------------------------------------------------------------------
// 4. Completing enrollment spends the grant and mints the session
// ---------------------------------------------------------------------------

test("GRANT: completing enrollment spends the grant, binds the device and creates the session", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });
  const grant = cookieValue(login.headers.getSetCookie(), authConfig.enrollmentGrantCookieName)!;

  const { credentialId, response } = await enrollFirstDevice(grant);
  assert.equal(response.status, 201);
  const body = (await response.json()) as { sessionCreated?: boolean };
  assert.equal(body.sessionCreated, true);

  const setCookies = response.headers.getSetCookie();
  const session = cookieValue(setCookies, authConfig.cookieName);
  assert.ok(session, "a session must be minted once the device is genuinely registered");
  const binding = cookieValue(setCookies, authConfig.deviceBindingCookieName);
  assert.ok(binding, "the device-binding cookie must be set");
  assert.equal(
    cookieValue(setCookies, authConfig.enrollmentGrantCookieName),
    "",
    "the spent grant cookie must be cleared, not re-issued"
  );

  // Exactly one device, and it is the credential this file registered.
  const devices = await pool.query(
    `SELECT credential_id, status, discoverable FROM student_devices WHERE student_id = $1`,
    [fresh.studentId]
  );
  assert.equal(devices.rowCount, 1);
  assert.equal(
    devices.rows[0].credential_id,
    credentialId,
    "the stored credential must be the one this ceremony registered"
  );
  assert.equal(devices.rows[0].status, "ACTIVE");
  assert.equal(devices.rows[0].discoverable, true);

  const stored = await readEnrollmentGrantForStudent(fresh.studentId);
  assert.equal(stored?.status, "USED");
  assert.ok(stored?.consumedAt instanceof Date, "consumption must be timestamped");

  // The new session works, and the spent grant does not.
  const me = await getJson("/api/auth/me", { cookie: `${authConfig.cookieName}=${session}` });
  assert.equal(me.status, 200);
  const replay = await getJson("/api/student/device", grantHeader(grant));
  assert.equal(replay.status, 401, "a spent grant must not be replayable");
});

test("GRANT: a second enrollment attempt with the same grant fails", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });
  // `fresh` now has an ACTIVE device, so this is the refusal path rather than a new grant.
  assert.equal(login.status, 409);

  const grant = cookieValue(login.headers.getSetCookie(), authConfig.enrollmentGrantCookieName);
  if (grant !== undefined && grant !== "") {
    const res = await getJson("/api/student/device", grantHeader(grant));
    assert.equal(res.status, 401);
  }
});

// ---------------------------------------------------------------------------
// 5. An ACTIVE device is never replaced without an admin reset
// ---------------------------------------------------------------------------

test("GRANT: correct credentials are refused while an ACTIVE device exists", async () => {
  const res = await postJson("/api/auth/student/login", {
    matricNumber: enrolled.matric,
    password: TEST_PASSWORD,
  });

  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, "DEVICE_ALREADY_ENROLLED");
  // The message must point the student at an administrator without leaking device internals.
  assert.match(body.message, /administrator|admin/i);
  assert.ok(!/credential/i.test(body.message), "no credential internals may be exposed");
  assert.ok(!/webauthn|passkey/i.test(body.message), "no WebAuthn internals may be exposed");

  const setCookies = res.headers.getSetCookie();
  assert.equal(
    setCookies.filter((c) => c.startsWith(`${authConfig.cookieName}=`)).length,
    0,
    "no session may be issued from a password alone"
  );

  // The existing device is untouched and still authoritative.
  const devices = await pool.query(
    `SELECT credential_id, status FROM student_devices WHERE student_id = $1`,
    [enrolled.studentId]
  );
  assert.equal(devices.rowCount, 1);
  assert.equal(devices.rows[0].status, "ACTIVE");
  assert.equal(
    devices.rows[0].credential_id,
    `grant-enrolled-${RUN_ID}`,
    "the enrolled credential must not be replaced"
  );

  const grants = await pool.query(
    `SELECT count(*)::int AS n FROM student_device_enrollment_grants
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [enrolled.studentId]
  );
  assert.equal(grants.rows[0].n, 0, "no replacement grant may exist for an enrolled student");
});

test("GRANT: a bound device can still log in with the password", async () => {
  const res = await postJson(
    "/api/auth/student/login",
    { matricNumber: enrolled.matric, password: TEST_PASSWORD },
    {
      cookie: `${authConfig.deviceBindingCookieName}=grant-enrolled-${RUN_ID}`,
    }
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: { matricNumber: string } };
  assert.equal(body.user.matricNumber, enrolled.matric);
  assert.ok(cookieValue(res.headers.getSetCookie(), authConfig.cookieName));
});

// ---------------------------------------------------------------------------
// 6. Admin reset reopens enrollment, and expires the outstanding grant
// ---------------------------------------------------------------------------

test("GRANT: an admin device reset expires the grant and reopens enrollment", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });
  assert.equal(login.status, 409, "fresh has an active device before the reset");
  const staleGrant = cookieValue(
    login.headers.getSetCookie(),
    authConfig.enrollmentGrantCookieName
  );

  const reset = await postJson(
    `/api/admin/students/${fresh.studentId}/device/reset`,
    {},
    sessionHeader(adminUserId)
  );
  assert.equal(reset.status, 200);

  // Any grant issued before the reset must be dead, so a browser holding one cannot ride it
  // through the reset.
  const grantsAfterReset = await pool.query(
    `SELECT status FROM student_device_enrollment_grants
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [fresh.studentId]
  );
  assert.equal(
    grantsAfterReset.rowCount,
    0,
    "the admin reset must expire every outstanding enrollment grant"
  );
  if (staleGrant !== undefined && staleGrant !== "") {
    const stale = await getJson("/api/student/device", grantHeader(staleGrant));
    assert.equal(stale.status, 401, "a grant issued before a reset must not survive it");
  }

  // No ACTIVE device remains, so a fresh login may now start enrollment.
  const active = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [fresh.studentId]
  );
  assert.equal(active.rows[0].n, 0);

  const reLogin = await postJson("/api/auth/student/login", {
    matricNumber: fresh.matric,
    password: TEST_PASSWORD,
  });
  assert.equal(reLogin.status, 200);
  assert.deepEqual(await reLogin.json(), { enrollmentRequired: true });

  // And the new device can be enrolled on the new device.
  const newGrant = cookieValue(
    reLogin.headers.getSetCookie(),
    authConfig.enrollmentGrantCookieName
  )!;
  const { response } = await enrollFirstDevice(newGrant);
  assert.equal(response.status, 201);

  const devices = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [fresh.studentId]
  );
  assert.equal(devices.rows[0].n, 1, "exactly one active device after re-enrollment");
});

test("GRANT: the revoked device can no longer authenticate after an admin reset", async () => {
  // `fresh` was re-enrolled above; its earlier credential is revoked.
  const devices = await pool.query(
    `SELECT credential_id, status FROM student_devices WHERE student_id = $1 ORDER BY id`,
    [fresh.studentId]
  );
  const revoked = devices.rows.find((r: { status: string }) => r.status !== "ACTIVE");
  assert.ok(revoked, "the reset must have left a revoked credential behind");

  const res = await postJson(
    "/api/auth/student/login",
    { matricNumber: fresh.matric, password: TEST_PASSWORD },
    { cookie: `${authConfig.deviceBindingCookieName}=${revoked.credential_id}` }
  );
  assert.notEqual(res.status, 200, "a revoked device must not be able to log in");
});

// ---------------------------------------------------------------------------
// 7. Grants are student-bound
// ---------------------------------------------------------------------------

test("GRANT: a grant only ever acts for its own student", async () => {
  const login = await postJson("/api/auth/student/login", {
    matricNumber: other.matric,
    password: TEST_PASSWORD,
  });
  const grant = cookieValue(login.headers.getSetCookie(), authConfig.enrollmentGrantCookieName)!;

  // The ceremony is bound to `other`'s student id server-side; the request body cannot retarget it.
  const optionsRes = await postJson(
    "/api/student/device/enrollment/options",
    { studentId: fresh.studentId },
    grantHeader(grant)
  );
  assert.equal(optionsRes.status, 200);

  const { data } = (await optionsRes.json()) as { data: { challenge: string } };
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: data.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const complete = await postJson(
    "/api/student/device/enrollment/complete",
    { credential, studentId: fresh.studentId },
    grantHeader(grant)
  );
  assert.equal(complete.status, 201);

  // The credential landed on the grant's own student, not the one named in the body.
  const landed = await pool.query(
    `SELECT student_id FROM student_devices WHERE credential_id = $1`,
    [credential.id]
  );
  assert.equal(Number(landed.rows[0].student_id), other.studentId);
});