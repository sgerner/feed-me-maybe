import { getDb } from '#lib/server/db/index.ts';

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
  feedOpenMode: string | null;
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

function normalizeFtsPhrase(raw: string): string {
  const words = unquote(raw)
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words.length ? `"${words.join(' ').replace(/"/g, '""')}"` : '';
}

function makeFtsQuery(terms: string[]): string {
  const positiveParts: string[] = [];
  const negatedPhrases: string[] = [];
  let pendingOr = false;

  for (let i = 0; i < terms.length; i += 1) {
    const token = terms[i];
    if (token === 'NOT' && i + 1 < terms.length) {
      const next = terms[i + 1];
      if (next !== 'OR' && next !== 'NOT') {
        i += 1;
        const phrase = normalizeFtsPhrase(next);
        if (phrase) negatedPhrases.push(phrase);
      }
      pendingOr = false;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const phrase = normalizeFtsPhrase(token.slice(1));
      if (phrase) negatedPhrases.push(phrase);
      pendingOr = false;
      continue;
    }

    if (token === 'OR') {
      if (positiveParts.length > 0) {
        pendingOr = true;
      }
      continue;
    }

    const phrase = normalizeFtsPhrase(token);
    if (!phrase) continue;
    if (pendingOr && positiveParts.length > 0) {
      positiveParts.push('OR', phrase);
    } else {
      positiveParts.push(phrase);
    }
    pendingOr = false;
  }

  const positiveExpr = positiveParts.join(' ');
  const negationExpr = negatedPhrases
    .map((phrase) => `NOT ${phrase}`)
    .join(' ');
  if (!positiveExpr) return negationExpr;
  if (!negationExpr) return positiveExpr;
  const wrappedPositive = positiveParts.includes('OR')
    ? `(${positiveExpr})`
    : positiveExpr;
  return `${wrappedPositive} ${negationExpr}`;
}

function extractStandaloneNegation(ftsText: string): string | null {
  if (!ftsText.startsWith('NOT ')) return null;
  const phrases = ftsText
    .split(/\bNOT\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return phrases.length ? phrases.join(' OR ') : null;
}

export type NormalizedFtsSearchQuery = {
  ftsQuery: string;
  standaloneNegation: string | null;
  emptyMatch: boolean;
};

export function normalizeFtsSearchQuery(
  rawQuery: string,
): NormalizedFtsSearchQuery | null {
  const query = rawQuery.trim();
  if (!query) return null;
  if (query.length > MAX_SEARCH_LENGTH) {
    throw new SearchQueryError(
      `Search queries are limited to ${MAX_SEARCH_LENGTH} characters`,
    );
  }
  const ftsQuery = makeFtsQuery(tokenize(query));
  if (!ftsQuery) {
    return { ftsQuery: '', standaloneNegation: null, emptyMatch: true };
  }
  return {
    ftsQuery,
    standaloneNegation: extractStandaloneNegation(ftsQuery),
    emptyMatch: false,
  };
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
        const states = value
          .toLowerCase()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        for (const state of states) {
          if (state === 'unread') filters.unread = true;
          else if (state === 'read') filters.read = true;
          else if (state === 'saved') filters.saved = true;
          else if (state === 'hidden') filters.hidden = true;
          else if (state === 'rejected') filters.rejected = true;
          else throw new SearchQueryError(`Unsupported is:${state} filter`);
        }
        break;
      }
      default:
        // Unknown field syntax is searched as ordinary text rather than
        // interpolated into SQL or FTS syntax.
        textTerms.push(token);
    }
  }

  const text = makeFtsQuery(textTerms);
  const hasFilters = Object.values(filters).some(
    (value) => value !== undefined,
  );
  if (query && !text && !hasFilters) {
    throw new SearchQueryError('Enter a search word or supported filter.');
  }

  return { text, filters, tokens };
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
  return 'COALESCE(a.published_at, a.fetched_at)';
}

type QueryParts = {
  from: string;
  where: string;
  params: Array<string | number>;
  hasPositiveFts: boolean;
};

