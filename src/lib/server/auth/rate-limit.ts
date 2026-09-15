const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;
const BLOCK_MS = 5 * 60_000;
const MAX_ENTRIES = 10_000;

type AttemptState = {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
  touchedAt: number;
};

const attempts = new Map<string, AttemptState>();

function cleanup(now: number): void {
  for (const [key, state] of attempts) {
    if (state.touchedAt + WINDOW_MS < now && state.blockedUntil <= now) {
      attempts.delete(key);
    }
  }
  if (attempts.size <= MAX_ENTRIES) return;
  const oldest = [...attempts.entries()]
    .sort(([, a], [, b]) => a.touchedAt - b.touchedAt)
    .slice(0, attempts.size - MAX_ENTRIES);
  for (const [key] of oldest) attempts.delete(key);
}

export function consumeLoginAttempt(
  key: string,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds?: number } {
  const normalizedKey = key.trim() || 'unknown';
  cleanup(now);
  const current = attempts.get(normalizedKey);
  if (current?.blockedUntil && current.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((current.blockedUntil - now) / 1000),
    };
  }

  const state =
    current && current.windowStartedAt + WINDOW_MS > now
      ? current
      : { count: 0, windowStartedAt: now, blockedUntil: 0, touchedAt: now };
  if (state.count >= MAX_ATTEMPTS) {
    state.blockedUntil = now + BLOCK_MS;
    state.touchedAt = now;
    attempts.set(normalizedKey, state);
    return { allowed: false, retryAfterSeconds: Math.ceil(BLOCK_MS / 1000) };
  }
  state.count += 1;
  state.touchedAt = now;
  attempts.set(normalizedKey, state);
  return { allowed: true };
}

export function resetLoginAttempts(key: string): void {
  attempts.delete(key.trim() || 'unknown');
}

export function getClientAddress(getClientAddress: () => string): string {
  try {
    return getClientAddress() || 'unknown';
  } catch {
    return 'unknown';
  }
}
