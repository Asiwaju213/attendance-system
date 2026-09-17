import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";
import {
  buildAuthenticationResponse,
  createTestAuthenticator,
  type TestAuthenticator,
} from "./webauthnTestHelpers";

const TEST_PASSWORD = "dvc-device-test-password";
const RUN_ID = Date.now().toString(36).toUpperCase();

const STUDENT_A_MATRIC = `DVC/STU/A/${RUN_ID}`;
const STUDENT_B_MATRIC = `DVC/STU/B/${RUN_ID}`;
const STUDENT_C_MATRIC = `DVC/STU/C/${RUN_ID}`;
const STUDENT_D_MATRIC = `DVC/STU/D/${RUN_ID}`;

let server: Server;
let baseUrl: string;
let passwordHash: string;

let studentAUserId = 0;
let studentBUserId = 0;
let inactiveUserId = 0;
let lecturerUserId = 0;

let studentAProfileId = 0;
let studentBProfileId = 0;
let studentCProfileId = 0;
let studentDProfileId = 0;

let authenticatorA: TestAuthenticator;
let authenticatorB: TestAuthenticator;
let authenticatorD: TestAuthenticator;
let authenticatorBad: TestAuthenticator;

let course1Id = 0;
let offering1Id = 0;
let network1Id = 0;
let location1Id = 0;
let markSessionIds: number[] = [];

const SESSION_IDS = () => markSessionIds;

function cookieFrom(res: globalThis.Response): string | null {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.cookieName}=`));
  if (!cookie) return null;
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

async function loginStudent(matricNumber: string): Promise<string> {
  const res = await postJson("/api/auth/student/login", {
    matricNumber,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res);
  assert.ok(token);
  return token!;
}

async function deviceChallenge(
  token: string
): Promise<{ challenge: string; options: Record<string, unknown> }> {
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(token)
  );
  const body = await res.json();
  return { challenge: (body as { data: { challenge: string } }).data.challenge, options: (body as { data: Record<string, unknown> }).data };
}

async function nextSignCount(auth: TestAuthenticator): Promise<number> {
  const stored = signCounts.get(auth) ?? 2;
  signCounts.set(auth, stored + 1);
  return stored;
}
const signCounts = new WeakMap<TestAuthenticator, number>();

async function buildAssertion(
  authenticator: TestAuthenticator,
  challenge: string,
  signCountOverride?: number
) {
  return buildAuthenticationResponse({
    authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: signCountOverride ?? (await nextSignCount(authenticator)),
  });
}

async function seedDevice(
  studentProfileId: number,
  authenticator: TestAuthenticator,
  status = "ACTIVE"
): Promise<void> {
  await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, status)
     VALUES ($1, $2, $3, 1, $4)`,
    [
      studentProfileId,
      isoBase64URL.fromBuffer(authenticator.credentialId),
      Buffer.from(authenticator.credentialPublicKey),
      status,
    ]
  );
}

