// Fixed-window failure counter keyed by caller (an IP, or IP and username). In memory, so it resets on restart.
export function createFailureLimiter({ limit, windowMs = 60_000, now = Date.now } = {}) {
  const windows = new Map();

  function current(key) {
    const entry = windows.get(key);
    if (entry && entry.resetAt > now()) return entry;
    windows.delete(key);
    return null;
  }

  return {
    // Seconds until the caller may try again, or 0 when not limited.
    retryAfter(key) {
      const entry = current(key);
      return entry && entry.count >= limit ? Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)) : 0;
    },
    fail(key) {
      if (windows.size > 10_000) for (const stale of windows.keys()) current(stale);
      const entry = current(key) || { count: 0, resetAt: now() + windowMs };
      entry.count += 1;
      windows.set(key, entry);
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

export function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
