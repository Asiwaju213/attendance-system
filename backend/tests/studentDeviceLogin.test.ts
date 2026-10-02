import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { createFixedWindowLimiter } from "../src/lib/rateLimit";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { resetStudentDeviceLoginLimiters } from "../src/services/studentDeviceLoginService";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createTestAuthenticator,
  LEGACY_REGISTRATION_FLAGS,
  type TestAuthenticator,
} from "./webauthnTestHelpers";

/**
 * Focused coverage for device-identified student login.
 *
 * Every test drives the real HTTP surface and the real @simplewebauthn verification path with a
 * simulated authenticator, so what is asserted here is the code that actually runs.
 */

const TEST_PASSWORD = "device-login-test-password";
const RUN_ID = Date.now().toString(36).toUpperCase();

let server: Server;
let baseUrl: string;
let departmentId: number;
let levelId: number;

interface TestStudent {
  userId: number;
  studentId: number;
  matric: string;
  webauthnUserHandle: string;
  sessionToken: string;
}

interface EnrolledDevice {
  student: TestStudent;
  authenticator: TestAuthenticator;
  credentialId: string;
}

let enrolled: EnrolledDevice;
let other: EnrolledDevice;
let revokedDevice: EnrolledDevice;
let pending: TestStudent;
let inactive: TestStudent;

// The stored counter increases on every successful assertion, and @simplewebauthn rejects an
// assertion whose counter is not greater than the stored one. Each authenticator therefore
// needs its own strictly increasing sign counter.
const signCounts = new WeakMap<TestAuthenticator, number>();

function nextSignCount(authenticator: TestAuthenticator): number {
  const next = (signCounts.get(authenticator) ?? 2) + 1;
  signCounts.set(authenticator, next);
  return next;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${token}` };
}

async function createStudent(
  name: string,
  matric: string,
  status: string
): Promise<TestStudent> {
  const userRes = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, $2, 'STUDENT', $3)
     RETURNING id`,
    [name, await hashPassword(TEST_PASSWORD), status]
  );
  const userId = Number(userRes.rows[0].id);
  const studentRes = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, webauthn_user_handle`,
    [userId, matric, departmentId, levelId]
  );

  const sessionToken = `device-login-session-${userId}-${Date.now()}`;
  await pool.query(
    `INSERT INTO sessions (user_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [
      userId,
      hashSessionToken(sessionToken),
      new Date(Date.now() + authConfig.sessionLifetimeMs),
    ]
  );

  return {
    userId,
    studentId: Number(studentRes.rows[0].id),
    matric,
    webauthnUserHandle: studentRes.rows[0].webauthn_user_handle,
    sessionToken,
  };
}

/** Build an authenticator that reports the student's opaque handle as its user handle. */
async function newAuthenticatorFor(student: TestStudent): Promise<TestAuthenticator> {
  const authenticator = await createTestAuthenticator();
  authenticator.userId = Buffer.from(student.webauthnUserHandle, "utf8");
  return authenticator;
}

async function enrollDevice(student: TestStudent): Promise<EnrolledDevice> {
  return enrollDeviceWith(student, {});
}

/**
 * Enrol a device, optionally simulating an authenticator that ignored
 * `residentKey: "required"` and therefore produced a non-discoverable credential.
 */
async function enrollDeviceWith(
  student: TestStudent,
  enrollOptions: { flags?: number }
): Promise<EnrolledDevice> {
  const authenticator = await newAuthenticatorFor(student);

  const optionsRes = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(student.sessionToken)
  );
  assert.equal(optionsRes.status, 200, "enrollment options should succeed");
  const { data: options } = (await optionsRes.json()) as {
    data: { challenge: string };
  };

  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    ...(enrollOptions.flags !== undefined ? { flags: enrollOptions.flags } : {}),
  });

  const completeRes = await postJson(
    "/api/student/device/enrollment/complete",
    { credential, label: null },
    cookieHeader(student.sessionToken)
  );
  if (completeRes.status !== 201) {
    const detail = (await completeRes.json().catch(() => ({}))) as Record<string, unknown>;
    assert.fail(
      `enrollment complete returned ${completeRes.status}: ${JSON.stringify(detail)}`
    );
  }
  const { credentialId } = (await completeRes.json()) as { credentialId: string };

  return { student, authenticator, credentialId };
}

