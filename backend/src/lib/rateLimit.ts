/**
 * A minimal, dependency-free fixed-window rate limiter.
 *
 * The backend has no rate limiting today and the public student device login endpoints must
 * not become an unlimited password-guessing oracle. This is deliberately small and in-memory:
 * it is a focused abuse brake for one public authentication surface, not a distributed
 * throttle. It is per-process, so it resets when the server restarts and is not shared across
 * multiple instances. If the API is ever scaled horizontally or put behind more than one
 * worker, replace this with a shared store.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface FixedWindowLimiter {
  /** Inspect the current window without recording an attempt. */
  check(key: string): RateLimitResult;
  /** Record one attempt and report the resulting state. */
  hit(key: string): RateLimitResult;
  /** Drop the current window, e.g. after a successful authentication. */
  reset(key: string): void;
  /** Drop every tracked window. Intended for tests and operator resets. */
  clearAll(): void;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Hard ceiling on tracked keys so a flood of distinct keys cannot grow the map without
 * bound. When full, the oldest window is evicted first; the map preserves insertion order,
 * so that is the first key.
 */
const MAX_TRACKED_KEYS = 10_000;

export function createFixedWindowLimiter(
  namespace: string,
  limit: number,
  windowMs: number
): FixedWindowLimiter {
  const windows = new Map<string, Window>();

  function evictIfFull(): void {
    while (windows.size >= MAX_TRACKED_KEYS) {
      const oldest = windows.keys().next();
      if (oldest.done) {
        return;
      }
      windows.delete(oldest.value);
    }
  }

  function currentWindow(key: string, now: number): Window {
    const existing = windows.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      evictIfFull();
      const created: Window = { count: 0, resetAt: now + windowMs };
      windows.set(key, created);
      return created;
    }
    return existing;
  }

  function toResult(window: Window, now: number): RateLimitResult {
    return {
      allowed: window.count < limit,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  // Drop windows that can no longer be counted, so the map only holds live windows plus
  // whatever arrived in the current sweep interval. `unref` keeps the timer from holding
  // the process open on shutdown.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) {
      if (window.resetAt <= now) {
        windows.delete(key);
      }
    }
  }, windowMs);
  sweep.unref();

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      const window = currentWindow(key, now);
      return toResult(window, now);
    },

    hit(key: string): RateLimitResult {
      const now = Date.now();
      const window = currentWindow(key, now);
      window.count += 1;
      return toResult(window, now);
    },

    reset(key: string): void {
      windows.delete(key);
    },

    clearAll(): void {
      windows.clear();
    },
  };
}
