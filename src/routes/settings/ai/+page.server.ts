import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { decrypt } from '$lib/server/ai/crypto';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};
  const db = getDb();
  const configs = db.prepare('SELECT id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url FROM provider_configs').all() as any[];

  const decryptedConfigs = configs.map(c => {
    const decryptedRaw = decrypt(c.api_key_encrypted || '', c.api_key_nonce || '');
    let config = {};
    try {
      config = JSON.parse(decryptedRaw);
    } catch {
      config = { apiKey: decryptedRaw };
    }
    return {
      ...c,
      config
    };
  });

  return { configs: decryptedConfigs };
};