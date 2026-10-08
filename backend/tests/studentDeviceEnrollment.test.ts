import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { hashSessionToken } from "../src/lib/sessions";
import {
  verifyStudentDevice,
  verifyStudentRegistration,
} from "../src/lib/webauthn";
import { hashPassword } from "../src/lib/passwords";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createTestAuthenticator,
  LEGACY_REGISTRATION_FLAGS,
  type TestAuthenticator,
} from "./webauthnTestHelpers";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const TEST_PASSWORD = "student-device-test-password";
const RUN_ID = Date.now().toString(36).toUpperCase();

let server: Server;
let baseUrl: string;
let departmentId: number;
let levelId: number;

interface TestUser {
  role: "STUDENT" | "LECTURER" | "ADMIN";
  status: string;
  matric?: string;
  name: string;
  userId: number;
}

let studentA: TestUser; // "studentUser"
let studentB: TestUser; // "secondStudentUser"
let studentC: TestUser;
let studentD: TestUser;
// Dedicated to the legacy-upgrade scenario so the shared students keep their own device state.
let upgradeStudent: TestUser;
// Dedicated to the account-label tests, which need a student with no ACTIVE device.
let labelStudent: TestUser;
let lecturerUser: TestUser;
let adminUser: TestUser;
let inactiveStudentUser: TestUser;

const sessionTokens: Record<number, string> = {};

// Shared authenticator built during test 10, reused for the credential-in-use test.
let enrolledAuthenticator: TestAuthenticator | null = null;
// Student A's first issued challenge (used by the hash-only-storage test).
let firstChallengeA = "";

const cookieHeader = (userId: number): Record<string, string> => ({
  cookie: `${authConfig.cookieName}=${sessionTokens[userId]}`,
});

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function requestOptions(userId: number): Promise<{ challenge: string }> {
  const res = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(userId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { challenge: string } };
  return body.data;
}

async function studentId(userId: number): Promise<number> {
  const res = await pool.query(
    `SELECT id FROM students WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return Number(res.rows[0].id);
}

async function cleanupDeviceFixtures(): Promise<void> {
  const userIds = (
    await pool.query(
      `SELECT id FROM users
       WHERE name LIKE 'Device %'
          OR id IN (
            SELECT user_id FROM students
            WHERE department_id IN (SELECT id FROM departments WHERE code = 'DEVDEP')
          )`
    )
  ).rows.map((r: { id: unknown }) => Number(r.id));
  const ids = (
    await pool.query(
      `SELECT id FROM students WHERE user_id = ANY($1::BIGINT[])`,
      [userIds]
    )
  ).rows.map((r: { id: unknown }) => Number(r.id));

  await pool.query(
    `DELETE FROM audit_logs WHERE entity_type = 'student_devices' AND entity_id IN (
       SELECT id FROM student_devices WHERE student_id = ANY($1::BIGINT[])
     )`,
    [ids]
  );
  await pool.query(`DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(
    `DELETE FROM student_registration_challenges WHERE user_id = ANY($1::BIGINT[])`,
    [userIds]
  );
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges WHERE student_id = ANY($1::BIGINT[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM student_devices WHERE student_id = ANY($1::BIGINT[])`,
    [ids]
  );
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
}

before(async () => {
  // Remove leftovers from an earlier aborted run so re-runs are deterministic.
  await cleanupDeviceFixtures();

  await pool.query(
    `INSERT INTO faculties (name, code)
     VALUES ('Student Device Test Faculty', 'DEVFAC')
     ON CONFLICT (code) DO NOTHING`
  );
  const facultyRes = await pool.query(
    `SELECT id FROM faculties WHERE code = 'DEVFAC'`
  );
  const facultyId = Number(facultyRes.rows[0].id);

  const dept = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Student Device Test Department', 'DEVDEP', $1)
     ON CONFLICT (code) DO NOTHING`,
    [facultyId]
  );
  if ((dept.rowCount ?? 0) === 0) {
    const existing = await pool.query(
      `SELECT id FROM departments WHERE code = 'DEVDEP'`
    );
    departmentId = Number(existing.rows[0].id);
  } else {
    const created = await pool.query(
      `SELECT id FROM departments WHERE code = 'DEVDEP'`
    );
    departmentId = Number(created.rows[0].id);
  }
  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelId = Number(level.rows[0].id);

  const passwordHash = await hashPassword(TEST_PASSWORD);

  async function insertUser(
    name: string,
    role: string,
    status: string,
    matric?: string
  ): Promise<number> {
    const username = role === "ADMIN" ? `dev-${role.toLowerCase()}-${Date.now()}` : null;
    const userRes = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, passwordHash, role, status, username]
    );
    const userId = Number(userRes.rows[0].id);
    if (role === "STUDENT" && matric) {
      await pool.query(
        `INSERT INTO students (user_id, matric_number, department_id, level_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, matric, departmentId, levelId]
      );
    }
    return userId;
  }

  const makeUser = (
    role: "STUDENT" | "LECTURER" | "ADMIN",
    status: string,
    name: string,
    matric?: string
  ): Promise<TestUser> =>
    insertUser(name, role, status, matric).then((userId) => ({
      role,
      status,
      name,
      matric,
      userId,
    }));

  studentA = await makeUser("STUDENT", "ACTIVE", "Device Student One", `DEV/${RUN_ID}/1`);
  studentB = await makeUser("STUDENT", "ACTIVE", "Device Student Two", `DEV/${RUN_ID}/2`);
  studentC = await makeUser("STUDENT", "ACTIVE", "Device Student Three", `DEV/${RUN_ID}/3`);
  studentD = await makeUser("STUDENT", "ACTIVE", "Device Student Four", `DEV/${RUN_ID}/4`);
  upgradeStudent = await makeUser(
    "STUDENT",
    "ACTIVE",
    "Device Student Upgrade",
    `DEV/${RUN_ID}/6`
  );
  labelStudent = await makeUser(
    "STUDENT",
    "ACTIVE",
    "Device Student Label",
    `DEV/${RUN_ID}/7`
  );
  lecturerUser = await makeUser("LECTURER", "ACTIVE", "Device Lecturer");
  adminUser = await makeUser("ADMIN", "ACTIVE", "Device Admin");
  inactiveStudentUser = await makeUser(
    "STUDENT",
    "INACTIVE",
    "Device Student Inactive",
    `DEV/${RUN_ID}/5`
  );

  // Give every user a session cookie directly (mirrors the login mechanism).
  for (const user of [
    studentA,
    studentB,
    studentC,
    studentD,
    upgradeStudent,
    labelStudent,
    lecturerUser,
    adminUser,
    inactiveStudentUser,
  ]) {
    const token = `device-session-${user.userId}-${Date.now()}`;
    await pool.query(
      `INSERT INTO sessions (user_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [
        user.userId,
        hashSessionToken(token),
        new Date(Date.now() + authConfig.sessionLifetimeMs),
      ]
    );
    sessionTokens[user.userId] = token;
  }

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

  await cleanupDeviceFixtures();
  await pool.query(`DELETE FROM departments WHERE code = 'DEVDEP'`);
  await pool.query(`DELETE FROM faculties WHERE code = 'DEVFAC'`);
  await pool.end();
});

test("DEVICE authorization: anonymous requests are rejected with 401", async () => {
  const options = await postJson("/api/student/device/enrollment/options", {});
  assert.equal(options.status, 401);
  assert.equal((await options.json()).error, "UNAUTHENTICATED");

  const complete = await postJson("/api/student/device/enrollment/complete", {});
  assert.equal(complete.status, 401);
});

test("DEVICE authorization: lecturer and admin accounts are rejected with 403", async () => {
  const lecturer = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(lecturerUser.userId)
  );
  assert.equal(lecturer.status, 403);
  assert.equal((await lecturer.json()).error, "FORBIDDEN");

  const admin = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(adminUser.userId)
  );
  assert.equal(admin.status, 403);
  assert.equal((await admin.json()).error, "FORBIDDEN");
});

