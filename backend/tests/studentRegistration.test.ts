import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import {
  generateSessionToken,
  hashSessionToken,
} from "../src/lib/sessions";
import { hashPassword, verifyPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "student-registration-test-password";
const REGISTRATION_PASSWORD = "s3cure-registration-pass";

let server: Server;
let baseUrl: string;
let departmentId: number;
let levelId: number;
let passwordHash: string;

const pendingIds: Record<string, number> = {};

const PENDINGS = [
  ["REGST/0001", "Registration One"],
  ["REGST/0005", "Registration Five"],
  ["REGST/0006", "Registration Six"],
  ["REGST/0007", "Registration Seven"],
  ["REGST/0008", "Registration Eight"],
  ["REGST/0009", "Registration Nine"],
  ["REGST/0010", "Registration Ten"],
  ["REGST/0011", "Registration Eleven"],
  ["REGST/0012", "Registration Twelve"],
  ["REGST/0013", "Registration Thirteen"],
] as const;

let activeStudentId = 0;
let inactiveStudentId = 0;
let nonStudentId = 0;

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

async function userState(userId: number): Promise<{ status: string; hash: string | null }> {
  const res = await pool.query(
    `SELECT status, password_hash FROM users WHERE id = $1`,
    [userId]
  );
  return { status: res.rows[0].status, hash: res.rows[0].password_hash };
}

before(async () => {
  await pool.query(
    `INSERT INTO faculties (name, code)
     VALUES ('Student Registration Test Faculty', 'REGSTFAC')
     ON CONFLICT (code) DO NOTHING`
  );
  const facultyRes = await pool.query(
    `SELECT id FROM faculties WHERE code = 'REGSTFAC'`
  );
  const facultyId = Number(facultyRes.rows[0].id);

  const dept = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Student Registration Test Department', 'REGSTDEP', $1)
     ON CONFLICT (code) DO NOTHING`,
    [facultyId]
  );
  if ((dept.rowCount ?? 0) === 0) {
    const existing = await pool.query(
      `SELECT id FROM departments WHERE code = 'REGSTDEP'`
    );
    departmentId = Number(existing.rows[0].id);
  } else {
    const created = await pool.query(
      `SELECT id FROM departments WHERE code = 'REGSTDEP'`
    );
    departmentId = Number(created.rows[0].id);
  }
  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelId = Number(level.rows[0].id);

  passwordHash = await hashPassword(TEST_PASSWORD);

  async function insertStudent(
    name: string,
    role: string,
    status: string,
    hash: string | null,
    matric: string
  ): Promise<number> {
    const userRes = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, NULL)
       RETURNING id`,
      [name, hash, role, status]
    );
    const userId = Number(userRes.rows[0].id);
    await pool.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, matric, departmentId, levelId]
    );
    return userId;
  }

  for (const [matric, name] of PENDINGS) {
    pendingIds[matric] = await insertStudent(
      name,
      "STUDENT",
      "PENDING",
      null,
      matric
    );
  }
  activeStudentId = await insertStudent(
    "Already Registered",
    "STUDENT",
    "ACTIVE",
    passwordHash,
    "REGST/0002"
  );
  inactiveStudentId = await insertStudent(
    "Inactive Student",
    "STUDENT",
    "INACTIVE",
    passwordHash,
    "REGST/0003"
  );
  nonStudentId = await insertStudent(
    "Non Student",
    "LECTURER",
    "PENDING",
    null,
    "REGST/0004"
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

  const userIds = [
    ...Object.values(pendingIds),
    activeStudentId,
    inactiveStudentId,
    nonStudentId,
  ];

  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(
    `DELETE FROM student_registration_challenges WHERE user_id = ANY($1::BIGINT[])`,
    [userIds]
  );
  await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [
    userIds,
  ]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(`DELETE FROM departments WHERE code = 'REGSTDEP'`);
  await pool.query(`DELETE FROM faculties WHERE code = 'REGSTFAC'`);
  await pool.end();
});

test("REGST verification: a valid pending matric returns a safe identity preview", async () => {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0001",
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(body.data).sort(), [
    "challengeToken",
    "department",
    "level",
    "matricNumber",
    "name",
  ]);
  assert.equal(body.data.matricNumber, "REGST/0001");
  assert.equal(body.data.name, "Registration One");
  assert.deepEqual(body.data.department, {
    id: departmentId,
    name: "Student Registration Test Department",
    code: "REGSTDEP",
  });
  assert.deepEqual(body.data.level, { id: levelId, name: 100 });
  assert.ok(
    typeof body.data.challengeToken === "string" &&
      body.data.challengeToken.length >= 40,
    "challenge token must be a long random string"
  );
});

