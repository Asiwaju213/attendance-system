import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_API_PROXY_TARGET_URL,
  DEFAULT_DEV_SERVER_HOST,
  DEFAULT_DEV_SERVER_PORT,
  isLoopbackHost,
  resolveDevServerConfig,
} from "../config/devServer";

/**
 * LAN mode is a configuration change, not a code change, so these tests pin the
 * configuration surface: the default stays local-only, an explicit interface is
 * honoured, and the server PC's LAN address is never written into the source.
 */

const projectRoot = join(import.meta.dirname, "..");

test("defaults keep the dev server on loopback and the current local ports", () => {
  const config = resolveDevServerConfig({});

  assert.equal(config.host, DEFAULT_DEV_SERVER_HOST);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, DEFAULT_DEV_SERVER_PORT);
  assert.equal(config.port, 4173);
  assert.equal(config.strictPort, true);
  assert.equal(config.apiProxyTarget, DEFAULT_API_PROXY_TARGET_URL);
  assert.equal(config.apiProxyTarget, "http://127.0.0.1:5000");
  assert.equal(config.allowsLanAccess, false);
});

test("a configured wildcard host enables LAN access", () => {
  const config = resolveDevServerConfig({ VITE_DEV_HOST: "0.0.0.0" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.allowsLanAccess, true);
  assert.equal(config.port, DEFAULT_DEV_SERVER_PORT);
  assert.equal(config.apiProxyTarget, DEFAULT_API_PROXY_TARGET_URL);
});

test("a configured single interface host is accepted and treated as LAN access", () => {
  const config = resolveDevServerConfig({ VITE_DEV_HOST: "10.0.0.5" });

  assert.equal(config.host, "10.0.0.5");
  assert.equal(config.allowsLanAccess, true);
  assert.equal(isLoopbackHost(config.host), false);
});

test("a configured port is respected and keeps the default host", () => {
  const config = resolveDevServerConfig({ VITE_DEV_PORT: "5173" });

  assert.equal(config.port, 5173);
  assert.equal(config.host, DEFAULT_DEV_SERVER_HOST);
  assert.equal(config.strictPort, true);
});

test("the API proxy target stays configurable and is normalised to a bare origin", () => {
  assert.equal(
    resolveDevServerConfig({ VITE_API_PROXY_TARGET: "http://127.0.0.1:5050" })
      .apiProxyTarget,
    "http://127.0.0.1:5050"
  );
  assert.equal(
    resolveDevServerConfig({ VITE_API_PROXY_TARGET: "http://127.0.0.1:5050/" })
      .apiProxyTarget,
    "http://127.0.0.1:5050"
  );
});

test("an invalid host, port or proxy target is rejected with a clear message", () => {
  assert.throws(() => resolveDevServerConfig({ VITE_DEV_HOST: "0.0.0.0:4173" }), /VITE_DEV_HOST/);
  assert.throws(() => resolveDevServerConfig({ VITE_DEV_HOST: "http://0.0.0.0" }), /VITE_DEV_HOST/);
  assert.throws(() => resolveDevServerConfig({ VITE_DEV_PORT: "0" }), /VITE_DEV_PORT/);
  assert.throws(() => resolveDevServerConfig({ VITE_DEV_PORT: "70000" }), /VITE_DEV_PORT/);
  assert.throws(() => resolveDevServerConfig({ VITE_API_PROXY_TARGET: "not a url" }), /VITE_API_PROXY_TARGET/);
  assert.throws(
    () => resolveDevServerConfig({ VITE_API_PROXY_TARGET: "http://127.0.0.1:5000/api" }),
    /VITE_API_PROXY_TARGET/
  );
  assert.throws(
    () => resolveDevServerConfig({ VITE_API_PROXY_TARGET: "ws://127.0.0.1:5000" }),
    /VITE_API_PROXY_TARGET/
  );
});

test("an IPv6 host is accepted and the bracketed form is normalised", () => {
  assert.equal(resolveDevServerConfig({ VITE_DEV_HOST: "::1" }).host, "::1");
  assert.equal(resolveDevServerConfig({ VITE_DEV_HOST: "[::]" }).host, "::");
  assert.equal(resolveDevServerConfig({ VITE_DEV_HOST: "[::]" }).allowsLanAccess, true);
});

test("no server-side configuration file hard-codes a private LAN address", () => {
  // The address a device opens is read from the machine's network configuration, so
  // a literal private address in source would be a bug: it would survive a change
  // of network and silently point at the wrong host.
  for (const file of ["vite.config.ts", join("config", "devServer.ts")]) {
    const source = readFileSync(join(projectRoot, file), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
      `${file} must not contain a private LAN address`
    );
  }
});