test("DEVICE authorization: inactive student accounts are rejected with 401", async () => {
  const res = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(inactiveStudentUser.userId)
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "UNAUTHENTICATED");
});

test("DEVICE options: an active student receives a registration options payload", async () => {
  const res = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(studentA.userId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(typeof body.data.challenge, "string");
  assert.ok((body.data.challenge as string).length >= 16, "challenge must be long");
  assert.equal((body.data.rp as { name: string }).name, "OOU Attendance System");
  assert.equal((body.data.rp as { id: string }).id, "localhost");
  assert.equal(
    (body.data.user as { displayName: string }).displayName,
    "Device Student One"
  );
  assert.equal(
    (body.data.authenticatorSelection as { authenticatorAttachment: string })
      .authenticatorAttachment,
    "platform"
  );
  const bytes = Buffer.from(body.data.challenge as string, "base64url");
  assert.ok(bytes.length >= 16, "challenge must be random");

  firstChallengeA = body.data.challenge as string;
});

test("DEVICE options: the challenge is stored only as a hash, bound to the student", async () => {
  const sid = await studentId(studentA.userId);
  const rows = await pool.query(
    `SELECT challenge_hash, status
     FROM student_device_enrollment_challenges
     WHERE student_id = $1
     ORDER BY id`,
    [sid]
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].status, "ACTIVE");
  assert.equal(rows.rows[0].challenge_hash, hashSessionToken(firstChallengeA));
  assert.equal(rows.rows[0].challenge_hash.length, 64);
  assert.notEqual(rows.rows[0].challenge_hash, firstChallengeA);
});

test("DEVICE options: issuing again expires the previous challenge", async () => {
  const sid = await studentId(studentA.userId);
  const second = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(studentA.userId)
  );
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { data: { challenge: string } };
  assert.notEqual(secondBody.data.challenge, firstChallengeA);

  const rows = await pool.query(
    `SELECT status, challenge_hash
     FROM student_device_enrollment_challenges
     WHERE student_id = $1
     ORDER BY id`,
    [sid]
  );
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows[0].status, "EXPIRED");
  assert.equal(rows.rows[1].status, "ACTIVE");
  assert.equal(rows.rows[1].challenge_hash, hashSessionToken(secondBody.data.challenge));
});

