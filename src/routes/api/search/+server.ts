import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  searchArticles,
  SearchQueryError,
  type SearchSort,
} from '$lib/server/search';

function parseLimit(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit))
    throw new SearchQueryError('limit must be an integer');
  return limit;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const sortValue = url.searchParams.get('sort');
    const sort = sortValue ? (sortValue as SearchSort) : undefined;
    if (sortValue && sortValue !== 'recent' && sortValue !== 'relevance') {
      throw new SearchQueryError('sort must be recent or relevance');
    }

    const result = searchArticles({
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      limit: parseLimit(url.searchParams.get('limit')),
      cursor: url.searchParams.get('cursor') || undefined,
      sort,
    });
    return json(result);
  } catch (error: unknown) {
    if (error instanceof SearchQueryError) {
      return json({ error: error.message }, { status: 400 });
    }
    console.error('[api/search] failed', error);
    return json({ error: 'Search failed' }, { status: 500 });
  }
};
