import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { getAllFeedHealth } from '#lib/server/feed-management.ts';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) throw error(401, 'Unauthorized');

  const db = getDb();
  const feeds = db
    .prepare(
      `
      SELECT f.id, f.url, f.title, f.custom_title, f.category, f.icon_url,
             f.enabled, f.error_count, f.last_fetch_status, f.last_fetch_at,
             f.last_error, f.poll_interval_mins, f.updated_at,
             COUNT(CASE WHEN COALESCE(a.read, 0) = 0 AND COALESCE(a.hidden, 0) = 0 AND COALESCE(a.rejected, 0) = 0 AND COALESCE(a.thumbs_down, 0) = 0 THEN 1 END) AS unread_count,
             COUNT(CASE WHEN COALESCE(a.saved, 0) = 1 THEN 1 END) AS saved_count,
             COUNT(CASE WHEN COALESCE(a.hidden, 0) = 0 AND COALESCE(a.rejected, 0) = 0 AND COALESCE(a.thumbs_down, 0) = 0 THEN 1 END) AS visible_count,
             COUNT(a.id) AS article_count
      FROM feeds f
      LEFT JOIN articles a ON a.feed_id = f.id
      GROUP BY f.id
      ORDER BY COALESCE(NULLIF(f.category, ''), 'Unsorted') COLLATE NOCASE,
               COALESCE(NULLIF(f.title, ''), f.url) COLLATE NOCASE
    `,
    )
    .all() as Array<{
    id: string;
    url: string;
    title: string | null;
    custom_title: number;
    category: string | null;
    icon_url: string | null;
    enabled: number;
    error_count: number;
    last_fetch_status: string | null;
    last_fetch_at: number | null;
    last_error: string | null;
    poll_interval_mins: number | null;
    updated_at: number;
    unread_count: number;
    saved_count: number;
    visible_count: number;
    article_count: number;
  }>;

  const healthByFeed = new Map(
    getAllFeedHealth().map((health) => [health.feedId, health]),
  );
  const totalUnread = feeds.reduce(
    (sum, feed) => (feed.enabled ? sum + Number(feed.unread_count || 0) : sum),
    0,
  );

  return {
    feeds: feeds.map((feed) => {
      const health = healthByFeed.get(feed.id);
      return {
        ...feed,
        health_status: health?.status ?? 'never',
        health_stale: health?.stale ?? false,
      };
    }),
    totalUnread,
  };
};
