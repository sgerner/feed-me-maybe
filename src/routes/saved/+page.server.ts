import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { OfflineArticle } from '#lib/offline/types.ts';
import { getDb } from '#lib/server/db/index.ts';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) throw error(401, 'Unauthorized');
  const db = getDb();
  const articles = db
    .prepare(
      `
    SELECT a.id, a.title, a.url, a.summary, a.image_url, a.published_at, a.fetched_at, a.saved, a.read, a.hidden, a.thumbs_up, a.thumbs_down,
           f.title as feed_title, f.open_mode as feed_open_mode
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.saved = 1
    ORDER BY COALESCE(a.saved_at, a.updated_at, a.fetched_at) DESC, a.id DESC
  `,
    )
    .all() as OfflineArticle[];
  return { articles };
};
