import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { getFeedArticles } from '#lib/server/feed/articles.ts';
import {
  parseArticleSort,
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
  const sort = parseArticleSort(url.searchParams.get('sort'));
  const requestedIds = url.searchParams.getAll('id');
  const isArticleIdRequest = requestedIds.length > 0;
  const rawLimit = url.searchParams.get('limit');
  const parsedLimit =
    rawLimit !== null && /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : 25;
  const limit = Math.min(200, Math.max(1, parsedLimit || 25));
  const rawOffset = url.searchParams.get('offset');
  const offset =
    rawOffset !== null && /^\d{1,8}$/.test(rawOffset)
      ? Number(rawOffset)
      : (page - 1) * limit;

  const rawExcludeIds = [
    ...url.searchParams.getAll('excludeIds'),
    ...url.searchParams.getAll('excludeId'),
  ];
  const excludeIds = Array.from(
    new Set(
      rawExcludeIds
        .flatMap((value) => value.split(','))
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 128),
    ),
  ).slice(0, 200);
  const effectiveOffset =
    excludeIds.length > 0 ? Math.max(0, offset - excludeIds.length) : offset;

  const rawSnapshotAt = url.searchParams.get('snapshotAt');
  const snapshotAt =
    rawSnapshotAt && /^\d{1,13}$/.test(rawSnapshotAt)
      ? Number(rawSnapshotAt)
      : undefined;

  if (feedId && !isArticleIdRequest) {
    return Response.json({
      articles: getFeedArticles({
        feedId,
        page,
        limit,
        offset: effectiveOffset,
        unreadOnly,
        sort,
        snapshotAt:
          snapshotAt !== undefined && Number.isSafeInteger(snapshotAt)
            ? snapshotAt
            : undefined,
        excludeIds,
      }).articles,
    });
  }

  let whereClause = feedId
    ? 'a.hidden = 0 AND a.thumbs_down = 0'
    : 'f.enabled = 1 AND a.hidden = 0 AND a.thumbs_down = 0';
  const params: unknown[] = [];

  const category = url.searchParams.get('category');
  if (category) {
    whereClause += ' AND TRIM(f.category) = ?';
    params.push(category);
  }

  if (unreadOnly) {
    whereClause += ' AND a.read = 0';
  }

  if (feedId) {
    whereClause += ' AND a.feed_id = ?';
    params.push(feedId);
  }

  if (isArticleIdRequest) {
    const articleIds = Array.from(
      new Set(requestedIds.filter((id) => id.length > 0 && id.length <= 128)),
    ).slice(0, 100);

    return Response.json({
      articles: queryGlobalArticleRankingByIds(
        db,
        whereClause,
        params,
        articleIds,
        sort,
      ),
    });
  }

  if (snapshotAt !== undefined && Number.isSafeInteger(snapshotAt)) {
    whereClause += ' AND a.fetched_at <= ?';
    params.push(snapshotAt);
  }

  if (excludeIds.length > 0) {
    whereClause += ` AND a.id NOT IN (${excludeIds.map(() => '?').join(', ')})`;
    params.push(...excludeIds);
  }

  const articles = queryGlobalArticleRanking(
    db,
    whereClause,
    params,
    limit,
    effectiveOffset,
    sort,
  );

  return Response.json({ articles });
};
