import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { getFeedArticles } from '#lib/server/feed/articles.ts';
import {
  queryGlobalArticleRanking,
  queryGlobalArticleRankingByIds,
} from '#lib/server/ranking.ts';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const page = Math.max(
    1,
    parseInt(url.searchParams.get('page') || '1', 10) || 1,
  );
  const feedId = url.searchParams.get('feedId');
  const unreadOnly = url.searchParams.get('unread') === '1';
  const requestedIds = url.searchParams.getAll('id');
  const isArticleIdRequest = requestedIds.length > 0;
  const limit = 25;
  const rawOffset = url.searchParams.get('offset');
  const offset =
    rawOffset !== null && /^\d{1,8}$/.test(rawOffset)
      ? Number(rawOffset)
      : (page - 1) * limit;

  let whereClause = 'a.hidden = 0 AND a.thumbs_down = 0';
  const params: unknown[] = [];

  if (feedId && !unreadOnly && !isArticleIdRequest) {
    return json({
      articles: getFeedArticles({ feedId, page, offset }).articles,
    });
  }
  const category = url.searchParams.get('category');
  if (category) {
    whereClause += ' AND TRIM(f.category) = ? AND f.enabled = 1';
    params.push(category);
  }

  if (unreadOnly) {
    whereClause += ' AND a.read = 0';
  }

  if (feedId && isArticleIdRequest) {
    whereClause += ' AND a.feed_id = ?';
    params.push(feedId);
  }

  if (isArticleIdRequest) {
    const articleIds = Array.from(
      new Set(requestedIds.filter((id) => id.length > 0 && id.length <= 128)),
    ).slice(0, 100);

    return json({
      articles: queryGlobalArticleRankingByIds(
        db,
        whereClause,
        params,
        articleIds,
      ),
    });
  }

  const rawSnapshotAt = url.searchParams.get('snapshotAt');
  if (rawSnapshotAt && /^\d{1,13}$/.test(rawSnapshotAt)) {
    const snapshotAt = Number(rawSnapshotAt);
    if (Number.isSafeInteger(snapshotAt)) {
      whereClause += ' AND a.fetched_at <= ?';
      params.push(snapshotAt);
    }
  }

  const articles = queryGlobalArticleRanking(
    db,
    whereClause,
    params,
    limit,
    offset,
  );

  return json({ articles });
};