async function cleanupDeviceData(): Promise<void> {
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number LIKE 'DVC/STU/%'
     )`
  );
  await pool.query(
    `DELETE FROM student_devices
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number LIKE 'DVC/STU/%'
     )`
  );
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

// -----------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------

before(async () => {
  passwordHash = await hashPassword(TEST_PASSWORD);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    [`DVC-FAC-${RUN_ID}`, `DVC-FAC-${RUN_ID}`]
  );
  const facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`DVC-DEP-${RUN_ID}`, `DVC-DEP-${RUN_ID}`, facId]
  );
  const depId = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  const levelId = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ($1, true) RETURNING id`,
    [`DVC-ACAD-${RUN_ID}`]
  );
  const academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  const semesterId = Number(sem.rows[0].id);

  course1Id = Number(
    (
      await pool.query(
        `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
         VALUES ($1, 'DVC Course', $2, $3, 'ACTIVE') RETURNING id`,
        [`DVC-C${RUN_ID}`, facId, levelId]
      )
    ).rows[0].id
  );

  offering1Id = Number(
    (
      await pool.query(
        `INSERT INTO course_offerings
           (course_id, academic_session_id, semester_id, status)
         VALUES ($1, $2, $3, 'OPEN') RETURNING id`,
        [course1Id, academicSessionId, semesterId]
      )
    ).rows[0].id
  );

  network1Id = Number(
    (
      await pool.query(
        `INSERT INTO attendance_networks (network_code, name)
         VALUES ($1, 'DVC Net') RETURNING id`,
        [`DVC-NET-${RUN_ID}`]
      )
    ).rows[0].id
  );

  location1Id = Number(
    (
      await pool.query(`INSERT INTO locations (name) VALUES ($1) RETURNING id`, [
        `DVC-LOC-${RUN_ID}`,
      ])
    ).rows[0].id
  );

  async function insertUser(
    name: string,
    status: string,
    matric?: string
  ): Promise<{ userId: number; profileId: number | null }> {
    const user = await pool.query(
      `INSERT INTO users (name, password_hash, role, status)
       VALUES ($1, $2, 'STUDENT', $3) RETURNING id`,
      [name, passwordHash, status]
    );
    const userId = Number(user.rows[0].id);
    let profileId: number | null = null;
    if (matric) {
      const stud = await pool.query(
        `INSERT INTO students (user_id, matric_number, department_id, level_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, matric, depId, levelId]
      );
      profileId = Number(stud.rows[0].id);
    }
    return { userId, profileId };
  }

  const a = await insertUser("DVC StudA", "ACTIVE", STUDENT_A_MATRIC);
  studentAUserId = a.userId;
  studentAProfileId = a.profileId!;

  const b = await insertUser("DVC StudB", "ACTIVE", STUDENT_B_MATRIC);
  studentBUserId = b.userId;
  studentBProfileId = b.profileId!;

  const c = await insertUser("DVC StudC", "ACTIVE", STUDENT_C_MATRIC);
  studentCProfileId = c.profileId!;

  const d = await insertUser("DVC StudD", "ACTIVE", STUDENT_D_MATRIC);
  studentDProfileId = d.profileId!;

  const inactive = await insertUser("DVC Inactive", "INACTIVE");
  inactiveUserId = inactive.userId;

  const lect = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ('DVC Lecturer', $1, 'LECTURER', 'ACTIVE') RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lect.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturerUserId, `DVC/LEC/${RUN_ID}`, depId]
  );

  authenticatorA = await createTestAuthenticator();
  authenticatorB = await createTestAuthenticator();
  authenticatorD = await createTestAuthenticator();
  authenticatorBad = await createTestAuthenticator();

  await seedDevice(studentAProfileId, authenticatorA);
  await seedDevice(studentBProfileId, authenticatorB);
  await seedDevice(studentDProfileId, authenticatorD, "REVOKED");

  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED'), ($3, $2, 'ENROLLED')`,
    [studentAProfileId, offering1Id, studentBProfileId]
  );

  const sessionIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    const sessionLect = await pool.query(
      `INSERT INTO users (name, password_hash, role, status)
       VALUES ($1, $2, 'LECTURER', 'ACTIVE') RETURNING id`,
      [`DVC-Lec${i}-${RUN_ID}`, passwordHash]
    );
    const sessionLectUserId = Number(sessionLect.rows[0].id);
    const sessionLectProfile = await pool.query(
      `INSERT INTO lecturers (user_id, staff_id, department_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [sessionLectUserId, `DVC/LEC/S${i}/${RUN_ID}`, depId]
    );
    sessionIds.push(
      Number(
        (
          await pool.query(
            `INSERT INTO attendance_sessions
               (course_offering_id, started_by_lecturer_id, attendance_network_id,
                location_id, start_time, end_time, late_threshold, status)
             VALUES ($1, $2, $3, $4,
                     now() - interval '1 minute', now() + interval '60 minutes',
                     interval '10 minutes', 'ACTIVE')
             RETURNING id`,
            [offering1Id, Number(sessionLectProfile.rows[0].id), network1Id, location1Id]
          )
        ).rows[0].id
      )
    );
  }
  markSessionIds = sessionIds;

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

  // Delete every DVC test fixture across runs, in FK-safe dependency order.
  // Cleanups are scoped by the DVC namespace (rather than this run's ids) so
  // a previously interrupted run can never block a later run's teardown.
  await pool.query(
    `DELETE FROM attendance_records WHERE session_id = ANY($1::BIGINT[])`,
    [SESSION_IDS()]
  );
  await pool.query(
    `DELETE FROM attendance_records
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number LIKE 'DVC/STU/%'
     )`
  );
  await pool.query(
    `DELETE FROM attendance_records
     WHERE session_id IN (
       SELECT id FROM attendance_sessions
       WHERE started_by_lecturer_id IN (
         SELECT id FROM lecturers WHERE staff_id LIKE 'DVC/LEC/%'
       )
     )`
  );
  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE started_by_lecturer_id IN (
       SELECT id FROM lecturers WHERE staff_id LIKE 'DVC/LEC/%'
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number LIKE 'DVC/STU/%'
     )
        OR course_offering_id IN (
          SELECT id FROM course_offerings
          WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'DVC-C%')
        )`
  );
  await cleanupDeviceData();
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'DVC-C%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'DVC-C%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'DVC-ACAD-%'`);
  await pool.query(
    `DELETE FROM attendance_networks WHERE network_code LIKE 'DVC-NET-%'`
  );
  await pool.query(`DELETE FROM locations WHERE name LIKE 'DVC-LOC-%'`);
  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (
       SELECT id FROM users WHERE name LIKE 'DVC %' OR name LIKE 'DVC-Lec%'
     )`
  );
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'DVC/STU/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'DVC/LEC/%'`);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'DVC %' OR name LIKE 'DVC-Lec%'`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'DVC-%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'DVC-%'`);
  await pool.end();
});

// -----------------------------------------------------------------------
// 1. Authentication: unauthenticated → 401
// -----------------------------------------------------------------------
test("DVC: unauthenticated challenge request is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/student/attendance/device-challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// -----------------------------------------------------------------------
// 2. Authorization: lecturer/admin → 403
// -----------------------------------------------------------------------
test("DVC: a lecturer cannot request a student device challenge", async () => {
  const token = generateSessionToken();
  await createSession(
    lecturerUserId,
    hashSessionToken(token),
    new Date(Date.now() + 3600_000)
  );
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 403);
  assertErrorCode(await res.json(), "FORBIDDEN");
});

// -----------------------------------------------------------------------
// 3. Authorization: inactive student → 401
// -----------------------------------------------------------------------
test("DVC: an inactive student is rejected", async () => {
  const token = generateSessionToken();
  await createSession(
    inactiveUserId,
    hashSessionToken(token),
    new Date(Date.now() + 3600_000)
  );
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// -----------------------------------------------------------------------
// 4. Student with no enrolled device → 409 NO_ENROLLED_DEVICE
// -----------------------------------------------------------------------
test("DVC: a student with no enrolled device gets NO_ENROLLED_DEVICE", async () => {
  const token = await loginStudent(STUDENT_C_MATRIC);
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "NO_ENROLLED_DEVICE");
});

// -----------------------------------------------------------------------
// 5. Student with inactive device → 409 DEVICE_NOT_ACTIVE
// -----------------------------------------------------------------------
test("DVC: a student with an inactive device gets DEVICE_NOT_ACTIVE", async () => {
  const token = await loginStudent(STUDENT_D_MATRIC);
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "DEVICE_NOT_ACTIVE");
});

// -----------------------------------------------------------------------
// 6-7. Valid challenge: 200 with allowCredentials, challenge present
// -----------------------------------------------------------------------
test("DVC: a valid device challenge returns 200 with options", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const { options } = await deviceChallenge(token);

  assert.equal(options.rpId, webauthnConfig.rpID);
  assert.equal(typeof options.challenge, "string");
  assert.ok(
    (options.challenge as string).length > 0,
    "challenge must be non-empty"
  );
  const allowCredentials = options.allowCredentials as
    | { id: string }[]
    | undefined;
  assert.ok(
    Array.isArray(allowCredentials) && allowCredentials.length === 1,
    "allowCredentials must contain exactly one entry"
  );
  assert.equal(
    allowCredentials![0].id,
    isoBase64URL.fromBuffer(authenticatorA.credentialId),
    "allowCredentials ID must match enrolled device"
  );
});

// -----------------------------------------------------------------------
// 7. Challenge is hash-only (raw challenge not stored in DB)
// -----------------------------------------------------------------------
test("DVC: the challenge is stored as a hash only (raw challenge not persisted)", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const { challenge } = await deviceChallenge(token);

  const hash = hashSessionToken(challenge);
  const row = await pool.query(
    `SELECT challenge_hash FROM student_device_enrollment_challenges
     WHERE student_id = $1 AND challenge_hash = $2 AND status = 'ACTIVE'`,
    [studentAProfileId, hash]
  );
  assert.equal(row.rows.length, 1, "hash must match a stored row");
  assert.notEqual(row.rows[0].challenge_hash, challenge, "stored value must be the hash, not the raw challenge");
});

// -----------------------------------------------------------------------
// 8. Expired challenge → 400 CHALLENGE_EXPIRED
// -----------------------------------------------------------------------
test("DVC: an expired challenge is rejected with CHALLENGE_EXPIRED", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const { challenge } = await deviceChallenge(token);

  await pool.query(
    `UPDATE student_device_enrollment_challenges
     SET created_at = now() - interval '10 minutes'
     WHERE student_id = $1 AND challenge_hash = $2`,
    [studentAProfileId, hashSessionToken(challenge)]
  );

  const assertion = await buildAssertion(authenticatorA, challenge);
  const res = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[0], assertion },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertErrorCode(await res.json(), "CHALLENGE_EXPIRED");
});

// -----------------------------------------------------------------------
// 9. Challenge reused after successful consumption → 400
// -----------------------------------------------------------------------
test("DVC: a challenge reused after consumption is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const { challenge: ch1 } = await deviceChallenge(token);
  const assertion1 = await buildAssertion(authenticatorA, ch1);
  const mark1 = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[0], assertion: assertion1 },
    cookieHeader(token)
  );
  assert.equal(mark1.status, 201, "first mark must succeed");

  const { challenge: ch2 } = await deviceChallenge(token);
  const assertion2 = await buildAssertion(authenticatorA, ch2);
  const mark2 = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[0], assertion: assertion2 },
    cookieHeader(token)
  );
  assert.equal(mark2.status, 409);
  assertErrorCode(await mark2.json(), "ALREADY_MARKED");

  const reuse = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[0], assertion: assertion1 },
    cookieHeader(token)
  );
  assert.equal(reuse.status, 400);
  const body = await reuse.json();
  assertErrorCode(body, "CHALLENGE_ALREADY_USED");
});

// -----------------------------------------------------------------------
// 10. Wrong student's challenge → 400 INVALID_CHALLENGE
// -----------------------------------------------------------------------
test("DVC: using student A's challenge for student B yields INVALID_CHALLENGE", async () => {
  const tokenA = await loginStudent(STUDENT_A_MATRIC);
  const tokenB = await loginStudent(STUDENT_B_MATRIC);

  const { challenge: challengeA } = await deviceChallenge(tokenA);
  const assertionB = await buildAssertion(authenticatorB, challengeA);
  const res = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[0], assertion: assertionB },
    cookieHeader(tokenB)
  );
  assert.equal(res.status, 400);
  assertErrorCode(await res.json(), "INVALID_CHALLENGE");
});

// -----------------------------------------------------------------------
// 11. Assertion signed by unenrolled authenticator → 400 INVALID_DEVICE_ASSERTION
// -----------------------------------------------------------------------
test("DVC: an assertion signed by an unenrolled authenticator is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const { challenge } = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticatorBad, challenge);
  const res = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[0], assertion },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertErrorCode(await res.json(), "INVALID_DEVICE_ASSERTION");
});

// -----------------------------------------------------------------------
// 12. Valid device proof → 201 PRESENT
// -----------------------------------------------------------------------
test("DVC: a valid device proof with a valid session results in 201 PRESENT", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const { challenge } = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticatorA, challenge);
  const res = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[1], assertion },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "PRESENT");
  assert.equal(body.data.attendanceSessionId, markSessionIds[1]);
});

// -----------------------------------------------------------------------
// 13. Attendance POST without an assertion → 400 INVALID_REQUEST
// -----------------------------------------------------------------------
test("DVC: posting attendance without an assertion is rejected as INVALID_REQUEST", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[2] },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assertErrorCode(await res.json(), "INVALID_REQUEST");
});

// -----------------------------------------------------------------------
// 14. Replay: same assertion+challenge after consumption → 400
// -----------------------------------------------------------------------
test("DVC: replaying a consumed assertion+challenge is rejected", async () => {
  const token = await loginStudent(STUDENT_B_MATRIC);
  const { challenge } = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticatorB, challenge);
  const first = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[2], assertion },
    cookieHeader(token)
  );
  assert.equal(first.status, 201);

  const replay = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[2], assertion },
    cookieHeader(token)
  );
  assert.equal(replay.status, 400);
  assertErrorCode(await replay.json(), "CHALLENGE_ALREADY_USED");
});

// -----------------------------------------------------------------------
// 15. Duplicate attendance protection still works
// -----------------------------------------------------------------------
test("DVC: marking attendance twice for the same session is 409 ALREADY_MARKED", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);

  const { challenge: ch1 } = await deviceChallenge(token);
  const a1 = await buildAssertion(authenticatorA, ch1);
  const first = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[3], assertion: a1 },
    cookieHeader(token)
  );
  assert.equal(first.status, 201);

  const { challenge: ch2 } = await deviceChallenge(token);
  const a2 = await buildAssertion(authenticatorA, ch2);
  const second = await postJson(
    "/api/student/attendance",
    { attendanceSessionId: markSessionIds[3], assertion: a2 },
    cookieHeader(token)
  );
  assert.equal(second.status, 409);
  assertErrorCode(await second.json(), "ALREADY_MARKED");
});

// -----------------------------------------------------------------------
// 16. Concurrent marking: exactly one record created
// -----------------------------------------------------------------------
test("DVC: concurrent marking attempts create exactly one record", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);

  const { challenge: ch1 } = await deviceChallenge(token);
  const { challenge: ch2 } = await deviceChallenge(token);
  const a1 = await buildAssertion(authenticatorA, ch1);
  const a2 = await buildAssertion(authenticatorA, ch2);

  const [res1, res2] = await Promise.all([
    postJson(
      "/api/student/attendance",
      { attendanceSessionId: markSessionIds[4], assertion: a1 },
      cookieHeader(token)
    ),
    postJson(
      "/api/student/attendance",
      { attendanceSessionId: markSessionIds[4], assertion: a2 },
      cookieHeader(token)
    ),
  ]);

  const statuses = [res1.status, res2.status].sort((a, b) => a - b);
  assert.equal(
    statuses[0],
    201,
    "one request must succeed; the other must fail without duplicating the record"
  );
  const loser = res1.status === 201 ? res2 : res1;
  const loserBody = await loser.json();
  const loserCode = (loserBody as { error: string }).error;
  assert.ok(
    loserCode === "CHALLENGE_ALREADY_USED" ||
      loserCode === "CHALLENGE_EXPIRED" ||
      loserCode === "ALREADY_MARKED",
    `loser must report a device/challenge or duplicate error, got ${loserCode}`
  );

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_records
     WHERE session_id = $1 AND student_id = $2`,
    [markSessionIds[4], studentAProfileId]
  );
  assert.equal(count.rows[0].n, 1, "only one attendance record must exist");
});
