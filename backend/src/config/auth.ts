const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const REMEMBERED_ACCOUNT_DAYS = 90;
const REMEMBERED_ACCOUNT_MS = REMEMBERED_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
const DEVICE_BINDING_DAYS = 90;
const DEVICE_BINDING_MS = DEVICE_BINDING_DAYS * 24 * 60 * 60 * 1000;

const isProduction = process.env.NODE_ENV === "production";

// In development, use host-only cookies (no Domain attribute) so the browser
// stores them for the frontend origin (localhost:4173) via the Vite proxy.
// In production, also use host-only cookies (no Domain attribute).
const cookieDomain = undefined;

export const authConfig = {
  cookieName: "oou_session",
  rememberedAccountCookieName: "oou_remembered_student",
  deviceBindingCookieName: "oou_device_binding",

  // Lifetime of a session (also determines the cookie max-age).
  sessionLifetimeMs: SEVEN_DAYS_MS,

  cookie: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    maxAge: SEVEN_DAYS_MS,
    path: "/",
    domain: cookieDomain,
  },

  rememberedAccountCookie: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    maxAge: REMEMBERED_ACCOUNT_MS,
    path: "/",
    domain: cookieDomain,
  },

  deviceBindingCookie: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
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