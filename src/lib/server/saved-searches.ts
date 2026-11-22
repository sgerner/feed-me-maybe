import crypto from 'node:crypto';
import { getDb } from '#lib/server/db/index.ts';
import {
  countSearchMatches,
  parseSearchQuery,
  resolveSearchSort,
  SearchQueryError,
  type ParsedSearchQuery,
  type SearchMatchCounts,
  type SearchSort,
} from './search';

export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  description: string;
  sort: SearchSort;
  pinned: boolean;
  unreadCount: number;
  totalCount: number;
  createdAt: number;
  updatedAt: number;
};

export type SavedSearchInput = {
  name: string;
  query?: string;
  description?: string;
  sort?: SearchSort;
  pinned?: boolean;
};

export class SavedSearchError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SavedSearchError';
    this.status = status;
  }
}

type SavedSearchRow = {
  id: string;
  name: string;
  query: string;
  description: string | null;
  sort: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
};

function safeCountMatches(query: string): SearchMatchCounts {
  if (!query.trim()) {
    return { unreadCount: 0, totalCount: 0 };
  }
  try {
    return countSearchMatches(query);
  } catch {
    return { unreadCount: 0, totalCount: 0 };
  }
}

function coerceStoredSort(query: string, rawSort: string | null): SearchSort {
  const candidate: SearchSort | undefined =
    rawSort === 'recent' || rawSort === 'relevance' ? rawSort : undefined;
  if (!query.trim()) return 'recent';
  try {
    return resolveSearchSort(parseSearchQuery(query), candidate);
  } catch {
    return candidate ?? 'recent';
  }
}

function mapSavedSearch(row: SavedSearchRow): SavedSearch {
  const counts = safeCountMatches(row.query);
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    description: row.description || '',
    sort: coerceStoredSort(row.query, row.sort),
    pinned: Boolean(row.pinned),
    unreadCount: counts.unreadCount,
    totalCount: counts.totalCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 120) {
    throw new SavedSearchError('name must be between 1 and 120 characters');
  }
  return normalized;
}

function normalizeQuery(query: string): {
  query: string;
  parsed: ParsedSearchQuery;
} {
  if (query.length > 2000) {
    throw new SavedSearchError('query must be at most 2000 characters');
  }
  const trimmed = query.trim();
  if (!trimmed) {
    throw new SavedSearchError('Enter a search word or supported filter.');
  }
  try {
    const parsed = parseSearchQuery(trimmed);
    return { query: trimmed, parsed };
  } catch (caught) {
    if (caught instanceof SearchQueryError) {
      throw new SavedSearchError(caught.message);
    }
    throw caught;
  }
}

function normalizeDescription(description: string | undefined): string {
  const normalized = description?.trim() || '';
  if (normalized.length > 500) {
    throw new SavedSearchError('description must be at most 500 characters');
  }
  return normalized;
}

function normalizeSort(
  parsed: ParsedSearchQuery,
  sort: unknown,
  fallback?: SearchSort,
): SearchSort {
  if (sort !== undefined && sort !== 'recent' && sort !== 'relevance') {
    throw new SavedSearchError('sort must be recent or relevance');
  }
  const requested = (sort as SearchSort | undefined) ?? fallback;
  try {
    return resolveSearchSort(parsed, requested);
  } catch (caught) {
    if (caught instanceof SearchQueryError) {
      throw new SavedSearchError(caught.message);
    }
    throw caught;
  }
}

const SAVED_SEARCH_COLUMNS =
  'id, name, query, description, sort, pinned, created_at, updated_at';

export function listSavedSearches(): SavedSearch[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ${SAVED_SEARCH_COLUMNS}
       FROM saved_searches
       ORDER BY pinned DESC, lower(name) ASC, updated_at DESC`,
    )
    .all() as SavedSearchRow[];
  return rows.map(mapSavedSearch);
}

export function listPinnedSavedSearches(): SavedSearch[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ${SAVED_SEARCH_COLUMNS}
       FROM saved_searches
       WHERE pinned = 1
       ORDER BY lower(name) ASC, updated_at DESC`,
    )
    .all() as SavedSearchRow[];
  return rows.map(mapSavedSearch);
}

export function createSavedSearch(input: SavedSearchInput): SavedSearch {
  const name = normalizeName(input.name);
  const { query, parsed } = normalizeQuery(input.query || '');
  const description = normalizeDescription(input.description);
  const sort = normalizeSort(parsed, input.sort);
  const now = Date.now();
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO saved_searches
      (id, name, query, description, sort, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, query, description, sort, input.pinned ? 1 : 0, now, now);
  return mapSavedSearch(
    db
      .prepare(
        `SELECT ${SAVED_SEARCH_COLUMNS} FROM saved_searches WHERE id = ?`,
      )
      .get(id) as SavedSearchRow,
  );
}

export function updateSavedSearch(
  id: string,
  input: {
    name?: string;
    query?: string;
    description?: string;
    sort?: SearchSort;
    pinned?: boolean;
  },
): SavedSearch {
  if (!id.trim()) throw new SavedSearchError('id is required');
  const db = getDb();
  const existing = db
    .prepare(`SELECT ${SAVED_SEARCH_COLUMNS} FROM saved_searches WHERE id = ?`)
    .get(id) as SavedSearchRow | undefined;
  if (!existing) throw new SavedSearchError('Saved search not found', 404);

  const name =
    input.name === undefined ? existing.name : normalizeName(input.name);
  const { query, parsed } =
    input.query === undefined
      ? (() => {
          if (!existing.query.trim()) {
            return {
              query: existing.query,
              parsed: parseSearchQuery(''),
            };
          }
          return normalizeQuery(existing.query);
        })()
      : normalizeQuery(input.query);
  const description =
    input.description === undefined
      ? existing.description || ''
      : normalizeDescription(input.description);
  const existingSort: SearchSort =
    existing.sort === 'recent' ? 'recent' : 'relevance';
  const sort = normalizeSort(parsed, input.sort, existingSort);
  const pinned =
    input.pinned === undefined ? Boolean(existing.pinned) : input.pinned;
  const updatedAt = Date.now();
  db.prepare(
    `UPDATE saved_searches
     SET name = ?, query = ?, description = ?, sort = ?, pinned = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, query, description, sort, pinned ? 1 : 0, updatedAt, id);
  return mapSavedSearch(
    db
      .prepare(
        `SELECT ${SAVED_SEARCH_COLUMNS} FROM saved_searches WHERE id = ?`,
      )
      .get(id) as SavedSearchRow,
  );
}

export function deleteSavedSearch(id: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM saved_searches WHERE id = ?')
    .run(id);
  return result.changes > 0;
}
