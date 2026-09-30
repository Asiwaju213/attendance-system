import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { TRUSTED_PROXY_HOPS, applyTrustProxy } from "../src/config/trustProxy";
import { createFixedWindowLimiter } from "../src/lib/rateLimit";
import { webauthnConfig } from "../src/config/webauthn";

/**
 * The rate limiter keys its buckets on `req.ip` (see `rateLimitKey` in
 * routes/auth.ts), so the correctness of the whole abuse brake depends on
 * Express resolving `req.ip` to the real client address behind Vercel's edge.
 *
 * These tests drive a real Express app over a real loopback socket, so the
 * `X-Forwarded-For` parsing, the trust function and `req.ip`/`req.ips` are all
 * genuinely exercised rather than mocked. No database and no deployment are
 * involved.
 */

interface WhoAmI {
  ip: string | undefined;
  ips: string[];
  socket: string | undefined;
}

let server: Server;
let port: number;

function buildApp(): express.Express {
  const app = express();
  applyTrustProxy(app);

  app.get("/whoami", (req, res) => {
    res.json({
      ip: req.ip,
      ips: req.ips,
      socket: req.socket.remoteAddress,
    } satisfies WhoAmI);
  });

  return app;
}

function get(path: string, headers: Record<string, string> = {}): Promise<WhoAmI> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(JSON.parse(body) as WhoAmI));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  server = createServer(buildApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("A. trust proxy is exactly one hop, and not every hop", () => {
  assert.equal(TRUSTED_PROXY_HOPS, 1);

  const app = buildApp();
  const configured = app.get("trust proxy");

  assert.equal(configured, 1);
  assert.notEqual(configured, true);
  assert.equal(typeof configured, "number");
});

test("A. an unconfigured app trusts nothing, which is the behaviour this replaces", () => {
  const app = express();

  assert.equal(app.get("trust proxy"), false);
});

test("B. a single trusted hop resolves req.ip to the real client address", async () => {
  const result = await get("/whoami", { "X-Forwarded-For": "203.0.113.9" });

  assert.equal(result.ip, "203.0.113.9");
});

test("C. a longer forwarded chain does not let the leftmost address win", async () => {
  const result = await get("/whoami", {
    "X-Forwarded-For": "1.1.1.1, 2.2.2.2, 3.3.3.3",
  });

  // Only the address the trusted proxy itself appended is believed.
  assert.equal(result.ip, "3.3.3.3");
  assert.notEqual(result.ip, "1.1.1.1");
  assert.notEqual(result.ip, "2.2.2.2");
  for (const address of result.ips) {
    assert.notEqual(address, "1.1.1.1");
    assert.notEqual(address, "2.2.2.2");
  }
});

test("C. a client cannot choose its own address by prepending one", async () => {
  // This is the Vercel shape: the real client address is the last entry and
  // whatever the client sent sits to its left.
  const result = await get("/whoami", {
    "X-Forwarded-For": "6.6.6.6, 203.0.113.9",
  });

  assert.equal(result.ip, "203.0.113.9");
  assert.notEqual(result.ip, "6.6.6.6");
});

test("C. forged entries are ignored, only one hop deep", async () => {
  const chains = [
    { header: "9.9.9.9", leftmost: "9.9.9.9", expected: "9.9.9.9" },
    { header: "9.9.9.9, 8.8.8.8", leftmost: "9.9.9.9", expected: "8.8.8.8" },
    {
      header: "9.9.9.9, 8.8.8.8, 7.7.7.7, 6.6.6.6",
      leftmost: "9.9.9.9",
      expected: "6.6.6.6",
    },
    { header: "not-an-ip, 8.8.8.8", leftmost: "not-an-ip", expected: "8.8.8.8" },
  ];

  for (const { header, leftmost, expected } of chains) {
    const result = await get("/whoami", { "X-Forwarded-For": header });

    // The rightmost entry is what a trusted proxy reported, one hop in.
    assert.equal(result.ip, expected, `chain "${header}" resolved to ${String(result.ip)}`);

    // A forged leftmost entry is never chosen over the trusted hop.
    if (leftmost !== expected) {
      assert.notEqual(result.ip, leftmost, `chain "${header}" trusted a forged leftmost address`);
    }
  }
});

test("local and LAN requests without a proxy keep resolving to the socket address", async () => {
  const result = await get("/whoami");

  // No proxy in front locally, so the peer address stands and nothing is invented.
  assert.equal(result.ip, result.socket);
  assert.deepEqual(result.ips, []);
});

test("D. the rate-limit key follows the resolved req.ip, not a client-supplied value", async () => {
  // `rateLimitKey` in routes/auth.ts is `req.ip ?? req.socket.remoteAddress ?? "unknown"`.
  const key = (result: WhoAmI): string =>
    result.ip ?? result.socket ?? "unknown";

  const behindProxy = await get("/whoami", {
    "X-Forwarded-For": "6.6.6.6, 203.0.113.9",
  });
  assert.equal(key(behindProxy), "203.0.113.9");

  const direct = await get("/whoami");
  assert.equal(key(direct), direct.socket);
});

/**
 * Mirrors how the device-login routes use the limiter: check first, and record
 * the attempt only when it was allowed. `hit()` on its own reports the state
 * *after* incrementing, so counting with `hit()` alone is off by one against
 * the real flow.
 */
function consume(
  limiter: ReturnType<typeof createFixedWindowLimiter>,
  key: string
): boolean {
  if (!limiter.check(key).allowed) {
    return false;
  }
  limiter.hit(key);
  return true;
}

test("E. different clients get independent rate-limit buckets", async () => {
  const limiter = createFixedWindowLimiter("trust-proxy-test", 5, 60_000);
  const key = (result: WhoAmI): string => result.ip ?? result.socket ?? "unknown";

  const first = key(await get("/whoami", { "X-Forwarded-For": "203.0.113.10" }));
  const second = key(await get("/whoami", { "X-Forwarded-For": "203.0.113.11" }));

  assert.notEqual(first, second);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(consume(limiter, first), true, `attempt ${attempt} should be allowed`);
  }
  assert.equal(consume(limiter, first), false);

  // The exhausted client does not consume the other client's budget.
  assert.equal(consume(limiter, second), true);
  assert.equal(limiter.check(first).allowed, false);
  assert.equal(limiter.check(second).allowed, true);
});