test("REGST verification: matric numbers are normalized exactly like the import system", async () => {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber: "  regst/0001  ",
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { matricNumber: string } };
  assert.equal(body.data.matricNumber, "REGST/0001");
});

test("REGST verification: a nonexistent matric is rejected generically", async () => {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/9999",
  });

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), {
    error: "STUDENT_NOT_FOUND",
    message: "This matric number is not available for student registration.",
  });
});

test("REGST verification: an already-active student cannot begin registration", async () => {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0002",
  });

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "STUDENT_NOT_FOUND");
});

test("REGST verification: an inactive student cannot begin registration", async () => {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0003",
  });

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "STUDENT_NOT_FOUND");
});

test("REGST verification: a non-student account cannot use the flow", async () => {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0004",
  });

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "STUDENT_NOT_FOUND");
});

test("REGST verification: password, session and user data are never exposed", async () => {
  const res = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0001",
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  const serialized = JSON.stringify(body);

  assert.deepEqual(Object.keys(body.data).sort(), [
    "challengeToken",
    "department",
    "level",
    "matricNumber",
    "name",
  ]);
  assert.ok(!("userId" in body.data), "must never expose the user id");
  assert.ok(!("role" in body.data), "must never expose the role");
  assert.ok(!serialized.includes("password"), "must never expose a password");
  assert.ok(!serialized.includes("passwordHash"), "must never expose a password hash");
  assert.ok(!serialized.includes("password_hash"), "must never expose a password hash");
  assert.ok(!serialized.includes("session"), "must never expose session information");
});

test("REGST verification: a malformed request is rejected with INVALID_REQUEST", async () => {
  const missing = await postJson("/api/auth/student/register/verify", {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "INVALID_REQUEST");

  const wrongType = await postJson("/api/auth/student/register/verify", {
    matricNumber: 123,
  });
  assert.equal(wrongType.status, 400);
  assert.equal((await wrongType.json()).error, "INVALID_REQUEST");

  const blank = await postJson("/api/auth/student/register/verify", {
    matricNumber: "   ",
  });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).error, "INVALID_REQUEST");
});

test("REGST challenge: tokens are random and only their hash is stored", async () => {
  const first = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0005",
  });
  assert.equal(first.status, 200);
  const firstToken = ((await first.json()) as { data: { challengeToken: string } })
    .data.challengeToken;

  const second = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0005",
  });
  assert.equal(second.status, 200);
  const secondToken = ((await second.json()) as { data: { challengeToken: string } })
    .data.challengeToken;

  assert.notEqual(firstToken, secondToken);
  assert.ok(firstToken.length >= 40 && secondToken.length >= 40);

  const rows = await pool.query(
    `SELECT challenge_token_hash, status
     FROM student_registration_challenges
     WHERE user_id = $1
     ORDER BY id`,
    [pendingIds["REGST/0005"]]
  );
  assert.equal(rows.rowCount, 2, "the earlier challenge must be expired");
  assert.equal(rows.rows[0].status, "EXPIRED");
  assert.equal(rows.rows[0].challenge_token_hash, hashSessionToken(firstToken));
  assert.equal(rows.rows[1].status, "ACTIVE");
  assert.equal(rows.rows[1].challenge_token_hash, hashSessionToken(secondToken));
  assert.equal(rows.rows[1].challenge_token_hash.length, 64);
  assert.notEqual(rows.rows[1].challenge_token_hash, secondToken);
});

test("REGST challenge: an expired challenge is rejected", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0006",
  });
  assert.equal(verify.status, 200);
  const token = ((await verify.json()) as { data: { challengeToken: string } })
    .data.challengeToken;

  await pool.query(
    `UPDATE student_registration_challenges
     SET created_at = now() - interval '16 minutes'
     WHERE user_id = $1 AND status = 'ACTIVE'`,
    [pendingIds["REGST/0006"]]
  );

  const res = await postJson("/api/auth/student/register/complete", {
    challengeToken: token,
    password: REGISTRATION_PASSWORD,
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_REGISTRATION_CHALLENGE");
  const state = await userState(pendingIds["REGST/0006"]);
  assert.equal(state.status, "PENDING");
  assert.equal(state.hash, null);
});

