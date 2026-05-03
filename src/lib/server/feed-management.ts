import { getDb } from '$lib/server/db';

export function clearFeedArticles(feedId: string): number {
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare('DELETE FROM articles WHERE feed_id = ?').run(feedId);
    db.prepare('UPDATE feeds SET updated_at = ? WHERE id = ?').run(Date.now(), feedId);
    return result.changes;
  })();
}
