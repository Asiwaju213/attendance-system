import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/lib/passwords";

test("hashPassword produces a non-plaintext Argon2id hash", async () => {
  const hash = await hashPassword("secret123");

  assert.ok(hash.includes("$argon2id$"), "should be an Argon2id hash");
  assert.notEqual(hash, "secret123");
  assert.ok(!hash.includes("secret123"), "must never contain the plaintext");
});

test("verifyPassword accepts the correct password", async () => {
  const hash = await hashPassword("secret123");
  assert.equal(await verifyPassword(hash, "secret123"), true);
});

test("verifyPassword rejects an incorrect password", async () => {
  const hash = await hashPassword("secret123");
  assert.equal(await verifyPassword(hash, "wrong-password"), false);
});

test("verifyPassword returns false for a malformed hash instead of throwing", async () => {
  assert.equal(await verifyPassword("not-a-valid-argon2-hash", "secret123"), false);
});