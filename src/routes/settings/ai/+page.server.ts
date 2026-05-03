import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};
  const db = getDb();
  const configs = db.prepare('SELECT id, provider_id, model_id, custom_base_url FROM provider_configs').all();
  return { configs };
};