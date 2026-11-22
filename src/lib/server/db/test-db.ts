import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { closeDb, getDb } from './index';
import { initializeDatabase } from './migrate';

export type TestDbHandle = {
  db: Database.Database;
  dbPath: string;
  dir: string;
  reset: () => void;
  cleanup: () => void;
};

export function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // Ignore missing or already-removed SQLite files.
    }
  }
}

/**
 * Creates an isolated temporary SQLite database, points `DATABASE_URL` at it,
 * initializes the schema/migrations, and provides reset + full cleanup helpers.
 */
export function createTestDb(prefix = 'feed-me-maybe-test-'): TestDbHandle {
  const originalDbUrl = process.env.DATABASE_URL;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'test.db');

  closeDb();
  process.env.DATABASE_URL = dbPath;
  initializeDatabase();
  const db = getDb();

  return {
    db,
    dbPath,
    dir,
    reset() {
      db.exec(`
        DELETE FROM ranking_refresh_queue;
        DELETE FROM article_state_history;
        DELETE FROM article_ai_metadata;
        DELETE FROM user_interactions;
        DELETE FROM feed_fetch_logs;
        DELETE FROM jobs;
        DELETE FROM articles;
        DELETE FROM feeds;
        DELETE FROM saved_searches;
        DELETE FROM user_preference_memory;
        DELETE FROM user_preference_memory_archive;
        DELETE FROM provider_configs;
        DELETE FROM webhooks;
        DELETE FROM app_error_logs;
        DELETE FROM sessions;
      `);
    },
    cleanup() {
      closeDb();
      if (originalDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDbUrl;
      }
      removeDbFiles(dbPath);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type InsertTestFeedOptions = {
  id?: string;
  url?: string;
  title?: string | null;
  category?: string;
  enabled?: boolean | number;
  useProxy?: boolean | number;
  pollIntervalMins?: number;
  openMode?: string | null;
  sourceType?: string;
  etag?: string | null;
  lastModifiedHeader?: string | null;
  errorCount?: number;
  now?: number;
};

export function insertTestFeed(
  db: Database.Database,
  options: InsertTestFeedOptions = {},
): string {
  const now = options.now ?? Date.now();
  const id = options.id ?? `feed-${crypto.randomUUID()}`;
  const url = options.url ?? `https://example.com/${id}.xml`;
  db.prepare(
    `INSERT INTO feeds (
      id, url, title, category, enabled, use_proxy, poll_interval_mins,
      open_mode, source_type, etag, last_modified_header, error_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    url,
    options.title ?? '',
    options.category ?? '',
    options.enabled === undefined ? 1 : Number(Boolean(options.enabled)),
    options.useProxy ? 1 : 0,
    options.pollIntervalMins ?? 15,
    options.openMode ?? null,
    options.sourceType ?? 'rss',
    options.etag ?? null,
    options.lastModifiedHeader ?? null,
    options.errorCount ?? 0,
    now,
    now,
  );
  return id;
}

export type InsertTestArticleOptions = {
  id?: string;
  feedId: string;
  guid?: string;
  url?: string;
  title?: string;
  author?: string;
  summary?: string;
  content?: string;
  imageUrl?: string;
  externalUrl?: string;
  categories?: string;
  publishedAt?: number | null;
  fetchedAt?: number;
  read?: boolean | number;
  saved?: boolean | number;
  hidden?: boolean | number;
  clearedAt?: number | null;
  thumbsUp?: boolean | number;
  thumbsDown?: boolean | number;
  rejected?: boolean | number;
  stateVersion?: number;
  heuristicScore?: number | null;
  jevScore?: number | null;
  combinedScore?: number | null;
  now?: number;
};

export function insertTestArticle(
  db: Database.Database,
  options: InsertTestArticleOptions,
): string {
  const now = options.now ?? Date.now();
  const id = options.id ?? `article-${crypto.randomUUID()}`;
  const url = options.url ?? `https://example.com/${id}`;
  db.prepare(
    `INSERT INTO articles (
      id, feed_id, guid, url, title, author, summary, content, image_url,
      external_url, categories, published_at, fetched_at, read, saved, hidden,
      cleared_at, thumbs_up, thumbs_down, rejected, state_version,
      heuristic_score, jev_score, combined_score, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.feedId,
    options.guid ?? '',
    url,
    options.title ?? 'Test Article',
    options.author ?? '',
    options.summary ?? '',
    options.content ?? '',
    options.imageUrl ?? '',
    options.externalUrl ?? '',
    options.categories ?? '',
    options.publishedAt === undefined ? now : options.publishedAt,
    options.fetchedAt ?? now,
    options.read ? 1 : 0,
    options.saved ? 1 : 0,
    options.hidden ? 1 : 0,
    options.clearedAt ?? null,
    options.thumbsUp ? 1 : 0,
    options.thumbsDown ? 1 : 0,
    options.rejected ? 1 : 0,
    options.stateVersion ?? 0,
    options.heuristicScore === undefined ? 0 : options.heuristicScore,
    options.jevScore ?? null,
    options.combinedScore === undefined ? 0 : options.combinedScore,
    now,
    now,
  );
  return id;
}
