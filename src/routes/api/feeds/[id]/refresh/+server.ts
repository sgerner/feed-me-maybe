import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ingestFeed } from '$lib/server/feed/ingester';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db
    .prepare('SELECT id, url FROM feeds WHERE id = ?')
    .get(params.id) as { id: string; url: string } | undefined;

  if (!feed) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }

  const result = await ingestFeed({ feedId: feed.id, url: feed.url });

  return json(result);
};
