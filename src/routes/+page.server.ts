import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { queryGlobalArticleRanking } from '#lib/server/ranking.ts';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const category = url.searchParams.get('category')?.trim() || '';
  const conditions = category
    ? ' AND TRIM(f.category) = ? AND f.enabled = 1'
    : '';
  const parameters = category ? [category] : [];

  const page = Math.max(
    1,
    parseInt(url.searchParams.get('page') || '1', 10) || 1,
  );
  const limit = 25;
  const offset = (page - 1) * limit;
  const snapshotAt = Date.now();
  const whereClause =
    'a.hidden = 0 AND a.thumbs_down = 0' +
    conditions +
    ' AND a.fetched_at <= ?';

  const initialRows = queryGlobalArticleRanking(
    db,
    whereClause,
    [...parameters, snapshotAt],
    limit + 1,
    offset,
  );
  const articles = initialRows.slice(0, limit);

  return {
    category,
    articles,
    page,
    initialHasMore: initialRows.length > limit,
    snapshotAt,
  };
};
