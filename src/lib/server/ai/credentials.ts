import { decrypt } from './crypto';

export function decryptProviderCredentials(
  encrypted: string | null | undefined,
  nonce: string | null | undefined,
): Record<string, string> {
  if (!encrypted || !nonce) return {};
  const plaintext = decrypt(encrypted, nonce);
  if (!plaintext) return {};

  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) => typeof value === 'string' && value.trim().length > 0,
      ),
    ) as Record<string, string>;
  } catch {
    // Older versions stored a single API key as plain encrypted text.
    return { apiKey: plaintext.trim() };
  }
}

export function hasProviderCredentials(
  encrypted: string | null | undefined,
  nonce: string | null | undefined,
): boolean {
  return Object.keys(decryptProviderCredentials(encrypted, nonce)).length > 0;
}
