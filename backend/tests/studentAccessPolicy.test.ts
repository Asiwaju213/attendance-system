import assert from "node:assert/strict";
import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/app";
import {
  DEFAULT_STUDENT_ACCESS_MODE,
  STUDENT_ACCESS_MODE_ENV_VAR,
  resolveStudentAccessConfig,
  resolveStudentAccessMode,
} from "../src/config/access";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import {
  STUDENT_ACCESS_DISABLED,
  resolveRequestStudentAccessMode,
} from "../src/middleware/studentAccess";
import { createSession, revokeSession } from "../src/services/sessionStore";
import { boundDeviceHeaders } from "./studentSessionTestHelpers";

/**
 * The student access policy: students are served by the K12 edge deployment and by nothing else.
 *
 * The accounts below are the seeded E2E users, so this file creates no fixtures and has nothing to
 * clean up except the sessions it mints (revoked in `after`). A student session is created
 * directly in the session store rather than through the login endpoint: on the cloud the login
 * endpoint is exactly what is under test, and the interesting case is a session that already
 * exists.
 */

const SEED_PASSWORD = "auth-flow-test-password";
const STUDENT_MATRIC = "E2E/STU/0001";
const LECTURER_STAFF_ID = "E2E/LEC/0001";
const ADMIN_USERNAME = "e2e_admin";

const HOUR_MS = 60 * 60 * 1000;

let cloudServer: Server;
let cloudUrl: string;
let edgeServer: Server;
let edgeUrl: string;