test("REGST challenge: the challenge cannot be used for another student", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0001",
  });
  assert.equal(verify.status, 200);
  const tokenA = ((await verify.json()) as { data: { challengeToken: string } }).data
    .challengeToken;

  const completeA = await postJson("/api/auth/student/register/complete", {
    challengeToken: tokenA,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(completeA.status, 201);
  const bodyA = (await completeA.json()) as { user: { matricNumber: string } };
  assert.equal(bodyA.user.matricNumber, "REGST/0001");

  const bystander = await userState(pendingIds["REGST/0005"]);
  assert.equal(bystander.status, "PENDING");
  assert.equal(bystander.hash, null, "the challenge must not touch another student");

  const wrong = await postJson("/api/auth/student/register/complete", {
    challengeToken: tokenA,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, "INVALID_REGISTRATION_CHALLENGE");

  const verifyB = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0005",
  });
  assert.equal(verifyB.status, 200);
  const tokenB = ((await verifyB.json()) as { data: { challengeToken: string } }).data
    .challengeToken;
  const completeB = await postJson("/api/auth/student/register/complete", {
    challengeToken: tokenB,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(completeB.status, 201);
  assert.equal((await userState(pendingIds["REGST/0005"])).status, "ACTIVE");
});

test("REGST challenge: an invalid token is rejected without side effects", async () => {
  const res = await postJson("/api/auth/student/register/complete", {
    challengeToken: "not-a-real-challenge-token",
    password: REGISTRATION_PASSWORD,
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_REGISTRATION_CHALLENGE");
  const state = await userState(pendingIds["REGST/0008"]);
  assert.equal(state.status, "PENDING");
  assert.equal(state.hash, null);
});

test("REGST challenge: a challenge is one-time use and not reusable after registration", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0007",
  });
  assert.equal(verify.status, 200);
  const token = ((await verify.json()) as { data: { challengeToken: string } }).data
    .challengeToken;

  const first = await postJson("/api/auth/student/register/complete", {
    challengeToken: token,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(first.status, 201);

  const second = await postJson("/api/auth/student/register/complete", {
    challengeToken: token,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error, "INVALID_REGISTRATION_CHALLENGE");

  const rows = await pool.query(
    `SELECT status, consumed_at
     FROM student_registration_challenges
     WHERE user_id = $1`,
    [pendingIds["REGST/0007"]]
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].status, "USED");
  assert.ok(rows.rows[0].consumed_at !== null, "the challenge must record consumption");
});

test("REGST completion: the password is stored as an Argon2id hash, never plaintext", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0012",
  });
  assert.equal(verify.status, 200);
  const token = ((await verify.json()) as { data: { challengeToken: string } }).data
    .challengeToken;

  const res = await postJson("/api/auth/student/register/complete", {
    challengeToken: token,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(res.status, 201);

  const state = await userState(pendingIds["REGST/0012"]);
  assert.equal(state.status, "ACTIVE");
  assert.ok(state.hash !== null, "a password hash must be stored");
  assert.ok(
    state.hash.startsWith("$argon2id$"),
    "the stored hash must be Argon2id"
  );
  assert.notEqual(state.hash, REGISTRATION_PASSWORD);
  assert.ok(await verifyPassword(state.hash, REGISTRATION_PASSWORD));
});

test("REGST completion: the student immediately authenticates and /me returns STUDENT", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0013",
  });
  assert.equal(verify.status, 200);
  const token = ((await verify.json()) as { data: { challengeToken: string } }).data
    .challengeToken;

  const res = await postJson("/api/auth/student/register/complete", {
    challengeToken: token,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(res.status, 201);
  const completionCookie = cookieFrom(res);
  assert.ok(completionCookie, "a session cookie must be set on completion");
  const setCookie = res.headers.getSetCookie();
  assert.ok(setCookie[0].includes("HttpOnly"), "cookie must be HttpOnly");
  assert.ok(setCookie[0].includes("SameSite=Lax"), "cookie must be SameSite=Lax");

  const me = await get("/api/auth/me", cookieHeader(completionCookie));
  assert.equal(me.status, 200);
  const meBody = (await me.json()) as { user: Record<string, unknown> };
  assert.equal(meBody.user.role, "STUDENT");
  assert.equal(meBody.user.matricNumber, "REGST/0013");

  const login = await postJson("/api/auth/student/login", {
    matricNumber: "REGST/0013",
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(login.status, 200);

  const sessions = await pool.query(
    `SELECT user_id, session_token_hash, expires_at, revoked_at
     FROM sessions
     WHERE user_id = $1
     ORDER BY id`,
    [pendingIds["REGST/0013"]]
  );
  assert.equal(sessions.rowCount, 2, "one session from completion, one from login");
  const completionSession = sessions.rows[0];
  assert.equal(completionSession.session_token_hash, hashSessionToken(completionCookie));
  assert.equal(completionSession.session_token_hash.length, 64);
  assert.notEqual(completionSession.session_token_hash, completionCookie);
  assert.equal(completionSession.revoked_at, null);
  assert.ok(new Date(completionSession.expires_at) > new Date());
});

test("REGST completion: concurrent completions cannot both succeed", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0009",
  });
  assert.equal(verify.status, 200);
  const token = ((await verify.json()) as { data: { challengeToken: string } }).data
    .challengeToken;

  const [a, b] = await Promise.all([
    postJson("/api/auth/student/register/complete", {
      challengeToken: token,
      password: REGISTRATION_PASSWORD,
    }),
    postJson("/api/auth/student/register/complete", {
      challengeToken: token,
      password: REGISTRATION_PASSWORD,
    }),
  ]);

  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [201, 400], "exactly one completion must win");
  const loser = a.status === 201 ? b : a;
  assert.equal((await loser.json()).error, "INVALID_REGISTRATION_CHALLENGE");

  const state = await userState(pendingIds["REGST/0009"]);
  assert.equal(state.status, "ACTIVE");
  assert.ok(state.hash !== null && state.hash !== REGISTRATION_PASSWORD);

  const sessions = await pool.query(
    `SELECT id FROM sessions WHERE user_id = $1`,
    [pendingIds["REGST/0009"]]
  );
  assert.equal(sessions.rowCount, 1, "only the winning completion may create a session");
});

