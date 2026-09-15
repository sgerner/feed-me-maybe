import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

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

  const safeConfigs = configs.map((c) => {
    return {
      id: c.id,
      provider_id: c.provider_id,
      model_id: c.model_id,
      custom_base_url: c.custom_base_url,
      has_api_key: Boolean(c.api_key_encrypted && c.api_key_nonce),
    };
  });

  return { configs: safeConfigs };
};
