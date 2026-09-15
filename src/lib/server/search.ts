import { getDb } from '$lib/server/db';

export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LENGTH = 500;

export type SearchSort = 'relevance' | 'recent';

export type SearchFilters = {
  feed?: string;
  category?: string;
  before?: number;
  after?: number;
  unread?: boolean;
  read?: boolean;
  saved?: boolean;
  hidden?: boolean;
  rejected?: boolean;
};

export type ParsedSearchQuery = {
  text: string;
  filters: SearchFilters;
  tokens: string[];
};

export type SearchArticle = {
  id: string;
  feedId: string;
  url: string;
  title: string;
  author: string | null;
  summary: string | null;
  imageUrl: string | null;
  categories: string | null;
  publishedAt: number | null;
  fetchedAt: number;
  read: number;
  saved: number;
  hidden: number;
  thumbsUp: number;
  thumbsDown: number;
  rejected: number;
  readAt: number | null;
  savedAt: number | null;
  hiddenAt: number | null;
  rejectedAt: number | null;
  stateVersion: number;
  heuristicScore: number | null;
  combinedScore: number | null;
  feedTitle: string | null;
  feedUrl: string | null;
  feedCategory: string | null;
  relevance: number | null;
  titleHighlight: string | null;
  authorHighlight: string | null;
  summaryHighlight: string | null;
  contentHighlight: string | null;
  feedTitleHighlight: string | null;
  categoryHighlight: string | null;
};

export type SearchResponse = {
  query: string;
  parsed: ParsedSearchQuery;
  sort: SearchSort;
  limit: number;
  total: number;
  articles: SearchArticle[];
  nextCursor: string | null;
};

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchQueryError';
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function parseDate(value: string, operator: 'before' | 'after'): number {
  const normalized = unquote(value);
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00.000Z`
    : normalized;
  const timestamp = Date.parse(isoDate);
  if (!normalized || !Number.isFinite(timestamp)) {
    throw new SearchQueryError(`${operator} must be an ISO date or YYYY-MM-DD`);
  }
  return timestamp;
}

function tokenize(value: string): string[] {
  return value.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

function makeFtsQuery(terms: string[]): string {
  const normalizedTerms = terms
    .map((term) =>
      unquote(term)
        .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
        .trim(),
    )
    .flatMap((term) => term.split(/\s+/))
    .filter(Boolean);
  return normalizedTerms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ');
}

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const query = rawQuery.trim();
  if (query.length > MAX_SEARCH_LENGTH) {
    throw new SearchQueryError(
      `Search queries are limited to ${MAX_SEARCH_LENGTH} characters`,
    );
  }

  const filters: SearchFilters = {};
  const textTerms: string[] = [];
  const tokens = tokenize(query);

  for (const token of tokens) {
    const operator = token.match(/^([a-z][a-z_]*)\s*:(.*)$/i);
    if (!operator) {
      textTerms.push(token);
      continue;
    }

    const name = operator[1].toLowerCase();
    const value = unquote(operator[2]);
    if (!value) throw new SearchQueryError(`${name} requires a value`);

    switch (name) {
      case 'feed':
      case 'from':
        filters.feed = value;
        break;
      case 'category':
        filters.category = value;
        break;
      case 'before':
        filters.before = parseDate(value, 'before');
        break;
      case 'after':
        filters.after = parseDate(value, 'after');
        break;
      case 'is': {
        const state = value.toLowerCase();
        if (state === 'unread') filters.unread = true;
        else if (state === 'read') filters.read = true;
        else if (state === 'saved') filters.saved = true;
        else if (state === 'hidden') filters.hidden = true;
        else if (state === 'rejected') filters.rejected = true;
        else throw new SearchQueryError(`Unsupported is:${state} filter`);
        break;
      }
      default:
        // Unknown field syntax is searched as ordinary text rather than
        // interpolated into SQL or FTS syntax.
        textTerms.push(token);
    }
  }

  return { text: makeFtsQuery(textTerms), filters, tokens };
}

type SearchCursor = {
  sort: SearchSort;
  rank?: number;
  timestamp: number;
  id: string;
};

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string, sort: SearchSort): SearchCursor {
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as SearchCursor;
    if (
      cursor.sort !== sort ||
      typeof cursor.id !== 'string' ||
      !cursor.id ||
      !Number.isFinite(cursor.timestamp) ||
      (sort === 'relevance' && !Number.isFinite(cursor.rank))
    ) {
      throw new Error('invalid');
    }
    return cursor;
  } catch {
    throw new SearchQueryError('Invalid search cursor');
  }
}

function dateExpression(): string {
  return 'COALESCE(a.published_at, a.fetched_at, a.created_at)';
}

type QueryParts = {
  from: string;
  where: string;
  params: Array<string | number>;
};

function buildQueryParts(parsed: ParsedSearchQuery): QueryParts {
  const { filters } = parsed;
  const params: Array<string | number> = [];
  const where: string[] = ['1 = 1'];
  const from = parsed.text
    ? 'FROM articles a JOIN feeds f ON f.id = a.feed_id JOIN article_search ON article_search.article_id = a.id'
    : 'FROM articles a JOIN feeds f ON f.id = a.feed_id';

  if (parsed.text) {
    where.push('article_search MATCH ?');
    params.push(parsed.text);
  }
  if (filters.feed) {
    where.push(
      "(LOWER(f.id) = LOWER(?) OR LOWER(COALESCE(f.title, '')) = LOWER(?) OR LOWER(f.url) = LOWER(?))",
    );
    params.push(filters.feed, filters.feed, filters.feed);
  }
  if (filters.category) {
    where.push(
      "(LOWER(COALESCE(f.category, '')) = LOWER(?) OR LOWER(COALESCE(a.categories, '')) LIKE '%' || LOWER(?) || '%')",
    );
    params.push(filters.category, filters.category);
  }
  if (filters.before !== undefined) {
    where.push(`${dateExpression()} < ?`);
    params.push(filters.before);
  }
  if (filters.after !== undefined) {
    where.push(`${dateExpression()} >= ?`);
    params.push(filters.after);
  }
  if (filters.unread) where.push('a.read = 0');
  if (filters.read) where.push('a.read = 1');
  if (filters.saved) where.push('a.saved = 1');
  if (filters.hidden) where.push('a.hidden = 1');
  if (filters.rejected) where.push('(a.rejected = 1 OR a.thumbs_down = 1)');

  return { from, where: where.join(' AND '), params };
}

function limitValue(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new SearchQueryError(
      `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
    );
  }
  return limit;
}

