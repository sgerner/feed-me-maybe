import { getDb } from '#lib/server/db/index.ts';
import { listPinnedSavedSearches } from '#lib/server/saved-searches.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
  if (!locals.sessionId) {
    return {
      feeds: [],
      totalFeeds: 0,
      pausedFeeds: 0,
      feedCategories: [],
      userId: 'admin',
    };
  }

  depends('app:reader-counts');
  const db = getDb();
  const feeds = db
    .prepare(
      `
      SELECT f.id, f.title, f.icon_url, f.category,
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
    category: string | null;
    unread_count: number;
  }>;
  const pinnedSearches = listPinnedSavedSearches();

  const feedSummary = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_feeds,
        SUM(CASE WHEN COALESCE(enabled, 1) = 0 THEN 1 ELSE 0 END) AS paused_feeds
      FROM feeds
    `,
    )
    .get() as
    { total_feeds: number | null; paused_feeds: number | null } | undefined;

  const categoryRows = db
    .prepare(
      `
      SELECT DISTINCT TRIM(category) AS category
      FROM feeds
      WHERE category IS NOT NULL AND TRIM(category) != ''
      ORDER BY category COLLATE NOCASE ASC
    `,
    )
    .all() as Array<{ category: string }>;

  const openMode = db
    .prepare("SELECT value FROM app_settings WHERE key = 'article_open_mode'")
    .get() as { value: string } | undefined;
  const hideOnOpen = db
    .prepare("SELECT value FROM app_settings WHERE key = 'hide_on_open'")
    .get() as { value: string } | undefined;

  return {
    feeds,
    totalFeeds: Number(feedSummary?.total_feeds || 0),
    pausedFeeds: Number(feedSummary?.paused_feeds || 0),
    feedCategories: categoryRows.map((row) => row.category),
    pinnedSearches,
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
