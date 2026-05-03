// Verify Phase 2 Task 2.1: Database schema
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Database } from 'better-sqlite3';

let db: Database | null = null;
let dbPath: string;

describe('Phase 2 Task 2.1 - Database schema', () => {
  beforeAll(async () => {
    // Use a temporary file-based SQLite DB to persist between modules during this test
    const tmpDir = os.tmpdir();
    dbPath = path.join(tmpDir, 'feed-me-maybe-test.db');
    // Clean up any previous run
    if (existsSync(dbPath)) {
      rmSync(dbPath);
    }

    // Set env so migrate.ts uses this database
    (process as any).env.DATABASE_URL = dbPath;

    // Dynamically import migrate and initialize the database schema
    const migrateModule = await import('../src/lib/server/db/migrate');
    // Some bundlers cache modules; ensure fresh run by deleting cache key if present
    if (migrateModule?.initializeDatabase) {
      migrateModule.initializeDatabase();
    }

    // Now get a handle to the DB to inspect schema
    const { getDb } = await import('../src/lib/server/db/index');
    db = getDb();
  });

  afterAll(() => {
    // Cleanup: close and remove the temporary database file
    try {
      if (db) {
        db.close();
        db = null;
      }
    } catch {
      // ignore
    }
    try {
      if (dbPath && existsSync(dbPath)) {
        rmSync(dbPath);
      }
    } catch {
      // ignore
    }
  });

  test('Schema defines all 9 tables', () => {
    expect(db).not.toBeNull();
    // Query all tables in sqlite_master
    const tables = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    const expectedTables = [
      'sessions',
      'app_settings',
      'feeds',
      'articles',
      'article_ai_metadata',
      'feed_fetch_logs',
      'jobs',
      'user_interactions',
      'user_preference_memory',
    ];
    // Ensure every expected table exists
    for (const t of expectedTables) {
      expect(tables).toContain(t);
    }
  });

  test('Migrate initializes all required indexes', () => {
    expect(db).not.toBeNull();
    const indices = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: any) => r.name);
    const expectedIndices = [
      'idx_articles_feed_id',
      'idx_articles_published_at',
      'idx_articles_feed_url',
      'idx_fetch_logs_feed_id',
      'idx_fetch_logs_status',
      'idx_jobs_status',
      'idx_interactions_article',
    ];
    for (const idx of expectedIndices) {
      expect(indices).toContain(idx);
    }
  });
});