function searchSelect(parsed: ParsedSearchQuery): string {
  const highlights = parsed.text
    ? `
       highlight(article_search, 1, '<mark>', '</mark>') AS title_highlight,
       highlight(article_search, 2, '<mark>', '</mark>') AS author_highlight,
       highlight(article_search, 3, '<mark>', '</mark>') AS summary_highlight,
       snippet(article_search, 4, '<mark>', '</mark>', '…', 32) AS content_highlight,
       highlight(article_search, 5, '<mark>', '</mark>') AS feed_title_highlight,
       highlight(article_search, 6, '<mark>', '</mark>') AS category_highlight,
       bm25(article_search) AS relevance
    `
    : `
       NULL AS title_highlight,
       NULL AS author_highlight,
       NULL AS summary_highlight,
       NULL AS content_highlight,
       NULL AS feed_title_highlight,
       NULL AS category_highlight,
       NULL AS relevance
    `;

  return `
    SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url,
           a.categories, a.published_at, a.fetched_at, a.read, a.saved,
           a.hidden, a.thumbs_up, a.thumbs_down, a.rejected,
           a.read_at, a.saved_at, a.hidden_at, a.rejected_at, a.state_version,
           a.heuristic_score, a.combined_score,
           f.title AS feed_title, f.url AS feed_url, f.category AS feed_category,
           ${highlights}
  `;
}