test("REGST completion: an already-registered account cannot be overwritten", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0010",
  });
  assert.equal(verify.status, 200);
  const token = ((await verify.json()) as { data: { challengeToken: string } }).data
    .challengeToken;

  const first = await postJson("/api/auth/student/register/complete", {
    challengeToken: token,
    password: REGISTRATION_PASSWORD,
  });
  assert.equal(first.status, 201);
  const hashBefore = (await userState(pendingIds["REGST/0010"])).hash;

  const forgedToken = generateSessionToken();
  await pool.query(
    `INSERT INTO student_registration_challenges (user_id, challenge_token_hash)
     VALUES ($1, $2)`,
    [pendingIds["REGST/0010"], hashSessionToken(forgedToken)]
  );

  const second = await postJson("/api/auth/student/register/complete", {
    challengeToken: forgedToken,
    password: "a-completely-different-password",
  });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "ALREADY_REGISTERED");

  const state = await userState(pendingIds["REGST/0010"]);
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.hash, hashBefore, "the existing password must not be overwritten");

  const reverify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0010",
  });
  assert.equal(reverify.status, 404);
});

test("REGST completion: a weak password is rejected without side effects", async () => {
  const verify = await postJson("/api/auth/student/register/verify", {
    matricNumber: "REGST/0011",
  });
  assert.equal(verify.status, 200);
  const token = ((await verify.json()) as { data: { challengeToken: string } }).data
    .challengeToken;

  const res = await postJson("/api/auth/student/register/complete", {
    challengeToken: token,
    password: "short",
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_REQUEST");
  const state = await userState(pendingIds["REGST/0011"]);
  assert.equal(state.status, "PENDING");
  assert.equal(state.hash, null);
});

test("REGST schema: one active challenge per user is enforced", async () => {
  const target = pendingIds["REGST/0008"];
  const insert = () =>
    pool.query(
      `INSERT INTO student_registration_challenges (user_id, challenge_token_hash)
       VALUES ($1, $2), ($3, $4)`,
      [target, hashSessionToken("active-a"), target, hashSessionToken("active-b")]
    );
  await assert.rejects(
    insert,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
  );
});