import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authConfig,
  clearCookieOptions,
  clearDeviceBindingCookieOptions,
  clearRememberedAccountCookieOptions,
  resolveCookieSecure,
} from "../src/config/auth";

/**
 * `Secure` on a session cookie is the one attribute whose correct value depends on
 * how the app is being served: a browser drops a `Secure` cookie from a plain-HTTP
 * page, so the dev server must not set it, while production must. These tests pin
 * that default in both directions and pin the one rule that matters most — the
 * override can add `Secure` outside production but can never remove it from
 * production.
 */

test("Secure defaults on in production and off everywhere else", () => {
  assert.equal(resolveCookieSecure({ NODE_ENV: "production" }), true);
  assert.equal(resolveCookieSecure({}), false);
  assert.equal(resolveCookieSecure({ NODE_ENV: "development" }), false);
  assert.equal(resolveCookieSecure({ NODE_ENV: "test" }), false);
  assert.equal(resolveCookieSecure({ NODE_ENV: "staging" }), false);
});

test("an unset or blank AUTH_COOKIE_SECURE falls back to the environment default", () => {
  assert.equal(resolveCookieSecure({ NODE_ENV: "production", AUTH_COOKIE_SECURE: "" }), true);
  assert.equal(resolveCookieSecure({ NODE_ENV: "production", AUTH_COOKIE_SECURE: "   " }), true);
  assert.equal(resolveCookieSecure({ AUTH_COOKIE_SECURE: "" }), false);
  assert.equal(resolveCookieSecure({ AUTH_COOKIE_SECURE: "  " }), false);
});

test("AUTH_COOKIE_SECURE=true opts a non-production HTTPS deployment in", () => {
  assert.equal(resolveCookieSecure({ AUTH_COOKIE_SECURE: "true" }), true);
  assert.equal(resolveCookieSecure({ NODE_ENV: "development", AUTH_COOKIE_SECURE: "true" }), true);
  assert.equal(resolveCookieSecure({ NODE_ENV: "production", AUTH_COOKIE_SECURE: "true" }), true);
});

test("the value is read leniently for case and surrounding whitespace", () => {
  for (const raw of ["TRUE", "True", "  true  ", "\ttrue\n"]) {
    assert.equal(
      resolveCookieSecure({ AUTH_COOKIE_SECURE: raw }),
      true,
      `expected AUTH_COOKIE_SECURE="${raw}" to be read as true`
    );
  }
  for (const raw of ["FALSE", "False", "  false  "]) {
    assert.equal(
      resolveCookieSecure({ NODE_ENV: "development", AUTH_COOKIE_SECURE: raw }),
      false,
      `expected AUTH_COOKIE_SECURE="${raw}" to be read as false`
    );
  }
});

test("AUTH_COOKIE_SECURE=false is refused in production", () => {
  for (const raw of ["false", "FALSE", "  false  "]) {
    assert.throws(
      () => resolveCookieSecure({ NODE_ENV: "production", AUTH_COOKIE_SECURE: raw }),
      /AUTH_COOKIE_SECURE=false is not allowed when NODE_ENV=production/,
      `expected AUTH_COOKIE_SECURE="${raw}" to be refused in production`
    );
  }
});

test("an unrecognised AUTH_COOKIE_SECURE is rejected with a clear message", () => {
  for (const raw of ["1", "0", "yes", "no", "on", "off", "secure", "TRUEISH"]) {
    assert.throws(
      () => resolveCookieSecure({ AUTH_COOKIE_SECURE: raw }),
      /Invalid value for AUTH_COOKIE_SECURE/,
      `expected AUTH_COOKIE_SECURE="${raw}" to be rejected`
    );
  }
});

test("an invalid value is rejected in production too, rather than silently defaulting", () => {
  assert.throws(
    () => resolveCookieSecure({ NODE_ENV: "production", AUTH_COOKIE_SECURE: "maybe" }),
    /Invalid value for AUTH_COOKIE_SECURE/
  );
});

test("every cookie in authConfig resolves Secure from the same environment", () => {
  const expected = resolveCookieSecure(process.env);

  assert.equal(authConfig.cookie.secure, expected);
  assert.equal(authConfig.rememberedAccountCookie.secure, expected);
  assert.equal(authConfig.deviceBindingCookie.secure, expected);
});

test("the clear-cookie options mirror the cookie they clear", () => {
  assert.equal(clearCookieOptions.secure, authConfig.cookie.secure);
  assert.equal(
    clearRememberedAccountCookieOptions.secure,
    authConfig.rememberedAccountCookie.secure
  );
  assert.equal(clearDeviceBindingCookieOptions.secure, authConfig.deviceBindingCookie.secure);
});

test("the override leaves the other cookie attributes untouched", () => {
  // The change under test is about `Secure` only. These are the attributes that
  // keep the session host-only, script-inaccessible and cross-site safe, and they
  // must not drift while `Secure` is being made configurable.
  for (const cookie of [
    authConfig.cookie,
    authConfig.rememberedAccountCookie,
    authConfig.deviceBindingCookie,
  ]) {
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "lax");
    assert.equal(cookie.domain, undefined);
    assert.equal(cookie.path, "/");
  }
});
