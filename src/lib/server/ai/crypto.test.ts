import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto';

describe('AI credential encryption', () => {
  it('round-trips with an explicit application secret', () => {
    const encrypted = encrypt('do-not-send-to-browser');
    expect(decrypt(encrypted.encrypted, encrypted.nonce)).toBe(
      'do-not-send-to-browser',
    );
  });
});
