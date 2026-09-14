const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const isProduction = process.env.NODE_ENV === "production";

export const authConfig = {
  cookieName: "oou_session",

  // Lifetime of a session (also determines the cookie max-age).
  sessionLifetimeMs: SEVEN_DAYS_MS,

  cookie: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    maxAge: SEVEN_DAYS_MS,
    path: "/",
  },
};

// Options for clearing the session cookie. Must mirror the cookie that was
// set (secure especially), otherwise the browser may not clear it.
export const clearCookieOptions = {
  httpOnly: authConfig.cookie.httpOnly,
  sameSite: authConfig.cookie.sameSite,
  secure: authConfig.cookie.secure,
  path: authConfig.cookie.path,
};