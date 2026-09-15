import { describe, expect, it } from 'vitest';
import { consumeLoginAttempt, resetLoginAttempts } from './rate-limit';

describe('login rate limiting', () => {
  it('limits attempts in a bounded window and supports successful-login reset', () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const start = 1_000_000;
    resetLoginAttempts(key);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(consumeLoginAttempt(key, start + attempt)).toEqual({
        allowed: true,
      });
    }
    expect(consumeLoginAttempt(key, start + 5).allowed).toBe(false);

    resetLoginAttempts(key);
    expect(consumeLoginAttempt(key, start + 6).allowed).toBe(true);
  });
});