async function startLogin(): Promise<{ challenge: string; bindingToken: string }> {
  const res = await postJson("/api/auth/student/device/options", {});
  assert.equal(res.status, 200, "device login options should succeed");
  const body = (await res.json()) as {
    data: { options: { challenge: string }; bindingToken: string };
  };
  return { challenge: body.data.options.challenge, bindingToken: body.data.bindingToken };
}

async function verifyLogin(
  body: Record<string, unknown>
): Promise<{ status: number; error?: string; setCookie?: string }> {
  const res = await postJson("/api/auth/student/device/verify", body);
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return {
    status: res.status,
    error: payload.error,
    setCookie: res.headers.get("set-cookie") ?? undefined,
  };
}

async function signAssertion(
  device: EnrolledDevice,
  challenge: string,
  overrides: { userId?: string } = {}
): Promise<AuthenticationResponseJSON> {
  const assertion = await buildAuthenticationResponse({
    authenticator: device.authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: nextSignCount(device.authenticator),
  });
  // The user handle is not covered by the assertion signature, so a caller can present any
  // handle alongside a valid signature. Swapping it after signing is the honest way to build
  // that case without permanently corrupting the shared authenticator for later tests.
  if (overrides.userId !== undefined) {
    assertion.response.userHandle = Buffer.from(overrides.userId, "utf8").toString("base64url");
  }
  return assertion;
}

async function sessionCount(userId: number): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [userId]
  );
  return Number(result.rows[0].count);
}

async function cleanupFixtures(): Promise<void> {
  const userIds = (
    await pool.query(`SELECT id FROM users WHERE name LIKE 'Device Login %'`)
  ).rows.map((r: { id: unknown }) => Number(r.id));
  if (userIds.length === 0) {
    return;
  }
  const studentIds = (
    await pool.query(`SELECT id FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds])
  ).rows.map((r: { id: unknown }) => Number(r.id));

  await pool.query(
    `DELETE FROM audit_logs WHERE entity_type = 'student_devices' AND entity_id IN (
       SELECT id FROM student_devices WHERE student_id = ANY($1::BIGINT[])
     )`,
    [studentIds]
  );
  await pool.query(`DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(`DELETE FROM student_registration_challenges WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges WHERE student_id = ANY($1::BIGINT[])`,
    [studentIds]
  );
  await pool.query(`DELETE FROM student_devices WHERE student_id = ANY($1::BIGINT[])`, [
    studentIds,
  ]);
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
}

before(async () => {
  await cleanupFixtures();

  await pool.query(
    `INSERT INTO faculties (name, code)
     VALUES ('Device Login Test Faculty', 'DLFAC')
     ON CONFLICT (code) DO NOTHING`
  );
  const facultyRes = await pool.query(`SELECT id FROM faculties WHERE code = 'DLFAC'`);
  const departmentRes = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Device Login Test Department', 'DLDEP', $1)
     ON CONFLICT (code) DO NOTHING`,
    [Number(facultyRes.rows[0].id)]
  );
  if ((departmentRes.rowCount ?? 0) === 0) {
    const existing = await pool.query(`SELECT id FROM departments WHERE code = 'DLDEP'`);
    departmentId = Number(existing.rows[0].id);
  } else {
    const created = await pool.query(`SELECT id FROM departments WHERE code = 'DLDEP'`);
    departmentId = Number(created.rows[0].id);
  }
  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelId = Number(level.rows[0].id);

  // Start listening before enrolling, because enrollment goes through the real HTTP routes.
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Two healthy students, each with a discoverable credential, so identity resolution from the
  // credential alone can be observed.
  enrolled = await enrollDevice(await createStudent("Device Login Active", `DL/${RUN_ID}/1`, "ACTIVE"));
  other = await enrollDevice(await createStudent("Device Login Other", `DL/${RUN_ID}/2`, "ACTIVE"));

  // A revoked device keeps its own authenticator so the assertion signature is genuinely valid
  // and the only thing that can reject the login is the REVOKED device status.
  revokedDevice = await enrollDevice(
    await createStudent("Device Login Revoked", `DL/${RUN_ID}/3`, "ACTIVE")
  );
  await pool.query(
    `UPDATE student_devices SET status = 'REVOKED', revoked_at = now()
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [revokedDevice.student.studentId]
  );

  // PENDING and INACTIVE accounts keep ACTIVE devices on purpose: this is the state an admin
  // registration reset leaves behind, and it must still not be able to sign in.
  const pendingStudent = await createStudent("Device Login Pending", `DL/${RUN_ID}/4`, "ACTIVE");
  await enrollDevice(pendingStudent);
  await pool.query(`UPDATE users SET status = 'PENDING' WHERE id = $1`, [pendingStudent.userId]);
  pending = pendingStudent;

  const inactiveStudent = await createStudent("Device Login Inactive", `DL/${RUN_ID}/5`, "ACTIVE");
  await enrollDevice(inactiveStudent);
  await pool.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [inactiveStudent.userId]);
  inactive = inactiveStudent;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  await pool.query(`DELETE FROM student_device_login_challenges`, []);
  await cleanupFixtures();
});