function buildQueryParts(parsed: ParsedSearchQuery): QueryParts {
  const { filters } = parsed;
  const params: Array<string | number> = [];
  const where: string[] = ['1 = 1'];
  const standaloneNegation = parsed.text
    ? extractStandaloneNegation(parsed.text)
    : null;
  const hasPositiveFts = Boolean(parsed.text && !standaloneNegation);
  const from = hasPositiveFts
    ? 'FROM articles a JOIN feeds f ON f.id = a.feed_id JOIN article_search ON article_search.rowid = a.rowid'
    : 'FROM articles a JOIN feeds f ON f.id = a.feed_id';

  if (hasPositiveFts) {
    where.push('article_search MATCH ?');
    params.push(parsed.text);
  } else if (standaloneNegation) {
    where.push(
      'NOT EXISTS (SELECT 1 FROM article_search WHERE article_search.rowid = a.rowid AND article_search MATCH ?)',
    );
    params.push(standaloneNegation);
  }
  if (filters.feed) {
    where.push(
      "(LOWER(TRIM(f.id)) = LOWER(TRIM(?)) OR LOWER(TRIM(COALESCE(f.title, ''))) = LOWER(TRIM(?)) OR LOWER(TRIM(f.url)) = LOWER(TRIM(?)) OR LOWER(TRIM(COALESCE(f.site_url, ''))) = LOWER(TRIM(?)) OR LOWER(COALESCE(f.title, '')) LIKE '%' || LOWER(TRIM(?)) || '%')",
    );
    params.push(
      filters.feed,
      filters.feed,
      filters.feed,
      filters.feed,
      filters.feed,
    );
  }
  if (filters.category) {
    where.push(
      "(LOWER(TRIM(COALESCE(f.category, ''))) = LOWER(TRIM(?)) OR LOWER(COALESCE(a.categories, '')) LIKE '%' || LOWER(TRIM(?)) || '%')",
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
  if (!filters.feed && !filters.saved && !filters.hidden && !filters.rejected) {
    where.push('f.enabled = 1');
  }
  // Hidden articles are discoverable through an explicit state filter, and
  // saved bookmarks remain findable under is:saved even if previously hidden.
  if (!filters.hidden && !filters.rejected && !filters.saved) {
    where.push('a.hidden = 0');
  }
  if (filters.hidden) where.push('a.hidden = 1');
  if (filters.rejected) where.push('(a.rejected = 1 OR a.thumbs_down = 1)');

  return { from, where: where.join(' AND '), params, hasPositiveFts };
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

const BASE_ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url,
  a.categories, a.published_at, a.fetched_at, a.read, a.saved,
  a.hidden, a.thumbs_up, a.thumbs_down, a.rejected,
  a.read_at, a.saved_at, a.hidden_at, a.rejected_at, a.state_version,
  a.heuristic_score, a.combined_score,
  f.title AS feed_title, f.url AS feed_url, f.category AS feed_category,
  f.open_mode AS feed_open_mode
`;

const HIGHLIGHT_START = '\uFDD0';
const HIGHLIGHT_END = '\uFDD1';
const HIGHLIGHT_PAIR_PATTERN = /\uFDD0([^\uFDD0\uFDD1]*)\uFDD1/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatHighlight(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value.includes(HIGHLIGHT_START) ||
    !value.includes(HIGHLIGHT_END)
  ) {
    return null;
  }
  const formatted = escapeHtml(value)
    .replace(HIGHLIGHT_PAIR_PATTERN, '<mark>$1</mark>')
    .replaceAll(HIGHLIGHT_START, '')
    .replaceAll(HIGHLIGHT_END, '');
  return formatted.includes('<mark>') ? formatted : null;
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
    feedOpenMode: (row.feed_open_mode as string | null) ?? null,
    relevance: (row.relevance as number | null) ?? null,
    titleHighlight: formatHighlight(row.title_highlight),
    authorHighlight: formatHighlight(row.author_highlight),
    summaryHighlight: formatHighlight(row.summary_highlight),
    contentHighlight: formatHighlight(row.content_highlight),
    feedTitleHighlight: formatHighlight(row.feed_title_highlight),
    categoryHighlight: formatHighlight(row.category_highlight),
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
  const parts = buildQueryParts(parsed);
  if (
    options.sort !== undefined &&
    options.sort !== 'recent' &&
    options.sort !== 'relevance'
  ) {
    throw new SearchQueryError('sort must be recent or relevance');
  }
  const sort: SearchSort = parts.hasPositiveFts
    ? options.sort || 'relevance'
    : 'recent';
  const limit = limitValue(options.limit);
  const expression = dateExpression();
  const cursorParts: string[] = [];
  const cursorParams: Array<string | number> = [];

  if (options.cursor) {
    const cursor = decodeCursor(options.cursor, sort);
    if (sort === 'recent' || !parts.hasPositiveFts) {
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
  const totalRow = options.cursor
    ? null
    : (db
        .prepare(`SELECT COUNT(*) AS total ${parts.from} WHERE ${parts.where}`)
        .get(...parts.params) as { total: number });

  // Defer highlight() and snippet() evaluation until after LIMIT so FTS5 only
  // formats the paginated page rather than every matched row entering ORDER BY.
  const rows = parts.hasPositiveFts
    ? (db
        .prepare(
          `WITH matched AS (
             SELECT a.rowid AS article_rowid,
                    a.id,
                    bm25(article_search) AS relevance,
                    ${expression} AS effective_date
             ${parts.from}
             WHERE ${parts.where}${cursorWhere}
             ORDER BY ${sort === 'relevance' ? 'relevance ASC, ' : ''}effective_date DESC, a.id DESC
             LIMIT ?
           )
           SELECT ${BASE_ARTICLE_COLUMNS},
                  highlight(article_search, 1, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}') AS title_highlight,
                  highlight(article_search, 2, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}') AS author_highlight,
                  snippet(article_search, 3, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}', '…', 32) AS summary_highlight,
                  snippet(article_search, 4, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}', '…', 32) AS content_highlight,
                  highlight(article_search, 5, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}') AS feed_title_highlight,
                  highlight(article_search, 6, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}') AS category_highlight,
                  m.relevance AS relevance
           FROM matched m
           JOIN articles a ON a.rowid = m.article_rowid
           JOIN feeds f ON f.id = a.feed_id
           JOIN article_search ON article_search.rowid = m.article_rowid
           WHERE article_search MATCH ?
           ORDER BY ${sort === 'relevance' ? 'm.relevance ASC, ' : ''}m.effective_date DESC, a.id DESC`,
        )
        .all(
          ...parts.params,
          ...cursorParams,
          limit + 1,
          parsed.text,
        ) as Record<string, unknown>[])
    : (db
        .prepare(
          `WITH matched AS (
             SELECT a.rowid AS article_rowid,
                    a.id,
                    ${expression} AS effective_date
             ${parts.from}
             WHERE ${parts.where}${cursorWhere}
             ORDER BY effective_date DESC, a.id DESC
             LIMIT ?
           )
           SELECT ${BASE_ARTICLE_COLUMNS},
                  NULL AS title_highlight,
                  NULL AS author_highlight,
                  NULL AS summary_highlight,
                  NULL AS content_highlight,
                  NULL AS feed_title_highlight,
                  NULL AS category_highlight,
                  ${sort === 'relevance' ? '0.0' : 'NULL'} AS relevance
           FROM matched m
           JOIN articles a ON a.rowid = m.article_rowid
           JOIN feeds f ON f.id = a.feed_id
           ORDER BY m.effective_date DESC, a.id DESC`,
        )
        .all(...parts.params, ...cursorParams, limit + 1) as Record<
        string,
        unknown
      >[]);

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;
  const articles = resultRows.map(toSearchArticle);
  const last = resultRows.at(-1);
  const lastArticle = articles.at(-1);
  const nextCursor =
    hasMore && last && lastArticle
      ? encodeCursor({
          sort,
          rank: sort === 'relevance' ? Number(last.relevance ?? 0) : undefined,
          timestamp: Number(last.published_at ?? last.fetched_at ?? 0),
          id: String(last.id),
        })
      : null;

  return {
    query: rawQuery,
    parsed,
    sort,
    limit,
    total: totalRow ? totalRow.total : articles.length,
    articles,
    nextCursor,
  };
}
