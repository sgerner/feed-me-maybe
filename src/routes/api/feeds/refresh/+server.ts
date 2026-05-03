import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ingestFeed } from '$lib/server/feed/ingester';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feeds = db.prepare('SELECT id, url FROM feeds WHERE enabled = 1').all() as { id: string; url: string }[];

  // Run in background and return immediate response to avoid timeout
  const poll = async () => {
    for (const feed of feeds) {
      try {
        await ingestFeed({ feedId: feed.id, url: feed.url });
      } catch (err) {
        console.error(`[api] Error refreshing feed ${feed.id}:`, err);
      }
    }
  };
  
  poll();

  return json({ success: true, message: `Refreshing ${feeds.length} feeds in background` });
};
