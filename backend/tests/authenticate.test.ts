import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";
import { requireAuth, requireRole } from "../src/middleware/authenticate";
import type { AuthUser } from "../src/types/auth";

let testUserId: number;

class MockRes {
  statusCode = 0;
  body: unknown = null;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(data: unknown): this {
    this.body = data;
    return this;
  }
}

function makeRes(): MockRes {
  return new MockRes();
}

async function persistSession(expiresAt: Date): Promise<{ token: string; id: number }> {
  const token = generateSessionToken();
  const session = await createSession(testUserId, hashSessionToken(token), expiresAt);
  return { token, id: session.id };
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${token}` };
}

function adminUser(): AuthUser {
  return {
    id: testUserId,
    name: "Admin Test",
    username: "admin_test",
    role: "ADMIN",
  };
}

before(async () => {
  const passwordHash = await hashPassword("test-password");
  const result = await pool.query(
    `INSERT INTO users (name, password_hash, role, username)
     VALUES ('Authenticate Test Admin', $1, 'ADMIN', 'authenticate_test_admin')
     RETURNING id`,
    [passwordHash]
  );
  testUserId = Number(result.rows[0].id);
});

after(async () => {
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [testUserId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  await pool.end();
});

test("requireAuth accepts a valid session and attaches the user without password_hash", async () => {
  const { token } = await persistSession(new Date(Date.now() + 60_000));
  const req = { headers: cookieHeader(token) } as Partial<Request>;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;
  const next = (() => {
    nextCalled = true;
  }) as NextFunction;

  await requireAuth(req as Request, res, next);

  assert.equal(nextCalled, true, "valid session should reach the handler");
  assert.equal(req.user?.role, "ADMIN");
  assert.equal(req.user?.id, testUserId);
  assert.equal((req.user as unknown as Record<string, unknown>).password_hash, undefined);
});

test("requireAuth rejects a request with no cookie", async () => {
  const req = { headers: {} } as Request;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;

  await requireAuth(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal((res.body as { error: string }).error, "UNAUTHENTICATED");
});

test("requireAuth rejects an unknown token", async () => {
  const req = { headers: cookieHeader(generateSessionToken()) } as Request;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;

  await requireAuth(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireAuth rejects a revoked session", async () => {
  const { token, id } = await persistSession(new Date(Date.now() + 60_000));
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [id]);

  const req = { headers: cookieHeader(token) } as Request;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;

  await requireAuth(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireAuth rejects an expired session", async () => {
  const { token } = await persistSession(new Date(Date.now() - 1000));

  const req = { headers: cookieHeader(token) } as Request;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;

  await requireAuth(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireRole passes an authenticated user with the required role", () => {
  const mw = requireRole("ADMIN");
  const req = { user: adminUser() } as Request;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;

  mw(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 0);
});

test("requireRole rejects an authenticated user with a different role (403)", () => {
  const mw = requireRole("ADMIN");
  const req = { user: { ...adminUser(), role: "STUDENT" } } as Request;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;

  mw(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal((res.body as { error: string }).error, "FORBIDDEN");
});

test("requireRole rejects an unauthenticated request (401)", () => {
  const mw = requireRole("ADMIN");
  const req = {} as Request;
  const res = makeRes() as unknown as Response;
  let nextCalled = false;

  mw(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});