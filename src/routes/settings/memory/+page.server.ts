import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};
  const db = getDb();
  const preferences = db
    .prepare('SELECT * FROM user_preference_memory ORDER BY strength DESC')
    .all();
  return { preferences };
};
