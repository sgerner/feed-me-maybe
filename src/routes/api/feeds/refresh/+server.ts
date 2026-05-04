import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ingestFeed } from '$lib/server/feed/ingester';
import { recordAppError } from '$lib/server/logging';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feeds = db
    .prepare('SELECT id FROM feeds WHERE enabled = 1')
    .all() as { id: string }[];

  // Run in background and return immediate response to avoid timeout
  const poll = async () => {
    for (const feed of feeds) {
      try {
        await ingestFeed({ feedId: feed.id });
      } catch (err) {
        console.error(`[api] Error refreshing feed ${feed.id}:`, err);
        recordAppError({
          source: 'api.feeds.refresh',
          error: err,
          details: { feedId: feed.id },
          path: '/api/feeds/refresh',
          method: 'POST',
        });
      }
    }
  };

  poll();

  return json({
    success: true,
    message: `Refreshing ${feeds.length} feeds in background`,
  });
};
