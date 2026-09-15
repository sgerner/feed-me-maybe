import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import { parseSearchQuery, SearchQueryError } from './search';

export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  description: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SavedSearchInput = {
  name: string;
  query?: string;
  description?: string;
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
  pinned: number;
  created_at: number;
  updated_at: number;
};

function mapSavedSearch(row: SavedSearchRow): SavedSearch {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    description: row.description || '',
    pinned: Boolean(row.pinned),
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

function normalizeQuery(query: string): string {
  if (query.length > 2000) {
    throw new SavedSearchError('query must be at most 2000 characters');
  }
  try {
    parseSearchQuery(query);
  } catch (caught) {
    if (caught instanceof SearchQueryError) {
      throw new SavedSearchError(caught.message);
    }
    throw caught;
  }
  return query.trim();
}

function normalizeDescription(description: string | undefined): string {
  const normalized = description?.trim() || '';
  if (normalized.length > 500) {
    throw new SavedSearchError('description must be at most 500 characters');
  }
  return normalized;
}

export function listSavedSearches(): SavedSearch[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, query, description, pinned, created_at, updated_at
       FROM saved_searches ORDER BY pinned DESC, lower(name) ASC, updated_at DESC`,
    )
    .all() as SavedSearchRow[];
  return rows.map(mapSavedSearch);
}

export function createSavedSearch(input: SavedSearchInput): SavedSearch {
  const name = normalizeName(input.name);
  const query = normalizeQuery(input.query || '');
  const description = normalizeDescription(input.description);
  const now = Date.now();
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO saved_searches
      (id, name, query, description, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, query, description, input.pinned ? 1 : 0, now, now);
  return mapSavedSearch(
    db
      .prepare('SELECT * FROM saved_searches WHERE id = ?')
      .get(id) as SavedSearchRow,
  );
}

export function updateSavedSearch(
  id: string,
  input: {
    name?: string;
    query?: string;
    description?: string;
    pinned?: boolean;
  },
): SavedSearch {
  if (!id.trim()) throw new SavedSearchError('id is required');
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM saved_searches WHERE id = ?')
    .get(id) as SavedSearchRow | undefined;
  if (!existing) throw new SavedSearchError('Saved search not found', 404);

  const name =
    input.name === undefined ? existing.name : normalizeName(input.name);
  const query =
    input.query === undefined ? existing.query : normalizeQuery(input.query);
  const description =
    input.description === undefined
      ? existing.description || ''
      : normalizeDescription(input.description);
  const pinned =
    input.pinned === undefined ? Boolean(existing.pinned) : input.pinned;
  const updatedAt = Date.now();
  db.prepare(
    `UPDATE saved_searches
     SET name = ?, query = ?, description = ?, pinned = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, query, description, pinned ? 1 : 0, updatedAt, id);
  return mapSavedSearch(
    db
      .prepare('SELECT * FROM saved_searches WHERE id = ?')
      .get(id) as SavedSearchRow,
  );
}

export function deleteSavedSearch(id: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM saved_searches WHERE id = ?')
    .run(id);
  return result.changes > 0;
}
