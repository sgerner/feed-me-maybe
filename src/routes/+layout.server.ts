import { getDb } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.sessionId) {
    return { feeds: [] };
  }

  const db = getDb();
  const feeds = db.prepare('SELECT id, title, icon_url FROM feeds WHERE enabled = 1 ORDER BY title ASC').all() as Array<{ id: string; title: string; icon_url: string | null }>;

  return {
    feeds
  };
};
