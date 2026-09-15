import { getDb } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.sessionId) {
    return { feeds: [], userId: 'admin' };
  }

  const db = getDb();
  const feeds = db
    .prepare(
      `
      SELECT f.id, f.title, f.icon_url,
             COUNT(CASE WHEN a.read = 0 AND a.hidden = 0 AND a.thumbs_down = 0 THEN 1 END) AS unread_count
      FROM feeds f
      LEFT JOIN articles a ON a.feed_id = f.id
      WHERE f.enabled = 1
      GROUP BY f.id
      ORDER BY f.title ASC
    `,
    )
    .all() as Array<{
    id: string;
    title: string;
    icon_url: string | null;
    unread_count: number;
  }>;

  const counts = db
    .prepare(
      `
      SELECT COUNT(*) AS total,
             COUNT(CASE WHEN read = 0 AND hidden = 0 AND thumbs_down = 0 THEN 1 END) AS unread,
             COUNT(CASE WHEN saved = 1 THEN 1 END) AS saved
      FROM articles
    `,
    )
    .get() as { total: number; unread: number; saved: number };

  const openMode = db
    .prepare("SELECT value FROM app_settings WHERE key = 'article_open_mode'")
    .get() as { value: string } | undefined;
  const hideOnOpen = db
    .prepare("SELECT value FROM app_settings WHERE key = 'hide_on_open'")
    .get() as { value: string } | undefined;

  return {
    feeds,
    counts,
    sessionId: locals.sessionId,
    // This app currently has one local account. Keep the offline scope stable
    // across session expiry so cached private data remains correctly owned.
    userId: 'admin',
    globalSettings: {
      articleOpenMode: openMode?.value || 'app',
      hideOnOpen: hideOnOpen?.value === 'true',
    },
  };
};