test("E. one client cannot escape its own bucket by rotating a forwarded chain", async () => {
  const limiter = createFixedWindowLimiter("trust-proxy-spoof-test", 3, 60_000);
  const key = (result: WhoAmI): string => result.ip ?? result.socket ?? "unknown";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // A different forged leftmost address every time, the same real client rightmost.
    const result = await get("/whoami", {
      "X-Forwarded-For": `6.6.6.${attempt}, 203.0.113.12`,
    });
    assert.equal(consume(limiter, key(result)), true, `attempt ${attempt} should be allowed`);
  }

  const after = await get("/whoami", {
    "X-Forwarded-For": "6.6.6.99, 203.0.113.12",
  });
  assert.equal(consume(limiter, key(after)), false);
});

test("F. the rate-limit thresholds and window durations are unchanged", () => {
  assert.deepEqual(webauthnConfig.loginChallengeRateLimit, {
    maxChallenges: 20,
    windowMs: 5 * 60 * 1000,
  });
  assert.deepEqual(webauthnConfig.loginFailureRateLimit, {
    maxFailures: 10,
    windowMs: 5 * 60 * 1000,
  });
});

test("F. the real challenge limit still cuts off the attempt after maxChallenges", () => {
  const { maxChallenges, windowMs } = webauthnConfig.loginChallengeRateLimit;
  const limiter = createFixedWindowLimiter("challenge-limit-test", maxChallenges, windowMs);

  for (let attempt = 1; attempt <= maxChallenges; attempt += 1) {
    assert.equal(consume(limiter, "client"), true, `attempt ${attempt} should be allowed`);
  }
  assert.equal(
    consume(limiter, "client"),
    false,
    "the attempt after maxChallenges must be blocked"
  );
});

test("F. the real failure limit still cuts off the attempt after maxFailures", () => {
  const { maxFailures, windowMs } = webauthnConfig.loginFailureRateLimit;
  const limiter = createFixedWindowLimiter("failure-limit-test", maxFailures, windowMs);

  for (let attempt = 1; attempt <= maxFailures; attempt += 1) {
    assert.equal(consume(limiter, "client"), true, `attempt ${attempt} should be allowed`);
  }
  assert.equal(
    consume(limiter, "client"),
    false,
    "the attempt after maxFailures must be blocked"
  );
});