test("DEVICE complete: a credential signed for the wrong origin is rejected with INVALID_CREDENTIAL", async () => {
  const options = await requestOptions(studentA.userId);
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: "https://evil.example.com",
    rpId: webauthnConfig.rpID,
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentA.userId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_CREDENTIAL");
});

test("DEVICE complete: a credential bound to the wrong RP ID is rejected with INVALID_CREDENTIAL", async () => {
  const options = await requestOptions(studentA.userId);
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: "attendance.evil.example",
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentA.userId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_CREDENTIAL");
});

test("DEVICE complete: malformed request bodies are rejected with INVALID_REQUEST", async () => {
  const missing = await postJson(
    "/api/student/device/enrollment/complete",
    {},
    cookieHeader(studentA.userId)
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "INVALID_REQUEST");

  const badType = await postJson(
    "/api/student/device/enrollment/complete",
    { credential: { id: "x", rawId: "y", type: "not-public-key", response: {} } },
    cookieHeader(studentA.userId)
  );
  assert.equal(badType.status, 400);
  assert.equal((await badType.json()).error, "INVALID_REQUEST");

  const badB64 = await postJson(
    "/api/student/device/enrollment/complete",
    {
      credential: {
        id: "not-base64url!!",
        rawId: "not-base64url!!",
        type: "public-key",
        response: { clientDataJSON: "not-base64url!!", attestationObject: "not-base64url!!" },
        clientExtensionResults: {},
      },
    },
    cookieHeader(studentA.userId)
  );
  assert.equal(badB64.status, 400);
  assert.equal((await badB64.json()).error, "INVALID_REQUEST");
});

test("DEVICE enrollment: a valid registration enrolls the device, then a second options call is rejected", async () => {
  const options = await requestOptions(studentB.userId);
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential, label: "Work Laptop" },
    cookieHeader(studentB.userId)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { credentialId: string; device: Record<string, unknown> };
  assert.equal(body.credentialId, credential.id);
  assert.equal(body.device.status, "ACTIVE");
  assert.equal(body.device.label, "Work Laptop");

  enrolledAuthenticator = authenticator;

  // A student with an ACTIVE device cannot request another enrollment.
  const again = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(studentB.userId)
  );
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "DEVICE_ALREADY_ENROLLED");
});

test("DEVICE storage: the public key is stored, counter recorded, and no private key material is kept", async () => {
  const sid = await studentId(studentB.userId);
  const rows = await pool.query(
    `SELECT credential_id, credential_public_key, counter, transports, cred_type,
            aaguid, label, status
     FROM student_devices
     WHERE student_id = $1
     ORDER BY id
     LIMIT 1`,
    [sid]
  );
  assert.equal(rows.rowCount, 1);
  const row = rows.rows[0];
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.cred_type, "public-key");
  assert.equal(row.label, "Work Laptop");
  assert.ok(Buffer.isBuffer(row.credential_public_key));
  assert.ok(row.credential_public_key.length > 0, "COSE public key must be stored");
  assert.deepEqual(row.transports, ["internal"]);
  assert.ok(Number.isInteger(Number(row.counter)) && Number(row.counter) >= 0);
  assert.equal(typeof row.aaguid, "string");

  // A stored device row must never contain private key material. Decode the COSE
  // EC2 public key and verify it exposes only the public parameters: kty (1) = EC2 (2),
  // alg (3) = ES256 (-7), crv (-1) = P-256 (1), x (-2) and y (-3) — and crucially no
  // private exponent parameter (key -4, the "d" value).
  const publicBytes = row.credential_public_key;
  const coseKey = isoCBOR.decodeFirst<Map<number, unknown>>(publicBytes);
  assert.ok(coseKey instanceof Map, "stored public key must decode as a COSE map");
  assert.equal(coseKey.get(1), 2, "kty must be EC2");
  assert.equal(coseKey.get(3), -7, "alg must be ES256");
  assert.equal(coseKey.get(-1), 1, "crv must be P-256");
  assert.ok(coseKey.get(-2) instanceof Uint8Array, "x coordinate must be present");
  assert.ok(coseKey.get(-3) instanceof Uint8Array, "y coordinate must be present");
  assert.equal(coseKey.has(-4), false, "must never hold the private 'd' parameter");
});

test("DEVICE storage: the certificate cannot be enrolled by another student (credential ID is unique)", async () => {
  assert.ok(enrolledAuthenticator, "prerequisite: student B enrolled a device");
  const options = await requestOptions(studentC.userId);
  const credential = await buildRegistrationResponse({
    authenticator: enrolledAuthenticator!,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  // The signature and challenge verify fine for student C, but the credential ID is taken.
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentC.userId)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "CREDENTIAL_IN_USE");
});

test("DEVICE complete: a challenge is one-time use and cannot be replayed", async () => {
  const options = await requestOptions(studentC.userId);
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const first = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentC.userId)
  );
  assert.equal(first.status, 201);

  const second = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentC.userId)
  );
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error, "INVALID_CHALLENGE");
});