const createdSessionIds: number[] = [];

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<globalThis.Response> {
  return fetch(baseUrl + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function post(baseUrl: string, path: string, body?: unknown, headers = {}) {
  return request(baseUrl, "POST", path, body, headers);
}

function get(baseUrl: string, path: string, headers = {}) {
  return request(baseUrl, "GET", path, undefined, headers);
}

function sessionCookie(token: string): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${token}` };
}

/** Remove line and block comments so a source scan reads code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Mint a session for a seeded user directly, the way an earlier edge sign-in would have. */
async function mintSession(identifier: "matricNumber" | "staffId" | "username", value: string) {
  // Each role keeps its identifier on its own profile table; `username` is the one column on
  // `users` itself.
  const lookup =
    identifier === "matricNumber"
      ? pool.query(
          `SELECT u.id FROM users u
             JOIN students s ON s.user_id = u.id
            WHERE s.matric_number = $1 AND u.status = 'ACTIVE'`,
          [value]
        )
      : identifier === "staffId"
        ? pool.query(
            `SELECT u.id FROM users u
               JOIN lecturers l ON l.user_id = u.id
              WHERE l.staff_id = $1 AND u.status = 'ACTIVE'`,
            [value]
          )
        : pool.query(`SELECT id FROM users WHERE username = $1 AND status = 'ACTIVE'`, [value]);

  const found = await lookup;
  const userId = Number(found.rows[0]?.id);
  assert.ok(userId > 0, `expected an active seeded user for ${value}`);

  const token = generateSessionToken();
  const session = await createSession(userId, hashSessionToken(token), new Date(Date.now() + HOUR_MS));
  createdSessionIds.push(session.id);
  return sessionCookie(token);
}

const studentSession = () => mintSession("matricNumber", STUDENT_MATRIC);
const lecturerSession = () => mintSession("staffId", LECTURER_STAFF_ID);
const adminSession = () => mintSession("username", ADMIN_USERNAME);

before(async () => {
  cloudServer = createApp({ studentAccessMode: "cloud" }).listen(0, "127.0.0.1");
  edgeServer = createApp({ studentAccessMode: "edge" }).listen(0, "127.0.0.1");
  await Promise.all([
    new Promise<void>((resolve) => cloudServer.once("listening", () => resolve())),
    new Promise<void>((resolve) => edgeServer.once("listening", () => resolve())),
  ]);
  cloudUrl = `http://127.0.0.1:${(cloudServer.address() as AddressInfo).port}`;
  edgeUrl = `http://127.0.0.1:${(edgeServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const sessionId of createdSessionIds) {
    await revokeSession(sessionId);
  }
  createdSessionIds.length = 0;
  await new Promise<void>((resolve) => {
    cloudServer.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    edgeServer.close(() => resolve());
  });
  await pool.end();
});

// ------------------------------------------------------------------
// Mode resolution: pure, so every branch is checkable without a server.
// ------------------------------------------------------------------

test("an unset mode resolves to cloud, so students are off unless a deployment opts in", () => {
  assert.equal(resolveStudentAccessMode({}), "cloud");
  assert.equal(resolveStudentAccessMode({}), DEFAULT_STUDENT_ACCESS_MODE);
  assert.equal(DEFAULT_STUDENT_ACCESS_MODE, "cloud");
  assert.equal(resolveStudentAccessConfig({}).studentAccessEnabled, false);
});

test("a blank mode is treated as unset rather than as a bad value", () => {
  assert.equal(resolveStudentAccessMode({ [STUDENT_ACCESS_MODE_ENV_VAR]: "" }), "cloud");
  assert.equal(resolveStudentAccessMode({ [STUDENT_ACCESS_MODE_ENV_VAR]: "   " }), "cloud");
});

test("an explicit cloud mode resolves to cloud with students disabled", () => {
  assert.equal(resolveStudentAccessMode({ [STUDENT_ACCESS_MODE_ENV_VAR]: "cloud" }), "cloud");
  assert.equal(resolveStudentAccessConfig({ [STUDENT_ACCESS_MODE_ENV_VAR]: "cloud" }).studentAccessEnabled, false);
});

test("an edge mode resolves to edge with students enabled", () => {
  assert.equal(resolveStudentAccessMode({ [STUDENT_ACCESS_MODE_ENV_VAR]: "edge" }), "edge");
  assert.equal(resolveStudentAccessConfig({ [STUDENT_ACCESS_MODE_ENV_VAR]: "edge" }).studentAccessEnabled, true);
});

test("the mode is case-insensitive and tolerates surrounding whitespace", () => {
  assert.equal(resolveStudentAccessMode({ [STUDENT_ACCESS_MODE_ENV_VAR]: "EDGE" }), "edge");
  assert.equal(resolveStudentAccessMode({ [STUDENT_ACCESS_MODE_ENV_VAR]: "  Edge  " }), "edge");
});

test("an unrecognized mode throws instead of defaulting", () => {
  for (const bad of ["k12", "lan", "true", "1", "on", "edgee", "student"]) {
    assert.throws(
      () => resolveStudentAccessMode({ [STUDENT_ACCESS_MODE_ENV_VAR]: bad }),
      /Invalid value for STUDENT_ACCESS_MODE/,
      `expected ${bad} to be rejected`
    );
  }
});

test("SYNC_ENABLED does not determine student access mode", () => {
  // The sync worker switch means "run the background sync worker" and must stay unrelated: a
  // syncing PC that is not the student entry point, and an edge with sync switched off, both have
  // to be expressible.
  assert.equal(
    resolveStudentAccessMode({ SYNC_ENABLED: "true" }),
    "cloud",
    "enabling sync must not enable students"
  );
  assert.equal(
    resolveStudentAccessMode({ SYNC_ENABLED: "true", [STUDENT_ACCESS_MODE_ENV_VAR]: "edge" }),
    "edge"
  );
  assert.equal(
    resolveStudentAccessMode({ SYNC_ENABLED: "false", [STUDENT_ACCESS_MODE_ENV_VAR]: "edge" }),
    "edge",
    "sync being off must not disable an edge"
  );
});

test("HOST, PORT and NODE_ENV do not determine student access mode", () => {
  // Both deployments bind 0.0.0.0, so the bind address cannot distinguish them.
  const lanBind = { HOST: "0.0.0.0", PORT: "5000" };
  assert.equal(resolveStudentAccessMode(lanBind), "cloud");
  assert.equal(resolveStudentAccessMode({ ...lanBind, NODE_ENV: "production" }), "cloud");
  assert.equal(
    resolveStudentAccessMode({ ...lanBind, [STUDENT_ACCESS_MODE_ENV_VAR]: "edge" }),
    "edge"
  );
});

test("the policy reads no request properties, so no IP address can influence it", () => {
  // The mode comes from configuration alone: the same request, from any address, is treated
  // identically in both modes.
  assert.equal(resolveRequestStudentAccessMode(createApp({ studentAccessMode: "cloud" })), "cloud");
  assert.equal(resolveRequestStudentAccessMode(createApp({ studentAccessMode: "edge" })), "edge");

  // And the enforcement code itself mentions no address at all, so there is nothing to spoof.
  // Comments are stripped first: the module documents the addresses it deliberately does NOT read,
  // and naming them there is useful, while naming them in code would be the bug.
  const source = stripComments(
    readFileSync(join(__dirname, "..", "src", "middleware", "studentAccess.ts"), "utf8")
  );
  for (const forbidden of ["req.ip", "req.ips", "remoteaddress", "x-forwarded-for", "hostname"]) {
    assert.ok(
      !source.toLowerCase().includes(forbidden),
      `the student access policy must not reference ${forbidden}`
    );
  }
  for (const address of ["127.0.0.1", "192.168", "10.0.0", "172.16", "::1", "localhost"]) {
    assert.ok(
      !source.includes(address),
      `the student access policy must not contain the hard-coded address ${address}`
    );
  }
});

test("an app that was never configured refuses students", () => {
  const bare: Express = express();
  assert.equal(resolveRequestStudentAccessMode(bare), "cloud");
});

// ------------------------------------------------------------------
// Cloud mode: the public deployment.
// ------------------------------------------------------------------

test("cloud mode refuses student password login", async () => {
  const res = await post(cloudUrl, "/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: SEED_PASSWORD,
  });

  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, STUDENT_ACCESS_DISABLED);
  // No session was minted, so there is nothing to reuse.
  assert.equal(res.headers.getSetCookie().length, 0);
});

test("cloud mode refuses device-bound student login too", async () => {
  const res = await post(
    cloudUrl,
    "/api/auth/student/login",
    { password: SEED_PASSWORD },
    await boundDeviceHeaders(STUDENT_MATRIC)
  );

  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, STUDENT_ACCESS_DISABLED);
});

test("cloud mode refuses the student WebAuthn device endpoints without touching them", async () => {
  for (const path of ["/api/auth/student/device/options", "/api/auth/student/device/verify"]) {
    const res = await post(cloudUrl, path, {});
    assert.equal(res.status, 403, `${path} must be refused`);
    assert.equal((await res.json()).error, STUDENT_ACCESS_DISABLED);
  }
});

test("cloud mode refuses student registration, remembered-account and device-binding endpoints", async () => {
  const cases: Array<[string, string]> = [
    ["POST", "/api/auth/student/register/verify"],
    ["POST", "/api/auth/student/register/complete"],
    ["GET", "/api/auth/student/remembered"],
    ["POST", "/api/auth/student/remembered/clear"],
    ["GET", "/api/auth/student/device-binding"],
  ];

  for (const [method, path] of cases) {
    const res = await request(cloudUrl, method, path, method === "POST" ? {} : undefined);
    assert.equal(res.status, 403, `${method} ${path} must be refused`);
    assert.equal((await res.json()).error, STUDENT_ACCESS_DISABLED);
  }
});

test("cloud mode refuses every student API route, including anonymous callers", async () => {
  const paths = [
    "/api/student/attendance/eligible",
    "/api/student/attendance/device-challenge",
    "/api/student/attendance/history",
    "/api/student/device",
    "/api/student/course-registrations",
  ];

  for (const path of paths) {
    const res = await get(cloudUrl, path);
    assert.equal(res.status, 403, `${path} must be refused in cloud mode`);
    assert.equal((await res.json()).error, STUDENT_ACCESS_DISABLED);
  }
});

test("cloud mode blocks a student session that already exists", async () => {
  // The case a login-only check misses: a valid session cookie, minted on the edge or before this
  // policy existed, presented straight to the student APIs on the public deployment.
  const headers = await studentSession();

  const me = await get(cloudUrl, "/api/auth/me", headers);
  assert.equal(me.status, 200, "the session itself is still valid");

  for (const path of [
    "/api/student/attendance/eligible",
    "/api/student/attendance/history",
    "/api/student/course-registrations",
  ]) {
    const res = await get(cloudUrl, path, headers);
    assert.equal(res.status, 403, `${path} must be refused for an existing student session`);
    assert.equal((await res.json()).error, STUDENT_ACCESS_DISABLED);
  }

  // And the same session works on the edge, so the block is the policy and not a dead session.
  const edgeRes = await get(edgeUrl, "/api/student/attendance/eligible", headers);
  assert.notEqual(edgeRes.status, 403, "the same session must work in edge mode");
});

test("cloud mode leaves lecturer and admin sign-in and their APIs alone", async () => {
  const lecturer = await post(cloudUrl, "/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: SEED_PASSWORD,
  });
  assert.equal(lecturer.status, 200);
  assert.equal((await lecturer.json()).user.role, "LECTURER");

  const admin = await post(cloudUrl, "/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: SEED_PASSWORD,
  });
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).user.role, "ADMIN");

  const lecturerHeaders = await lecturerSession();
  const lecturerCatalog = await get(cloudUrl, "/api/lecturer/attendance-networks", lecturerHeaders);
  assert.equal(lecturerCatalog.status, 200);

  const adminHeaders = await adminSession();
  const adminDepartments = await get(cloudUrl, "/api/admin/departments", adminHeaders);
  assert.equal(adminDepartments.status, 200);
});

test("cloud mode leaves /api/auth/me, logout and the health check alone", async () => {
  const student = await get(cloudUrl, "/api/auth/me", await studentSession());
  assert.equal(student.status, 200, "/api/auth/me is shared by all roles and stays reachable");

  const logout = await post(cloudUrl, "/api/auth/logout", {}, await lecturerSession());
  assert.equal(logout.status, 200);

  const health = await get(cloudUrl, "/api/health");
  const body = (await health.json()) as Record<string, unknown>;
  assert.equal(body.studentAccessMode, "cloud");
  assert.ok(!JSON.stringify(body).includes("secret"), "health must not expose secrets");
});

// ------------------------------------------------------------------
// Edge mode: the K12 campus deployment.
// ------------------------------------------------------------------

test("edge mode serves student sign-in and student APIs", async () => {
  const headers = await boundDeviceHeaders(STUDENT_MATRIC);
  const login = await post(
    edgeUrl,
    "/api/auth/student/login",
    { password: SEED_PASSWORD },
    headers
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith(`${authConfig.cookieName}=`));
  assert.ok(cookie, "student sign-in must mint a session on the edge");

  const eligible = await get(edgeUrl, "/api/student/attendance/eligible", {
    cookie: `${authConfig.cookieName}=${cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"))}`,
  });
  assert.equal(eligible.status, 200);

  // The device endpoints are reachable as well, so WebAuthn is untouched by the policy.
  const options = await post(edgeUrl, "/api/auth/student/device/options", {});
  assert.notEqual(options.status, 403);
});

test("edge mode keeps a student session working", async () => {
  const headers = await studentSession();
  assert.equal((await get(edgeUrl, "/api/auth/me", headers)).status, 200);
  assert.equal((await get(edgeUrl, "/api/student/attendance/eligible", headers)).status, 200);
  assert.equal((await get(edgeUrl, "/api/student/attendance/history", headers)).status, 200);
});

test("edge mode keeps lecturer and admin access working", async () => {
  const lecturer = await get(edgeUrl, "/api/lecturer/catalog", await lecturerSession());
  assert.notEqual(lecturer.status, 403);

  const admin = await get(edgeUrl, "/api/admin/departments", await adminSession());
  assert.equal(admin.status, 200);

  const health = await get(edgeUrl, "/api/health");
  assert.equal(((await health.json()) as Record<string, unknown>).studentAccessMode, "edge");
});

test("edge mode still refuses a caller who is not a student", async () => {
  // requireStudent must not have been weakened: the policy allowing students is not the same as
  // the role check allowing everyone.
  const res = await get(edgeUrl, "/api/student/attendance/eligible", await lecturerSession());
  assert.equal(res.status, 403);
  assert.notEqual((await res.json()).error, STUDENT_ACCESS_DISABLED);
});
