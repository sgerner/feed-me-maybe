import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { decrypt } from '$lib/server/ai/crypto';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};
  const db = getDb();
  const configs = db
    .prepare(
      'SELECT id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url FROM provider_configs',
    )
    .all() as Array<{
    id: string;
    provider_id: string;
    model_id: string;
    api_key_encrypted: string | null;
    api_key_nonce: string | null;
    custom_base_url: string | null;
  }>;

  const decryptedConfigs = configs.map((c) => {
    const decryptedRaw = decrypt(
      c.api_key_encrypted || '',
      c.api_key_nonce || '',
    );
    const config = (() => {
      try {
        return JSON.parse(decryptedRaw) as Record<string, string>;
      } catch {
        return { apiKey: decryptedRaw };
      }
    })();
    return {
      ...c,
      config,
    };
  });

  return { configs: decryptedConfigs };
};
