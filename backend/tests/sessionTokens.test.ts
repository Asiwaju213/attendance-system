import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";

test("session tokens are long, opaque, and unpredictable", () => {
  const a = generateSessionToken();
  const b = generateSessionToken();

  assert.notEqual(a, b, "two tokens must never be identical");
  assert.ok(a.length >= 32, "token should be at least 32 characters long");
});

test("the stored value is a hash, never the raw token", () => {
  const token = generateSessionToken();
  const stored = hashSessionToken(token);

  assert.notEqual(stored, token);
  assert.match(stored, /^[0-9a-f]{64}$/, "should be a sha256 hex digest");
});

test("hashing is deterministic so lookups always match", () => {
  const token = generateSessionToken();
  assert.equal(hashSessionToken(token), hashSessionToken(token));
});