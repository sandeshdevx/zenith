/**
 * Soft per-IP session-creation limit (PRD edge case: 3 active sessions per IP
 * per hour, but "a genuine user in crisis should never be locked out").
 * Over the limit we still allow the session and record an operational event —
 * a soft signal for abuse monitoring, never a hard block.
 *
 * In-memory and per-instance by design for V1; IPs are never written to the
 * database and never associated with session rows. Move to Redis only if the
 * TRD's scale triggers demand it.
 */

const WINDOW_MS = 60 * 60 * 1000;
const SOFT_LIMIT = 3;

const creations = new Map<string, number[]>();

export function recordSessionCreation(ip: string, nowMs = Date.now()): { overLimit: boolean } {
  const windowStart = nowMs - WINDOW_MS;
  const timestamps = (creations.get(ip) ?? []).filter((t) => t > windowStart);
  timestamps.push(nowMs);
  creations.set(ip, timestamps);
  return { overLimit: timestamps.length > SOFT_LIMIT };
}

/** Periodic cleanup so the map cannot grow unbounded. */
export function pruneRateLimiter(nowMs = Date.now()): void {
  const windowStart = nowMs - WINDOW_MS;
  for (const [ip, timestamps] of creations) {
    const live = timestamps.filter((t) => t > windowStart);
    if (live.length === 0) creations.delete(ip);
    else creations.set(ip, live);
  }
}
