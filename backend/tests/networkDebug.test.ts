import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { pool } from "../src/db/pool";

/**
 * Tests for the TEMPORARY network investigation endpoint.
 *
 * These assert the endpoint's safe shape only. They do NOT imply any permanent
 * security decision: the endpoint and these tests are meant to be deleted after
 * the investigation.
 */

let server: Server;
let baseUrl: string;

before(async () => {
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
  await pool.end();
});

test("NETWORK debug: returns the expected safe shape without authentication", async () => {
  const res = await fetch(`${baseUrl}/api/debug/network`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = (await res.json()) as {
    data: {
      ip: unknown;
      ips: unknown;
      protocol: unknown;
      secure: unknown;
      hostname: unknown;
      trustProxy: unknown;
      trustProxyExplanation: unknown;
      headers: Record<string, unknown>;
      connection: Record<string, unknown>;
    };
  };

  const data = body.data;
  assert.equal(typeof data.ip, "string");
  assert.ok(Array.isArray(data.ips));
  assert.equal(data.protocol, "http");
  assert.equal(data.secure, false);
  assert.equal(typeof data.hostname, "string");
  // trust proxy defaults to false; it must be reported explicitly.
  assert.equal(data.trustProxy, false);
  assert.equal(typeof data.trustProxyExplanation, "string");

  for (const key of [
    "host",
    "x-forwarded-for",
    "x-real-ip",
    "forwarded",
    "user-agent",
  ]) {
    assert.ok(key in data.headers, `headers must include ${key}`);
  }

  assert.equal(typeof data.connection.remoteAddress, "string");
});

test("NETWORK debug: never leaks cookies, auth, or session material", async () => {
  const res = await fetch(`${baseUrl}/api/debug/network`, {
    headers: {
      cookie: "oou_session=super-secret-token",
      authorization: "Bearer super-secret-token",
    },
  });
  assert.equal(res.status, 200);

  const raw = await res.text();
  for (const forbidden of [
    "super-secret-token",
    "oou_session",
    "authorization",
    "set-cookie",
    "password",
    "token",
  ]) {
    assert.equal(
      raw.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `response must not contain "${forbidden}"`
    );
  }
});

test("NETWORK debug: does not trust a spoofed X-Forwarded-For (trust proxy off)", async () => {
  const res = await fetch(`${baseUrl}/api/debug/network`, {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    data: {
      ip: string;
      ips: string[];
      headers: Record<string, unknown>;
    };
  };

  // The raw header is reported verbatim for the investigation...
  assert.equal(body.data.headers["x-forwarded-for"], "203.0.113.7, 10.0.0.1");
  // ...but it must NOT influence the trusted client address while trust proxy is off.
  // Node commonly reports loopback as the IPv6-mapped `::ffff:127.0.0.1`.
  assert.ok(
    body.data.ip.endsWith("127.0.0.1"),
    `expected loopback address, got ${body.data.ip}`
  );
  assert.notEqual(body.data.ip, "203.0.113.7");
  assert.deepEqual(body.data.ips, []);
});
