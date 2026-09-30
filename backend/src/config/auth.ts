const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const REMEMBERED_ACCOUNT_DAYS = 90;
const REMEMBERED_ACCOUNT_MS = REMEMBERED_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
const DEVICE_BINDING_DAYS = 90;
const DEVICE_BINDING_MS = DEVICE_BINDING_DAYS * 24 * 60 * 60 * 1000;

// In development, use host-only cookies (no Domain attribute) so the browser
// stores them for the frontend origin (localhost:4173) via the Vite proxy.
// In production, also use host-only cookies (no Domain attribute).
const cookieDomain = undefined;

/**
 * Whether session cookies carry the `Secure` attribute.
 *
 * The attribute restricts a cookie to HTTPS, so browsers correctly drop it on the
 * plain-HTTP dev server (`http://localhost:4173`). It therefore defaults to on in
 * production and off elsewhere.
 *
 * `AUTH_COOKIE_SECURE` exists for the one deployment that is neither: an HTTPS
 * origin reached over the local network. There the default is wrong in the
 * harmless direction — the cookie works without `Secure` but is not restricted to
 * HTTPS — so an operator serving that origin can opt in explicitly.
 *
 * The override is deliberately one-directional. `AUTH_COOKIE_SECURE=false` under
 * `NODE_ENV=production` is rejected rather than obeyed, so the production
 * behaviour cannot be weakened by a stray environment variable.
 */
export function resolveCookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const isProduction = env.NODE_ENV === "production";
  const raw = env.AUTH_COOKIE_SECURE;

  if (raw === undefined || raw.trim() === "") {
    return isProduction;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized !== "true" && normalized !== "false") {
    throw new Error(
      `Invalid value for AUTH_COOKIE_SECURE: "${raw}". Use true or false.`
    );
  }

  const secure = normalized === "true";
  if (isProduction && !secure) {
    throw new Error(
      "AUTH_COOKIE_SECURE=false is not allowed when NODE_ENV=production. Session " +
        "cookies must carry the Secure attribute in production."
    );
  }
  return secure;
}

const cookieSecure = resolveCookieSecure(process.env);

export const authConfig = {
  cookieName: "oou_session",
  rememberedAccountCookieName: "oou_remembered_student",
  deviceBindingCookieName: "oou_device_binding",

  // Lifetime of a session (also determines the cookie max-age).
  sessionLifetimeMs: SEVEN_DAYS_MS,

  cookie: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: cookieSecure,
    maxAge: SEVEN_DAYS_MS,
    path: "/",
    domain: cookieDomain,
  },

  rememberedAccountCookie: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: cookieSecure,
    maxAge: REMEMBERED_ACCOUNT_MS,
    path: "/",
    domain: cookieDomain,
  },

  deviceBindingCookie: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: cookieSecure,
    maxAge: DEVICE_BINDING_MS,
    path: "/",
    domain: cookieDomain,
  },
};

// Options for clearing the session cookie. Must mirror the cookie that was
// set (secure especially), otherwise the browser may not clear it.
export const clearCookieOptions = {
  httpOnly: authConfig.cookie.httpOnly,
  sameSite: authConfig.cookie.sameSite,
  secure: authConfig.cookie.secure,
  path: authConfig.cookie.path,
  domain: authConfig.cookie.domain,
};

export const clearRememberedAccountCookieOptions = {
  httpOnly: authConfig.rememberedAccountCookie.httpOnly,
  sameSite: authConfig.rememberedAccountCookie.sameSite,
  secure: authConfig.rememberedAccountCookie.secure,
  path: authConfig.rememberedAccountCookie.path,
  domain: authConfig.rememberedAccountCookie.domain,
};

export const clearDeviceBindingCookieOptions = {
  httpOnly: authConfig.deviceBindingCookie.httpOnly,
  sameSite: authConfig.deviceBindingCookie.sameSite,
  secure: authConfig.deviceBindingCookie.secure,
  path: authConfig.deviceBindingCookie.path,
  domain: authConfig.deviceBindingCookie.domain,
};