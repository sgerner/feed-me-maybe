import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { clearFeedArticles } from '$lib/server/feed-management';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db.prepare('SELECT id FROM feeds WHERE id = ?').get(params.id) as { id: string } | undefined;
  if (!feed) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }

  const result = clearFeedArticles(params.id);

  return json({ success: true, deleted: result });
};
