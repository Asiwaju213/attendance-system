import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  describeServerConfig,
  isLoopbackHost,
  isAnyHost,
  isNetworkAccessibleHost,
  resolveServerConfig,
  serverConfig,
} from "../src/config/server";

/**
 * The binding is the only thing LAN mode changes, so these tests pin the two
 * directions that matter: the default must stay on loopback, and an explicitly
 * configured interface must be honoured. The LAN address itself is never named
 * here — it belongs to the machine's network configuration, not to the code.
 */

test("defaults to loopback so an ordinary dev run is not reachable from the network", () => {
  assert.deepEqual(resolveServerConfig({}), {
    host: DEFAULT_SERVER_HOST,
    port: DEFAULT_SERVER_PORT,
  });
  assert.equal(DEFAULT_SERVER_HOST, "127.0.0.1");
  assert.equal(DEFAULT_SERVER_PORT, 5000);
  assert.equal(resolveServerConfig({}).host, "127.0.0.1");
});

test("blank HOST and PORT fall back to the defaults instead of failing", () => {
  assert.deepEqual(resolveServerConfig({ HOST: "", PORT: "" }), {
    host: DEFAULT_SERVER_HOST,
    port: DEFAULT_SERVER_PORT,
  });
  assert.deepEqual(resolveServerConfig({ HOST: "   ", PORT: "  " }), {
    host: DEFAULT_SERVER_HOST,
    port: DEFAULT_SERVER_PORT,
  });
});

test("a configured wildcard host enables LAN mode", () => {
  const config = resolveServerConfig({ HOST: "0.0.0.0" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, DEFAULT_SERVER_PORT);
  assert.equal(isLoopbackHost(config.host), false);
  assert.equal(isAnyHost(config.host), true);
  assert.equal(isNetworkAccessibleHost(config.host), true);
});

test("a configured single interface host is accepted and stays scoped to it", () => {
  const config = resolveServerConfig({ HOST: "10.0.0.5" });

  assert.equal(config.host, "10.0.0.5");
  assert.equal(isAnyHost(config.host), false);
  assert.equal(isNetworkAccessibleHost(config.host), true);
});

test("the configured port is respected and the default host is kept", () => {
  const config = resolveServerConfig({ PORT: "8080" });

  assert.equal(config.port, 8080);
  assert.equal(config.host, DEFAULT_SERVER_HOST);
});

test("HOST and PORT are independent of each other", () => {
  const config = resolveServerConfig({ HOST: "0.0.0.0", PORT: "5050" });

  assert.deepEqual(config, { host: "0.0.0.0", port: 5050 });
});

test("an invalid PORT is rejected with a clear message", () => {
  for (const port of ["0", "65536", "-1", "abc", "5000abc", "1.5"]) {
    assert.throws(
      () => resolveServerConfig({ PORT: port }),
      /Invalid value for PORT/,
      `expected PORT="${port}" to be rejected`
    );
  }
});

test("an invalid HOST is rejected with a clear message", () => {
  for (const host of [
    "http://127.0.0.1",
    "0.0.0.0:5000",
    "127.0.0.1:5000/path",
    "local host",
    "a@b",
    "../etc",
    "-leading-hyphen",
    "999.999.999.999",
  ]) {
    assert.throws(
      () => resolveServerConfig({ HOST: host }),
      /Invalid value for HOST/,
      `expected HOST="${host}" to be rejected`
    );
  }
});

test("an IPv6 host is accepted, and the bracketed form is normalised", () => {
  assert.equal(resolveServerConfig({ HOST: "::1" }).host, "::1");
  assert.equal(resolveServerConfig({ HOST: "::" }).host, "::");
  assert.equal(resolveServerConfig({ HOST: "[::1]" }).host, "::1");
  assert.equal(resolveServerConfig({ HOST: "[::]" }).host, "::");
  assert.equal(resolveServerConfig({ HOST: "fe80::1" }).host, "fe80::1");
  assert.equal(isLoopbackHost(resolveServerConfig({ HOST: "[::1]" }).host), true);
  assert.equal(isAnyHost(resolveServerConfig({ HOST: "[::]" }).host), true);
});

test("a hostname is accepted so a named interface can be used", () => {
  const config = resolveServerConfig({ HOST: "attendance.example.edu" });

  assert.equal(config.host, "attendance.example.edu");
  assert.equal(isNetworkAccessibleHost(config.host), true);
});

test("loopback and wildcard hosts are classified consistently", () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "LOCALHOST"]) {
    assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
    assert.equal(isNetworkAccessibleHost(host), false);
  }

  for (const host of ["0.0.0.0", "::"]) {
    assert.equal(isAnyHost(host), true, `${host} should be a wildcard bind`);
    assert.equal(isLoopbackHost(host), false);
    assert.equal(isNetworkAccessibleHost(host), true);
  }
});

test("the startup description reports the effective host and port and nothing else", () => {
  const local = describeServerConfig({ host: "127.0.0.1", port: 5000 });
  assert.match(local, /127\.0\.0\.1:5000/);
  assert.match(local, /loopback only/);

  const lan = describeServerConfig({ host: "0.0.0.0", port: 5000 });
  assert.match(lan, /0\.0\.0\.0:5000/);
  assert.match(lan, /local network/);
  assert.doesNotMatch(lan, /loopback only/);

  const scoped = describeServerConfig({ host: "10.0.0.5", port: 5000 });
  assert.match(scoped, /10\.0\.0\.5:5000/);
  assert.match(scoped, /single network interface/);
});

test("the effective serverConfig matches the process environment", () => {
  assert.deepEqual(serverConfig, resolveServerConfig(process.env));
});