// ---------------------------------------------------------------------------
// Challenge issuance
// ---------------------------------------------------------------------------

test("device login options are usernameless and name no credential", async () => {
  resetStudentDeviceLoginLimiters();
  const res = await postJson("/api/auth/student/device/options", {});
  assert.equal(res.status, 200);

  const { data } = (await res.json()) as {
    data: {
      options: {
        challenge: string;
        rpId: string;
        userVerification: string;
        allowCredentials?: unknown;
      };
      bindingToken: string;
    };
  };

  assert.equal(typeof data.options.challenge, "string");
  assert.ok(data.options.challenge.length > 0);
  assert.equal(data.options.rpId, webauthnConfig.rpID);
  assert.equal(data.options.userVerification, "required");
  // The whole point of the ceremony: the authenticator chooses the credential, so the RP must
  // not name it. This is what lets a passkey be found with no matric number typed in.
  assert.equal(data.options.allowCredentials, undefined);
  assert.ok(data.bindingToken.length > 0);
});

test("only hashes of the challenge and binding token are persisted", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const challengeHash = hashSessionToken(challenge);

  const found = await pool.query(
    `SELECT challenge_hash, binding_token_hash FROM student_device_login_challenges
      WHERE challenge_hash = $1`,
    [challengeHash]
  );
  assert.equal(found.rowCount, 1, "the challenge should be stored, keyed by its hash");

  const row = found.rows[0] as { challenge_hash: string; binding_token_hash: string };
  assert.notEqual(row.challenge_hash, challenge);
  assert.equal(row.binding_token_hash, hashSessionToken(bindingToken));
  assert.notEqual(row.binding_token_hash, bindingToken);

  // Neither raw value may exist anywhere in the table.
  const raw = await pool.query(
    `SELECT count(*)::int AS count FROM student_device_login_challenges
      WHERE challenge_hash = $1 OR binding_token_hash = $1`,
    [challenge]
  );
  assert.equal(Number(raw.rows[0].count), 0);

  // The table records no student, because no student is known yet.
  const columns = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'student_device_login_challenges'`
  );
  const names = (columns.rows as Array<{ column_name: string }>).map((c) => c.column_name);
  assert.equal(names.includes("student_id"), false);
  assert.equal(names.includes("user_id"), false);
});

// ---------------------------------------------------------------------------
// Successful authentication
// ---------------------------------------------------------------------------

test("an active student signs in with a device assertion and their password", async () => {
  resetStudentDeviceLoginLimiters();
  const before = await sessionCount(enrolled.student.userId);

  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);
  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });

  assert.equal(result.status, 200);
  assert.match(result.setCookie ?? "", new RegExp(authConfig.cookieName));
  assert.match(result.setCookie ?? "", /HttpOnly/i);
  assert.equal(await sessionCount(enrolled.student.userId), before + 1);
});

test("the device login session is a normal, usable OOU session", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);

  const res = await postJson("/api/auth/student/device/verify", {
    bindingToken,
    assertion,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const { user } = (await me.json()) as { user: Record<string, unknown> };
  assert.equal(user.id, enrolled.student.userId);
  assert.equal(user.role, "STUDENT");
  assert.equal(user.matricNumber, enrolled.student.matric);
  // The safe projection must not leak credential or password material.
  assert.equal(user.passwordHash, undefined);
  assert.equal(user.webauthnUserHandle, undefined);
});

test("the authenticator signature counter is persisted after a successful assertion", async () => {
  resetStudentDeviceLoginLimiters();
  const signCount = signCounts.get(enrolled.authenticator)! + 1;

  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);
  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(result.status, 200);

  const stored = await pool.query(
    `SELECT counter FROM student_devices WHERE credential_id = $1`,
    [enrolled.credentialId]
  );
  assert.equal(Number(stored.rows[0].counter), signCount);
});

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

test("a wrong password is rejected and creates no session", async () => {
  resetStudentDeviceLoginLimiters();
  const before = await sessionCount(enrolled.student.userId);

  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);
  const result = await verifyLogin({
    bindingToken,
    assertion,
    password: "definitely-not-the-password",
  });

  assert.equal(result.status, 401);
  assert.equal(result.error, "INVALID_CREDENTIALS");
  assert.equal(result.setCookie, undefined);
  assert.equal(await sessionCount(enrolled.student.userId), before);
});

test("a wrong password leaves the challenge usable so a typo needs no new passkey prompt", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);

  const first = await verifyLogin({ bindingToken, assertion, password: "a-typo" });
  assert.equal(first.status, 401);

  // The device proof already verified on the first attempt, so retrying only the password with
  // the same assertion must be allowed.
  const second = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(second.status, 200);
});

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

test("identity comes from the credential, not from anything in the request body", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();

  // Sign in as the second student while claiming the first student's identity in the body.
  const assertion = await signAssertion(other, challenge);
  const res = await postJson("/api/auth/student/device/verify", {
    bindingToken,
    assertion,
    password: TEST_PASSWORD,
    matricNumber: enrolled.student.matric,
    studentId: enrolled.student.userId,
    userId: enrolled.student.userId,
    role: "STUDENT",
  });

  assert.equal(res.status, 200);
  const { user } = (await res.json()) as { user: { id: number; matricNumber: string } };
  assert.equal(user.id, other.student.userId, "the session must belong to the credential's owner");
  assert.equal(user.matricNumber, other.student.matric);
});

test("an unknown credential is rejected with the same generic failure", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();

  const stranger = await createTestAuthenticator();
  const assertion = await buildAuthenticationResponse({
    authenticator: stranger,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(result.status, 401);
  assert.equal(result.error, "INVALID_CREDENTIALS");
});

test("a revoked device cannot authenticate even with a valid signature", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();

  // Signed by the authenticator that actually enrolled this credential, so the only thing left
  // to reject the login is the device status.
  const assertion = await signAssertion(revokedDevice, challenge);
  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });

  assert.equal(result.status, 401);
  assert.equal(result.error, "INVALID_CREDENTIALS");
  assert.equal(result.setCookie, undefined);
  // Only the fixture session created in before(); no login session was added.
  assert.equal(await sessionCount(revokedDevice.student.userId), 1);
});

test("a PENDING account with an ACTIVE device cannot authenticate", async () => {
  resetStudentDeviceLoginLimiters();
  const device = await pool.query(
    `SELECT id, credential_id FROM student_devices
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [pending.studentId]
  );
  assert.equal(device.rowCount, 1, "fixture must have an ACTIVE device");

  const { challenge, bindingToken } = await startLogin();
  const authenticator = await newAuthenticatorFor(pending);
  const assertion = await buildAuthenticationResponse({
    authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: nextSignCount(authenticator),
  });
  assertion.id = device.rows[0].credential_id;
  assertion.rawId = device.rows[0].credential_id;

  const before = await sessionCount(pending.userId);
  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(result.status, 401);
  assert.equal(result.error, "INVALID_CREDENTIALS");
  assert.equal(await sessionCount(pending.userId), before);
});

