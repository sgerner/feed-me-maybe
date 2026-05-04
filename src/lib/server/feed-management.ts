import { getDb } from '$lib/server/db';

export function clearFeedArticles(feedId: string): number {
  const db = getDb();
  return db.transaction(() => {
    const result = db
      .prepare('UPDATE articles SET hidden = 1 WHERE feed_id = ? AND hidden = 0')
      .run(feedId);
    db.prepare('UPDATE feeds SET updated_at = ? WHERE id = ?').run(
      Date.now(),
      feedId,
    );
    return result.changes;
  })();
}
