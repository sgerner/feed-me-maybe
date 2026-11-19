import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto';
import { hasProviderCredentials } from './credentials';

describe('AI credential encryption', () => {
  it('round-trips with an explicit application secret', () => {
    const encrypted = encrypt('do-not-send-to-browser');
    expect(decrypt(encrypted.encrypted, encrypted.nonce)).toBe(
      'do-not-send-to-browser',
    );
  });

  it('does not treat an encrypted empty configuration as usable credentials', () => {
    const empty = encrypt(JSON.stringify({}));
    const configured = encrypt(JSON.stringify({ apiKey: 'provider-key' }));

    expect(hasProviderCredentials(empty.encrypted, empty.nonce)).toBe(false);
    expect(hasProviderCredentials(configured.encrypted, configured.nonce)).toBe(
      true,
    );
  });
});