function toSearchArticle(row: Record<string, unknown>): SearchArticle {
  return {
    id: String(row.id),
    feedId: String(row.feed_id),
    url: String(row.url),
    title: String(row.title || ''),
    author: (row.author as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    categories: (row.categories as string | null) ?? null,
    publishedAt: (row.published_at as number | null) ?? null,
    fetchedAt: Number(row.fetched_at),
    read: Number(row.read),
    saved: Number(row.saved),
    hidden: Number(row.hidden),
    thumbsUp: Number(row.thumbs_up),
    thumbsDown: Number(row.thumbs_down),
    rejected: Number(row.rejected || row.thumbs_down),
    readAt: (row.read_at as number | null) ?? null,
    savedAt: (row.saved_at as number | null) ?? null,
    hiddenAt: (row.hidden_at as number | null) ?? null,
    rejectedAt: (row.rejected_at as number | null) ?? null,
    stateVersion: Number(row.state_version || 0),
    heuristicScore: (row.heuristic_score as number | null) ?? null,
    combinedScore: (row.combined_score as number | null) ?? null,
    feedTitle: (row.feed_title as string | null) ?? null,
    feedUrl: (row.feed_url as string | null) ?? null,
    feedCategory: (row.feed_category as string | null) ?? null,
    relevance: (row.relevance as number | null) ?? null,
    titleHighlight: (row.title_highlight as string | null) ?? null,
    authorHighlight: (row.author_highlight as string | null) ?? null,
    summaryHighlight: (row.summary_highlight as string | null) ?? null,
    contentHighlight: (row.content_highlight as string | null) ?? null,
    feedTitleHighlight: (row.feed_title_highlight as string | null) ?? null,
    categoryHighlight: (row.category_highlight as string | null) ?? null,
  };
}

export function searchArticles(
  options: {
    query?: string;
    limit?: number;
    cursor?: string;
    sort?: SearchSort;
  } = {},
): SearchResponse {
  const rawQuery = options.query || '';
  const parsed = parseSearchQuery(rawQuery);
  const sort = options.sort || (parsed.text ? 'relevance' : 'recent');
  if (sort !== 'recent' && sort !== 'relevance') {
    throw new SearchQueryError('sort must be recent or relevance');
  }
  if (sort === 'relevance' && !parsed.text) {
    throw new SearchQueryError('relevance sorting requires a text query');
  }
  const limit = limitValue(options.limit);
  const parts = buildQueryParts(parsed);
  const expression = dateExpression();
  const cursorParts: string[] = [];
  const cursorParams: Array<string | number> = [];

  if (options.cursor) {
    const cursor = decodeCursor(options.cursor, sort);
    if (sort === 'recent') {
      cursorParts.push(
        `(${expression} < ? OR (${expression} = ? AND a.id < ?))`,
      );
      cursorParams.push(cursor.timestamp, cursor.timestamp, cursor.id);
    } else {
      cursorParts.push(
        `(bm25(article_search) > ? OR (bm25(article_search) = ? AND ${expression} < ?) OR (bm25(article_search) = ? AND ${expression} = ? AND a.id < ?))`,
      );
      cursorParams.push(
        cursor.rank as number,
        cursor.rank as number,
        cursor.timestamp,
        cursor.rank as number,
        cursor.timestamp,
        cursor.id,
      );
    }
  }

  const cursorWhere = cursorParts.length
    ? ` AND ${cursorParts.join(' AND ')}`
    : '';
  const db = getDb();
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${parts.from} WHERE ${parts.where}`)
    .get(...parts.params) as { total: number };

  const rows = db
    .prepare(
      `${searchSelect(parsed)} ${parts.from}
       WHERE ${parts.where}${cursorWhere}
       ORDER BY ${sort === 'relevance' ? 'bm25(article_search) ASC, ' : ''}${expression} DESC, a.id DESC
       LIMIT ?`,
    )
    .all(...parts.params, ...cursorParams, limit + 1) as Record<
    string,
    unknown
  >[];

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;
  const articles = resultRows.map(toSearchArticle);
  const last = resultRows.at(-1);
  const lastArticle = articles.at(-1);
  const nextCursor =
    hasMore && last && lastArticle
      ? encodeCursor({
          sort,
          rank: sort === 'relevance' ? Number(last.relevance) : undefined,
          timestamp: Number(last.published_at ?? last.fetched_at ?? 0),
          id: String(last.id),
        })
      : null;

  return {
    query: rawQuery,
    parsed,
    sort,
    limit,
    total: totalRow.total,
    articles,
    nextCursor,
  };
}