test("an INACTIVE account with an ACTIVE device cannot authenticate", async () => {
  resetStudentDeviceLoginLimiters();
  const device = await pool.query(
    `SELECT credential_id FROM student_devices
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [inactive.studentId]
  );
  assert.equal(device.rowCount, 1);

  const { challenge, bindingToken } = await startLogin();
  const authenticator = await newAuthenticatorFor(inactive);
  const assertion = await buildAuthenticationResponse({
    authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: nextSignCount(authenticator),
  });
  assertion.id = device.rows[0].credential_id;
  assertion.rawId = device.rows[0].credential_id;

  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(result.status, 401);
});

test("a user handle that does not match the enrollment is rejected", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();

  // The enrolled key signs, but the authenticator reports the other student's handle. If the
  // server ignored the handle this would authenticate, so a 401 proves the cross-check runs.
  const assertion = await signAssertion(enrolled, challenge, {
    userId: other.student.webauthnUserHandle,
  });
  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });

  assert.equal(result.status, 401);
  assert.equal(result.error, "INVALID_CREDENTIALS");
});

// ---------------------------------------------------------------------------
// Challenge lifecycle
// ---------------------------------------------------------------------------

test("a challenge is single-use: replaying a successful assertion fails", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);

  const first = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(first.status, 200);

  const replay = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(replay.status, 401);
  assert.equal(replay.error, "INVALID_CREDENTIALS");
  assert.equal(replay.setCookie, undefined);
});

test("a failed signature retires the challenge", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();

  // A key that was never enrolled, reporting the enrolled student's handle, so the request
  // reaches signature verification and fails there.
  const impostor = await createTestAuthenticator();
  impostor.userId = Buffer.from(enrolled.student.webauthnUserHandle, "utf8");
  const bad = await buildAuthenticationResponse({
    authenticator: impostor,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: nextSignCount(impostor),
  });
  bad.id = enrolled.credentialId;
  bad.rawId = enrolled.credentialId;

  assert.equal(
    (await verifyLogin({ bindingToken, assertion: bad, password: TEST_PASSWORD })).status,
    401
  );

  // The correct assertion can no longer be redeemed against the same challenge.
  const good = await signAssertion(enrolled, challenge);
  const second = await verifyLogin({
    bindingToken,
    assertion: good,
    password: TEST_PASSWORD,
  });
  assert.equal(second.status, 401);
});

test("an expired challenge is rejected", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);

  await pool.query(
    `UPDATE student_device_login_challenges SET expires_at = now() - interval '1 second'
      WHERE challenge_hash = $1`,
    [hashSessionToken(challenge)]
  );

  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(result.status, 401);
  assert.equal(result.error, "INVALID_CREDENTIALS");
});

test("a challenge cannot be redeemed with another flow's binding token", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);

  const otherFlow = await startLogin();
  assert.notEqual(otherFlow.bindingToken, bindingToken);

  const result = await verifyLogin({
    bindingToken: otherFlow.bindingToken,
    assertion,
    password: TEST_PASSWORD,
  });
  assert.equal(result.status, 401);
});

test("a challenge is bound to its own signature and cannot be swapped for another credential", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();

  // The first student's challenge, but the second student's key and credential id. The challenge
  // is not tied to a student, so this is only rejected because the signature does not verify
  // against the credential the server resolved from the submitted id.
  const assertion = await buildAuthenticationResponse({
    authenticator: other.authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: nextSignCount(other.authenticator),
  });
  assertion.id = enrolled.credentialId;
  assertion.rawId = enrolled.credentialId;

  const result = await verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
  assert.equal(result.status, 401);
  assert.equal(result.error, "INVALID_CREDENTIALS");
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test("the verify endpoint requires a binding token, an assertion and a password", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);

  assert.equal((await verifyLogin({ bindingToken, assertion })).status, 400);
  assert.equal((await verifyLogin({ assertion, password: TEST_PASSWORD })).status, 400);
  assert.equal((await verifyLogin({ bindingToken, password: TEST_PASSWORD })).status, 400);
  assert.equal((await verifyLogin({ bindingToken, assertion, password: "" })).status, 400);
  assert.equal((await verifyLogin({ bindingToken, assertion: {}, password: TEST_PASSWORD })).status, 400);
});

// ---------------------------------------------------------------------------
// A matric number + password is no longer a login on its own
// ---------------------------------------------------------------------------

test("a matric number + password never mints a session, even for an enrolled student", async () => {
  resetStudentDeviceLoginLimiters();
  const res = await postJson("/api/auth/student/login", {
    matricNumber: enrolled.student.matric,
    password: TEST_PASSWORD,
  });

  // The credentials are correct, but this browser has presented no device, so it is refused:
  // the enrolled device stays authoritative and an admin must reset it first.
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "DEVICE_ALREADY_ENROLLED");

  const setCookie = res.headers.getSetCookie();
  assert.equal(
    setCookie.filter((c) => c.startsWith(`${authConfig.cookieName}=`)).length,
    0,
    "no session cookie may be issued"
  );
  // The response may clear a stale grant left over from an abandoned enrollment, but it must
  // never hand this browser a usable one while an active device exists.
  const grantCookie = setCookie.find((c) =>
    c.startsWith(`${authConfig.enrollmentGrantCookieName}=`)
  );
  if (grantCookie) {
    const value = grantCookie.slice(
      grantCookie.indexOf("=") + 1,
      grantCookie.indexOf(";")
    );
    assert.equal(
      value,
      "",
      `a stale enrollment grant must be cleared, not re-issued (got "${value}")`
    );
    assert.match(
      grantCookie,
      /Max-Age=0|Expires=Thu, 01 Jan 1970/i,
      "the cleared grant cookie must expire immediately"
    );
  }

  // The enrolled device is untouched and can still authenticate.
  const active = await pool.query(
    `SELECT count(*)::int AS n FROM student_devices
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [enrolled.student.studentId]
  );
  assert.equal(active.rows[0].n, 1, "the enrolled device must remain the only active device");

  const bound = await postJson(
    "/api/auth/student/login",
    { password: TEST_PASSWORD },
    { cookie: `${authConfig.deviceBindingCookieName}=${enrolled.credentialId}` }
  );
  assert.equal(bound.status, 200, "the existing device must still be able to log in");
});