test("DEVICE complete: an expired challenge is rejected", async () => {
  const options = await requestOptions(studentD.userId);
  const sid = await studentId(studentD.userId);
  await pool.query(
    `UPDATE student_device_enrollment_challenges
     SET created_at = now() - interval '11 minutes'
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [sid]
  );

  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentD.userId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_CHALLENGE");
});

test("DEVICE complete: a tampered attestation (bad signature) is rejected with INVALID_CREDENTIAL", async () => {
  const options = await requestOptions(studentD.userId);
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  // Corrupt one byte inside the attestation so signature verification must fail.
  const raw = Buffer.from(credential.response.attestationObject, "base64url");
  raw[raw.length - 6] ^= 0xff;
  credential.response.attestationObject = raw.toString("base64url");

  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentD.userId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_CREDENTIAL");
});

test("DEVICE complete: a challenge that does not match the signed payload is rejected", async () => {
  const options = await requestOptions(studentD.userId);
  const authenticator = await createTestAuthenticator();
  // Build a valid attestation but with a DIFFERENT challenge than the issued one.
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: "a-signed-challenge-that-is-not-the-issued-one",
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(studentD.userId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_CHALLENGE");
});

test("DEVICE complete: labels are display metadata and are not unique", async () => {
  const options = await requestOptions(studentD.userId);
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: options.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential, label: "Work Laptop" },
    cookieHeader(studentD.userId)
  );
  // student B already has a device labeled "Work Laptop"; labels must coexist.
  assert.equal(res.status, 201);
});

test("DEVICE helper: verifyStudentRegistration accepts a valid payload and rejects an invalid one", async () => {
  const challenge = "standalone-helper-challenge-" + Date.now();
  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });

  const ok = await verifyStudentRegistration({
    response: credential,
    expectedChallenge: challenge,
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.credential.id, credential.id);
    assert.equal(ok.aaguid.length > 0, true);
  }

  const bad = await verifyStudentRegistration({
    response: credential,
    expectedChallenge: "wrong-challenge",
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(bad.ok, false);
});

test("DEVICE helper: verifyStudentDevice accepts a valid assertion and returns the new counter", async () => {
  const challenge = "assertion-helper-challenge-" + Date.now();
  const authenticator = await createTestAuthenticator();

  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: "registration-for-assertion",
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const registration = await verifyStudentRegistration({
    response: credential,
    expectedChallenge: "registration-for-assertion",
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(registration.ok, true);

  if (registration.ok) {
    const assertion = await buildAuthenticationResponse({
      authenticator,
      challenge,
      origin: webauthnConfig.expectedOrigin,
      rpId: webauthnConfig.rpID,
      signCount: 7,
    });
    const result = await verifyStudentDevice({
      credential: {
        id: registration.credential.id,
        publicKey: registration.credential.publicKey,
        counter: 1,
        transports: ["internal"],
      },
      response: assertion,
      expectedChallenge: challenge,
      expectedOrigin: webauthnConfig.expectedOrigin,
      expectedRPID: webauthnConfig.rpID,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.credentialID, registration.credential.id);
      assert.equal(result.newCounter, 7);
    }
  }
});

test("DEVICE helper: verifyStudentDevice rejects a wrong-origin assertion", async () => {
  const challenge = "assertion-wrong-origin-" + Date.now();
  const authenticator = await createTestAuthenticator();

  const registration = await verifyStudentRegistration({
    response: await buildRegistrationResponse({
      authenticator,
      challenge: "registration-for-origin",
      origin: webauthnConfig.expectedOrigin,
      rpId: webauthnConfig.rpID,
    }),
    expectedChallenge: "registration-for-origin",
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(registration.ok, true);

  if (registration.ok) {
    const assertion = await buildAuthenticationResponse({
      authenticator,
      challenge,
      origin: "https://evil.example.com",
      rpId: webauthnConfig.rpID,
    });
    const result = await verifyStudentDevice({
      credential: {
        id: registration.credential.id,
        publicKey: registration.credential.publicKey,
        counter: 1,
      },
      response: assertion,
      expectedChallenge: challenge,
      expectedOrigin: webauthnConfig.expectedOrigin,
      expectedRPID: webauthnConfig.rpID,
    });
    assert.equal(result.ok, false);
  }
});

test("DEVICE schema: exactly one active device per student is enforced at the DB level", async () => {
  const sid = await studentId(studentB.userId);
  const insert = () =>
    pool.query(
      `INSERT INTO student_devices (student_id, credential_id, credential_public_key)
       VALUES ($1, $2, $3)`,
      [sid, "second-active-credential", Buffer.from([0xde, 0xad, 0xbe, 0xef])]
    );
  await assert.rejects(
    insert,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
  );
});

// ---------------------------------------------------------------------------
// WebAuthn account label: user.name must never be a real identifier
// ---------------------------------------------------------------------------

test("DEVICE options: user.name is a non-sensitive label, never the matric number or a student id", async () => {
  const res = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(labelStudent.userId)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { user: { id: string; name: string; displayName: string } };
  };

  const user = body.data.user;
  const sid = await studentId(labelStudent.userId);

  // The label must be a stable, non-sensitive string.
  assert.match(user.name, /^oou-student-[0-9a-z]{12}$/);

  // It must not leak the matric number in any form.
  assert.ok(
    !user.name.includes(labelStudent.matric!) && !user.name.includes("DEV"),
    `user.name must not contain the matric number, got: ${user.name}`
  );

  // It must not be the student's name, and must not be a sequential database id.
  assert.notEqual(user.name, labelStudent.name);
  assert.notEqual(user.name, String(sid));
  assert.notEqual(user.name, user.id);

  // `user.id` remains the opaque per-student handle, not a sequential id. SimpleWebAuthn
  // base64url-encodes the userID bytes it is given, which here are the handle's raw bytes.
  const handle = (
    await pool.query(`SELECT webauthn_user_handle FROM students WHERE id = $1`, [sid])
  ).rows[0].webauthn_user_handle as string;
  assert.equal(
    Buffer.from(isoBase64URL.toBuffer(user.id)).toString("utf8"),
    handle
  );
  assert.notEqual(user.id, String(sid));
  assert.ok(handle.length >= 12);
  assert.ok(user.name.endsWith(handle.slice(0, 12).toLowerCase()));

  // `displayName` is the student's own registered name, which is correct for their own
  // credential list and is not the label we are protecting.
  assert.equal(user.displayName, labelStudent.name);
});

test("DEVICE options: the account label is stable across repeated calls", async () => {
  // WebAuthn requires `user.name` to be stable: an authenticator treats a change as a
  // different account, so a per-call random label would fragment the student's passkeys.
  const fetchUser = async () => {
    const res = await postJson(
      "/api/student/device/enrollment/options",
      {},
      cookieHeader(labelStudent.userId)
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { challenge: string; user: { id: string; name: string } };
    };
    return body.data;
  };

  const first = await fetchUser();
  const second = await fetchUser();

  assert.equal(second.user.name, first.user.name);
  assert.equal(second.user.id, first.user.id);
  // Only the challenge is meant to change between calls.
  assert.notEqual(second.challenge, first.challenge);
});

// ---------------------------------------------------------------------------
// Discoverability detection
// ---------------------------------------------------------------------------

test("DEVICE detect: a resident-key registration is recorded as discoverable", async () => {
  const authenticator = await createTestAuthenticator();
  const result = await verifyStudentRegistration({
    response: await buildRegistrationResponse({
      authenticator,
      challenge: "discoverable-detection",
      origin: webauthnConfig.expectedOrigin,
      rpId: webauthnConfig.rpID,
    }),
    expectedChallenge: "discoverable-detection",
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.discoverable, true);
  }
});

test("DEVICE detect: a registration without backup flags is recorded as non-discoverable", async () => {
  const authenticator = await createTestAuthenticator();
  const result = await verifyStudentRegistration({
    response: await buildRegistrationResponse({
      authenticator,
      challenge: "legacy-detection",
      origin: webauthnConfig.expectedOrigin,
      rpId: webauthnConfig.rpID,
      flags: LEGACY_REGISTRATION_FLAGS,
    }),
    expectedChallenge: "legacy-detection",
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.discoverable, false);
  }
});

test("DEVICE detect: an explicit credProps.rk report is trusted over the flags", async () => {
  // The `creds` extension is the direct statement of resident-key creation, so it must win even
  // when the authenticator data flags carry no backup information.
  const authenticator = await createTestAuthenticator();
  const result = await verifyStudentRegistration({
    response: await buildRegistrationResponse({
      authenticator,
      challenge: "credprops-detection",
      origin: webauthnConfig.expectedOrigin,
      rpId: webauthnConfig.rpID,
      flags: LEGACY_REGISTRATION_FLAGS,
      clientExtensionResults: { credProps: { rk: true } },
    }),
    expectedChallenge: "credprops-detection",
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.discoverable, true);
  }
});

test("DEVICE detect: a credProps.rk=false report is trusted over the flags", async () => {
  const authenticator = await createTestAuthenticator();
  const result = await verifyStudentRegistration({
    response: await buildRegistrationResponse({
      authenticator,
      challenge: "credprops-negative",
      origin: webauthnConfig.expectedOrigin,
      rpId: webauthnConfig.rpID,
      clientExtensionResults: { credProps: { rk: false } },
    }),
    expectedChallenge: "credprops-negative",
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.discoverable, false);
  }
});

// ---------------------------------------------------------------------------
// Legacy (non-discoverable) credential upgrade
// ---------------------------------------------------------------------------

/**
 * Enrol a credential for the upgrade student, optionally forcing a non-discoverable
 * authenticator, and return the resulting credential id.
 */
async function enrollCredentialForUpgrade(
  options: { flags?: number } = {}
): Promise<{ credentialId: string; authenticator: TestAuthenticator }> {
  const opts = await requestOptions(upgradeStudent.userId);
  const authenticator = await createTestAuthenticator();
  const registration = await buildRegistrationResponse({
    authenticator,
    challenge: opts.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    ...(options.flags !== undefined ? { flags: options.flags } : {}),
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential: registration, label: "legacy" },
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { credentialId: string };
  return { credentialId: body.credentialId, authenticator };
}

async function deviceRowsForUpgradeStudent(): Promise<
  Array<{
    id: number;
    credential_id: string;
    status: string;
    discoverable: boolean | null;
    revoked_at: Date | null;
  }>
> {
  const sid = await studentId(upgradeStudent.userId);
  const res = await pool.query(
    `SELECT id, credential_id, status, discoverable, revoked_at
     FROM student_devices
     WHERE student_id = $1
     ORDER BY id`,
    [sid]
  );
  return res.rows.map((row) => ({
    id: Number(row.id),
    credential_id: row.credential_id as string,
    status: row.status as string,
    discoverable: row.discoverable === null ? null : Boolean(row.discoverable),
    revoked_at: row.revoked_at,
  }));
}

async function resolveAttendanceDevice(
  userId: number
): Promise<{ credentialId: string } | null> {
  const res = await pool.query(
    `SELECT d.credential_id
     FROM student_devices d
     JOIN students s ON s.id = d.student_id
     WHERE s.user_id = $1 AND d.status = 'ACTIVE'
     ORDER BY d.enrolled_at DESC, d.id DESC
     LIMIT 1`,
    [userId]
  );
  if (res.rowCount === 0) {
    return null;
  }
  return { credentialId: res.rows[0].credential_id as string };
}

test("DEVICE upgrade: a non-discoverable credential is enrolled and recorded as such", async () => {
  const { credentialId } = await enrollCredentialForUpgrade({
    flags: LEGACY_REGISTRATION_FLAGS,
  });
  const rows = await deviceRowsForUpgradeStudent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].credential_id, credentialId);
  assert.equal(rows[0].status, "ACTIVE");
  assert.equal(
    rows[0].discoverable,
    false,
    "a credential without backup flags must be recorded as non-discoverable"
  );
});

test("DEVICE upgrade: a pre-migration device (discoverable NULL) is offered an upgrade", async () => {
  // Reproduce a device enrolled before migration 010: the column did not exist, so the fact is
  // unknown. NULL must be treated as "not usable for usernameless login" and routed to the
  // upgrade flow rather than silently accepted.
  await pool.query(
    `UPDATE student_devices SET discoverable = NULL WHERE student_id = $1`,
    [await studentId(upgradeStudent.userId)]
  );

  const res = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(
    res.status,
    200,
    "a legacy device must not block a new enrollment/upgrade"
  );
  const body = (await res.json()) as {
    data: { excludeCredentials?: Array<{ id: string }> };
    enrollmentMode: string;
  };
  assert.equal(body.enrollmentMode, "UPGRADE");
  const rows = await deviceRowsForUpgradeStudent();
  assert.ok(
    (body.data.excludeCredentials ?? []).some((c) => c.id === rows[0].credential_id),
    "the legacy credential must be excluded so the upgrade cannot re-enrol it unchanged"
  );
});

test("DEVICE upgrade: completing the upgrade revokes the old row and activates the new one atomically", async () => {
  const oldCredentialId = (await deviceRowsForUpgradeStudent())[0].credential_id;

  const opts = await requestOptions(upgradeStudent.userId);
  const authenticator = await createTestAuthenticator();
  const registration = await buildRegistrationResponse({
    authenticator,
    challenge: opts.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential: registration, label: "upgraded" },
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    credentialId: string;
    replacedCredentialId: string | null;
    discoverable: boolean;
  };
  assert.notEqual(body.credentialId, oldCredentialId);
  assert.equal(body.replacedCredentialId, oldCredentialId);
  assert.equal(body.discoverable, true);

  const rows = await deviceRowsForUpgradeStudent();
  assert.equal(rows.length, 2, "the old row is revoked, never deleted");
  const oldRow = rows.find((r) => r.credential_id === oldCredentialId)!;
  const newRow = rows.find((r) => r.credential_id === body.credentialId)!;
  assert.equal(oldRow.status, "REVOKED");
  assert.ok(oldRow.revoked_at, "the revoked row must record when it was revoked");
  assert.equal(newRow.status, "ACTIVE");
  assert.equal(newRow.discoverable, true);
  assert.equal(
    rows.filter((r) => r.status === "ACTIVE").length,
    1,
    "exactly one device must be ACTIVE after the upgrade"
  );

  // Attendance now resolves the replacement; the revoked row is not returned.
  const attendance = await resolveAttendanceDevice(upgradeStudent.userId);
  assert.equal(attendance?.credentialId, body.credentialId);
});

test("DEVICE upgrade: the replaced credential is recorded in the audit log", async () => {
  const actions = (
    await pool.query(
      `SELECT action FROM audit_logs
       WHERE user_id = $1 AND entity_type = 'student_devices'
       ORDER BY id`,
      [upgradeStudent.userId]
    )
  ).rows.map((r: { action: string }) => r.action);
  assert.ok(
    actions.includes("DEVICE_CREDENTIAL_REPLACED"),
    "replacing a legacy credential must be auditable"
  );
});

test("DEVICE upgrade: a discoverable device cannot be rotated again", async () => {
  const res = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "DEVICE_ALREADY_ENROLLED");
});

test("DEVICE upgrade: a failed upgrade leaves the legacy credential ACTIVE for attendance", async () => {
  // Give the student a fresh legacy device, then fail an upgrade on purpose.
  await pool.query(
    `UPDATE student_devices SET discoverable = NULL WHERE student_id = $1`,
    [await studentId(upgradeStudent.userId)]
  );
  const before = (await deviceRowsForUpgradeStudent()).find(
    (r) => r.status === "ACTIVE"
  )!;
  const credentialIdsBefore = (await deviceRowsForUpgradeStudent()).map(
    (r) => r.credential_id
  );

  const opts = await requestOptions(upgradeStudent.userId);
  const authenticator = await createTestAuthenticator();
  // A registration signed for the wrong origin never verifies, so the transaction must abort
  // before any row is touched.
  const badRegistration = await buildRegistrationResponse({
    authenticator,
    challenge: opts.challenge,
    origin: "https://evil.example.com",
    rpId: webauthnConfig.rpID,
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential: badRegistration, label: "doomed" },
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_CREDENTIAL");

  const after = await deviceRowsForUpgradeStudent();
  assert.deepEqual(
    after.map((r) => r.credential_id).sort(),
    credentialIdsBefore.sort(),
    "a failed upgrade must not add, revoke, or drop any row"
  );
  const stillActive = after.find((r) => r.credential_id === before.credential_id)!;
  assert.equal(
    stillActive.status,
    "ACTIVE",
    "the legacy credential must survive a failed upgrade"
  );
  assert.equal(stillActive.revoked_at, null);
  assert.equal(
    after.filter((r) => r.status === "ACTIVE").length,
    1,
    "the student must still hold exactly one usable device"
  );

  // The student is therefore never locked out of attendance.
  const attendance = await resolveAttendanceDevice(upgradeStudent.userId);
  assert.equal(attendance?.credentialId, before.credential_id);
});

test("DEVICE upgrade: re-enrolling the identical legacy credential is refused", async () => {
  // Revoking and re-inserting the same credential would reset its stored signature counter back
  // to the registration value, weakening clone detection while gaining nothing.
  const before = (await deviceRowsForUpgradeStudent()).find(
    (r) => r.status === "ACTIVE"
  )!;
  const credentialIdsBefore = (await deviceRowsForUpgradeStudent()).map(
    (r) => r.credential_id
  );
  const opts = await requestOptions(upgradeStudent.userId);
  const authenticator = await createTestAuthenticator();
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    {
      credential: {
        id: before.credential_id,
        rawId: before.credential_id,
        type: "public-key" as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: "",
          attestationObject: "",
          transports: ["internal"] as ("internal" | "usb" | "nfc" | "ble" | "hybrid")[],
          publicKeyAlgorithm: -7,
        },
      },
      label: "same",
    },
    cookieHeader(upgradeStudent.userId)
  );
  // The malformed body is rejected before the credential check; either way the legacy device
  // must be untouched.
  assert.equal(res.status, 400);
  const after = await deviceRowsForUpgradeStudent();
  assert.deepEqual(
    after.map((r) => r.credential_id).sort(),
    credentialIdsBefore.sort(),
    "a refused re-enrolment must not add, revoke, or drop any row"
  );
  assert.equal(after.find((r) => r.credential_id === before.credential_id)!.status, "ACTIVE");
  assert.equal(
    after.filter((r) => r.status === "ACTIVE").length,
    1,
    "the legacy credential must remain the single usable device"
  );
});

test("DEVICE upgrade: the usernameless login ceremony still never names credentials", async () => {
  // While the student still holds only a legacy credential, the usernameless ceremony must stay
  // credential-agnostic: it must never add allowCredentials, because naming a non-discoverable
  // credential would make the client assert one that the identity model does not accept.
  const res = await postJson("/api/auth/student/device/options", {}, {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { allowCredentials?: unknown };
  };
  assert.equal(
    body.data.allowCredentials === undefined,
    true,
    "usernameless login must never name credentials for the client"
  );
});

// ---------------------------------------------------------------------------
// Reset scenarios must keep re-enrolment possible
// ---------------------------------------------------------------------------

test("DEVICE reset: an admin device reset lets the student enrol a fresh credential", async () => {
  const sid = await studentId(upgradeStudent.userId);
  const before = await deviceRowsForUpgradeStudent();
  const revokedCredentialId = before.find((r) => r.status === "ACTIVE")!.credential_id;

  const resetRes = await postJson(
    `/api/admin/students/${sid}/device/reset`,
    {},
    cookieHeader(adminUser.userId)
  );
  assert.equal(resetRes.status, 200);

  const afterReset = await deviceRowsForUpgradeStudent();
  assert.equal(
    afterReset.find((r) => r.credential_id === revokedCredentialId)!.status,
    "REVOKED"
  );
  assert.equal(
    afterReset.filter((r) => r.status === "ACTIVE").length,
    0,
    "a reset must leave the student with no active device"
  );

  // With no ACTIVE device the next ceremony is a plain enrollment, not an upgrade, and the
  // previously revoked credential is still excluded so the authenticator creates a new one.
  const optsRes = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(optsRes.status, 200);
  const optsBody = (await optsRes.json()) as {
    data: { challenge: string; excludeCredentials?: Array<{ id: string }> };
    enrollmentMode: string;
  };
  assert.equal(optsBody.enrollmentMode, "ENROLL");
  assert.ok(
    (optsBody.data.excludeCredentials ?? []).some(
      (c) => c.id === revokedCredentialId
    ),
    "a revoked credential must stay excluded so a new one is created"
  );

  const authenticator = await createTestAuthenticator();
  const completeRes = await postJson(
    "/api/student/device/enrollment/complete",
    {
      credential: await buildRegistrationResponse({
        authenticator,
        challenge: optsBody.data.challenge,
        origin: webauthnConfig.expectedOrigin,
        rpId: webauthnConfig.rpID,
      }),
      label: "after reset",
    },
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(completeRes.status, 201);
  const completeBody = (await completeRes.json()) as {
    credentialId: string;
    replacedCredentialId: string | null;
  };
  assert.equal(
    completeBody.replacedCredentialId,
    null,
    "a post-reset enrollment replaces nothing"
  );
  assert.notEqual(completeBody.credentialId, revokedCredentialId);

  const final = await deviceRowsForUpgradeStudent();
  assert.equal(final.filter((r) => r.status === "ACTIVE").length, 1);
  assert.equal(
    final.find((r) => r.credential_id === completeBody.credentialId)!.status,
    "ACTIVE"
  );
});

test("DEVICE reset: a student registration reset revokes the active device and publishes it", async () => {
  const sid = await studentId(upgradeStudent.userId);
  const before = await deviceRowsForUpgradeStudent();
  const active = before.find((r) => r.status === "ACTIVE");
  assert.ok(active, "the student must hold an active device before the reset");

  // Device rows carry their own sync identity (migration 021); the reset publishes
  // the revocation against it so the edge can retire the active binding.
  const deviceRow = await pool.query(
    `SELECT sync_id FROM student_devices WHERE id = $1`,
    [active.id]
  );
  assert.equal(deviceRow.rowCount, 1);
  const deviceSyncId = deviceRow.rows[0].sync_id as string;

  const resetRes = await postJson(
    `/api/admin/students/${sid}/reset-registration`,
    {},
    cookieHeader(adminUser.userId)
  );
  assert.equal(resetRes.status, 200);
  const resetBody = (await resetRes.json()) as { data: { status: string } };
  assert.equal(
    resetBody.data.status,
    "PENDING",
    "the account must return to the unclaimed state"
  );

  // A registration reset revokes the active device so a single action fully releases
  // the account for fresh enrollment on a new phone. The row is revoked, never
  // deleted, so the credential stays auditable.
  const afterReset = await deviceRowsForUpgradeStudent();
  const revoked = afterReset.find((r) => r.credential_id === active.credential_id);
  assert.equal(
    revoked?.status,
    "REVOKED",
    "the active device must be revoked by a registration reset"
  );
  assert.ok(
    revoked?.revoked_at,
    "the revoked row must record when it was revoked"
  );
  assert.equal(
    afterReset.filter((r) => r.status === "ACTIVE").length,
    0,
    "the student must hold no usable device after the reset"
  );

  // Attendance no longer resolves a device while the account is PENDING.
  assert.equal(
    await resolveAttendanceDevice(upgradeStudent.userId),
    null,
    "no active device must remain for attendance"
  );

  // A PENDING account cannot start a fresh enrollment until it re-registers.
  const pendingRes = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(upgradeStudent.userId)
  );
  assert.equal(
    pendingRes.status,
    401,
    "a PENDING account must not be able to start an enrollment"
  );

  // The revocation is audited under the established device-reset action, in the
  // same transaction as the registration reset itself.
  const deviceResetAudit = await pool.query(
    `SELECT action, entity_type, entity_id FROM audit_logs
     WHERE action = 'STUDENT_DEVICE_RESET'
       AND entity_type = 'student_devices'
       AND entity_id = $1`,
    [active.id]
  );
  assert.equal(
    deviceResetAudit.rowCount,
    1,
    "the device revocation must be audited"
  );
  const registrationResetAudit = await pool.query(
    `SELECT action, entity_type, entity_id FROM audit_logs
     WHERE action = 'STUDENT_REGISTRATION_RESET'
       AND entity_type = 'users'
       AND entity_id = $1`,
    [upgradeStudent.userId]
  );
  assert.equal(
    registrationResetAudit.rowCount,
    1,
    "the registration reset itself must be audited"
  );

  // The revocation is published to the feed inside the same transaction, so the
  // edge sees the binding retired even while this K12 is offline.
  const feed = await pool.query(
    `SELECT operation, payload
     FROM sync_change_events
     WHERE entity_type = 'student_device'
       AND entity_id = $1
     ORDER BY cursor DESC`,
    [deviceSyncId]
  );
  const published = feed.rows[0];
  assert.ok(
    published,
    "a student_device feed event must be emitted for the revoked device"
  );
  assert.equal(published.operation, "UPDATED");
  assert.equal(
    (published.payload as { entity?: { status?: string } }).entity?.status,
    "REVOKED",
    "the feed must describe the revoked state, not the old one"
  );
});

test("DEVICE schema: exactly one active challenge per student is enforced at the DB level", async () => {
  const sid = await studentId(studentA.userId);
  const rows = await pool.query(
    `SELECT status FROM student_device_enrollment_challenges
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [sid]
  );
  assert.equal(rows.rowCount, 1, "student A must still hold an ACTIVE challenge");

  const insert = () =>
    pool.query(
      `INSERT INTO student_device_enrollment_challenges (student_id, challenge_hash)
       VALUES ($1, $2)`,
      [sid, "a-second-active-challenge"]
    );
  await assert.rejects(
    insert,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
  );
});