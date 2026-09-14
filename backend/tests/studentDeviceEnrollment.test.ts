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
  type TestAuthenticator,
} from "./webauthnTestHelpers";
import { isoCBOR } from "@simplewebauthn/server/helpers";

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
  assert.equal((body.data.user as { name: string }).name, `DEV/${RUN_ID}/1`);
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