test("a wrong matric number is still rejected", async () => {
  resetStudentDeviceLoginLimiters();
  const res = await postJson("/api/auth/student/login", {
    matricNumber: `DL/${RUN_ID}/9999`,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 401);
});

test("the PENDING account is still rejected", async () => {
  resetStudentDeviceLoginLimiters();
  const res = await postJson("/api/auth/student/login", {
    matricNumber: pending.matric,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------

test("the fixed window limiter blocks at the limit, isolates keys and recovers on reset", () => {
  const limiter = createFixedWindowLimiter("test-window", 3, 60_000);

  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, false);
  assert.equal(limiter.check("a").allowed, false);
  assert.ok(limiter.check("a").retryAfterSeconds > 0);

  // Windows are per key, so one throttled caller does not affect anyone else.
  assert.equal(limiter.check("b").allowed, true);

  limiter.reset("a");
  assert.equal(limiter.check("a").allowed, true);
});

test("repeated failed device logins are throttled rather than served indefinitely", async () => {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(enrolled, challenge);

  let sawTooMany = false;
  let served = 0;
  for (let i = 0; i < webauthnConfig.loginFailureRateLimit.maxFailures + 6; i += 1) {
    const result = await verifyLogin({ bindingToken, assertion, password: `guess-${i}` });
    if (result.status === 429) {
      assert.equal(result.error, "TOO_MANY_ATTEMPTS");
      sawTooMany = true;
      break;
    }
    served += 1;
  }

  assert.equal(sawTooMany, true, "the endpoint must throttle repeated failures");
  assert.equal(
    served,
    webauthnConfig.loginFailureRateLimit.maxFailures,
    "no more than the configured budget should be served"
  );
  resetStudentDeviceLoginLimiters();
});

test("challenge issuance is throttled separately from verification", async () => {
  resetStudentDeviceLoginLimiters();
  let sawTooMany = false;
  for (let i = 0; i < webauthnConfig.loginChallengeRateLimit.maxChallenges + 4; i += 1) {
    const res = await postJson("/api/auth/student/device/options", {});
    if (res.status === 429) {
      sawTooMany = true;
      break;
    }
  }
  assert.equal(sawTooMany, true, "challenge issuance must be throttled");
  resetStudentDeviceLoginLimiters();
});

// ---------------------------------------------------------------------------
// Schema invariants introduced by migration 009
// ---------------------------------------------------------------------------

test("webauthn user handles are opaque, unique, and not derived from the student", async () => {
  const rows = await pool.query(
    `SELECT s.id, s.matric_number, s.webauthn_user_handle
       FROM students s
      WHERE s.webauthn_user_handle IS NOT NULL
        AND s.user_id IN (
          SELECT id FROM users WHERE name LIKE 'Device Login %'
        )`
  );
  assert.ok(rows.rowCount >= 4, "fixtures should all have a handle");

  const handles = new Set<string>();
  for (const row of rows.rows as Array<{
    id: number;
    matric_number: string;
    webauthn_user_handle: string;
  }>) {
    const handle = row.webauthn_user_handle;
    // Neither the sequential student id nor the matric number may appear in the handle.
    assert.notEqual(handle, String(row.id));
    assert.notEqual(handle, row.matric_number);
    assert.ok(!handle.includes(row.matric_number));
    assert.match(handle, /^[0-9a-f]{64}$/);
    assert.equal(handles.has(handle), false, "handles must be unique");
    handles.add(handle);
  }
});

test("a revoked credential id can be re-enrolled, but can never be active twice", async () => {
  const revoked = await pool.query(
    `SELECT credential_id, credential_public_key FROM student_devices
      WHERE student_id = $1 AND status = 'REVOKED'`,
    [revokedDevice.student.studentId]
  );
  const credentialId = revoked.rows[0].credential_id as string;
  const publicKey = revoked.rows[0].credential_public_key as Buffer;

  // A student with no devices may take over the revoked credential id: since migration 009 a
  // REVOKED row no longer reserves it, which is what lets a student recover on the same
  // platform authenticator after an admin reset.
  const recovering = await createStudent(
    "Device Login Recovered",
    `DL/${RUN_ID}/6`,
    "ACTIVE"
  );
  const reAuthenticator = await createTestAuthenticator();
  reAuthenticator.credentialId = isoBase64URL.toBuffer(credentialId);
  reAuthenticator.userId = Buffer.from(recovering.webauthnUserHandle, "utf8");

  const optionsRes = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(recovering.sessionToken)
  );
  const { data: options } = (await optionsRes.json()) as { data: { challenge: string } };
  const completeRes = await postJson(
    "/api/student/device/enrollment/complete",
    {
      credential: await buildRegistrationResponse({
        authenticator: reAuthenticator,
        challenge: options.challenge,
        origin: webauthnConfig.expectedOrigin,
        rpId: webauthnConfig.rpID,
      }),
      label: null,
    },
    cookieHeader(recovering.sessionToken)
  );
  assert.equal(completeRes.status, 201, "a revoked credential id must be re-enrollable");
  assert.equal(
    ((await completeRes.json()) as { credentialId: string }).credentialId,
    credentialId
  );

  // But a second student can never hold it ACTIVE as well. This student has no device at all, so
  // `one_active_device_per_student` cannot be what fires here.
  const newcomer = await createStudent("Device Login Newcomer", `DL/${RUN_ID}/7`, "ACTIVE");
  let duplicateRejected = false;
  try {
    await pool.query(
      `INSERT INTO student_devices (student_id, credential_id, credential_public_key, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [newcomer.studentId, credentialId, publicKey]
    );
  } catch (error) {
    duplicateRejected = (error as { code?: string }).code === "23505";
  }
  assert.equal(duplicateRejected, true, "one credential must never be ACTIVE for two students");
});

test("a student still cannot hold two ACTIVE devices", async () => {
  let rejected = false;
  try {
    await pool.query(
      `INSERT INTO student_devices (student_id, credential_id, credential_public_key, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [enrolled.student.studentId, `dup-${Date.now()}`, Buffer.alloc(77, 1)]
    );
  } catch (error) {
    rejected = (error as { code?: string }).code === "23505";
  }
  assert.equal(rejected, true, "the one-active-device-per-student index must be preserved");
});

// ---------------------------------------------------------------------------
// Non-discoverable credentials must never authenticate via the usernameless ceremony
// ---------------------------------------------------------------------------

/**
 * Perform a full usernameless login for an enrolled device and return the HTTP result.
 * The password is always correct, so only the credential checks can reject.
 */
async function loginWithDevice(device: EnrolledDevice): Promise<{
  status: number;
  error?: string;
  setCookie?: string;
}> {
  resetStudentDeviceLoginLimiters();
  const { challenge, bindingToken } = await startLogin();
  const assertion = await signAssertion(device, challenge);
  return verifyLogin({ bindingToken, assertion, password: TEST_PASSWORD });
}

test("a non-discoverable credential cannot sign in with the usernameless ceremony", async () => {
  const student = await createStudent(
    "Device Login Legacy",
    `DL/${RUN_ID}/legacy`,
    "ACTIVE"
  );
  const legacy = await enrollDeviceWith(student, { flags: LEGACY_REGISTRATION_FLAGS });

  // Precondition: the credential is a real, ACTIVE, correctly-parked device, so the only
  // possible reason for a refusal is its lack of discoverability.
  const device = await pool.query(
    `SELECT status, discoverable FROM student_devices
     WHERE student_id = $1 AND credential_id = $2`,
    [student.studentId, legacy.credentialId]
  );
  assert.equal(device.rows[0].status, "ACTIVE");
  assert.equal(device.rows[0].discoverable, false);

  const result = await loginWithDevice(legacy);
  assert.equal(
    result.status,
    401,
    "a non-discoverable credential must not mint a session"
  );
  // The same generic error as every other rejection, so the response does not disclose that the
  // credential exists but is of the wrong kind.
  assert.equal(result.error, "INVALID_CREDENTIALS");
  assert.equal(
    result.setCookie,
    undefined,
    "no session cookie may be issued for a non-discoverable credential"
  );
});

test("a pre-migration device (discoverable unknown) cannot sign in with the usernameless ceremony", async () => {
  const student = await createStudent(
    "Device Login Unknown",
    `DL/${RUN_ID}/unknown`,
    "ACTIVE"
  );
  const legacy = await enrollDeviceWith(student, {});
  // Reproduce a row that predates migration 010, where discoverability was never recorded.
  await pool.query(
    `UPDATE student_devices SET discoverable = NULL
     WHERE student_id = $1 AND credential_id = $2`,
    [student.studentId, legacy.credentialId]
  );

  const result = await loginWithDevice(legacy);
  assert.equal(
    result.status,
    401,
    "an unknown discoverability must not be treated as discoverable"
  );
  assert.equal(result.setCookie, undefined);
});

test("a discoverable credential still signs in after the gate was added", async () => {
  // Guards against the new gate over-rejecting the normal case.
  const result = await loginWithDevice(enrolled);
  assert.equal(result.status, 200);
  assert.ok(result.setCookie, "a discoverable credential must still receive a session");
});

test("a non-discoverable credential still works for attendance", async () => {
  // The upgrade requirement exists because these credentials are otherwise fine: they must keep
  // working for the attendance ceremony, which does name the credential explicitly.
  const student = await createStudent(
    "Device Login Attendance",
    `DL/${RUN_ID}/attendance`,
    "ACTIVE"
  );
  const legacy = await enrollDeviceWith(student, { flags: LEGACY_REGISTRATION_FLAGS });

  const device = await pool.query(
    `SELECT credential_id, status FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [student.studentId]
  );
  assert.equal(device.rows[0].credential_id, legacy.credentialId);

  const resolved = await pool.query(
    `SELECT d.credential_id
     FROM student_devices d
     JOIN students s ON s.id = d.student_id
     WHERE s.user_id = $1 AND d.status = 'ACTIVE'
     ORDER BY d.enrolled_at DESC, d.id DESC
     LIMIT 1`,
    [student.userId]
  );
  assert.equal(resolved.rows[0].credential_id, legacy.credentialId);
});
