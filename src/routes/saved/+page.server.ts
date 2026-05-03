import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) throw error(401, 'Unauthorized');
  const db = getDb();
  const articles = db
    .prepare(
      `
    SELECT a.id, a.title, a.url, a.summary, a.image_url, a.published_at, a.saved,
           f.title as feed_title, f.open_mode as feed_open_mode
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.saved = 1
    ORDER BY a.published_at DESC
  `,
    )
    .all();
  return { articles };
};
