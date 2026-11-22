import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { getDb } from './index';
import { initializeDatabase } from './migrate';
import { createTestDb, type TestDbHandle } from './test-db';

describe('Database initialization', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-db-index-');
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('should get database instance', () => {
    const db = getDb();
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should create tables on initialization', () => {
    initializeDatabase();

    const db = getDb();
    expect(db.pragma('table_info(articles)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'external_url' }),
      ]),
    );

    // Verify sessions table exists
    const sessionsResult = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .get();
    expect(sessionsResult).toBeDefined();
    expect((sessionsResult as { name: string }).name).toBe('sessions');

    // Verify app_settings table exists
    const settingsResult = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'",
      )
      .get();
    expect(settingsResult).toBeDefined();
    expect((settingsResult as { name: string }).name).toBe('app_settings');
  });

  it('should store and retrieve app settings', async () => {
    const { getDb } = await import('./index');
    const db = getDb();

    // Insert a setting
    db.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('test_key', 'test_value', Date.now());

    // Read it back
    const row = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('test_key') as { value: string };

    expect(row).toBeDefined();
    expect(row.value).toBe('test_value');
  });

  it('preserves reader state in a live SQLite backup and reapplies migrations safely', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feed-db-backup-'));
    try {
      const { getDb } = await import('./index');
      const { initializeDatabase } = await import('./migrate');
      const db = getDb();
      const now = Date.now();
      db.prepare(
        'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run('backup-feed', 'https://example.com/rss', now, now);
      db.prepare(
        'INSERT INTO articles (id, feed_id, url, read, saved, fetched_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?)',
      ).run(
        'backup-article',
        'backup-feed',
        'https://example.com/story',
        now,
        now,
        now,
      );

      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all();
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      const articleIndexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'articles'",
        )
        .pluck()
        .all();
      expect(articleIndexes).toContain('idx_articles_feed_url_noguid');
      expect(articleIndexes).toContain('idx_articles_feed_url_lookup');
      expect(articleIndexes).not.toContain('idx_articles_feed_url');
      initializeDatabase();
      expect(
        db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .pluck()
          .all(),
      ).toEqual(versions);

      const backupPath = join(directory, 'backup.db');
      await db.backup(backupPath);
      const restored = new Database(backupPath, { readonly: true });
      try {
        expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(
          restored
            .prepare('SELECT read, saved FROM articles WHERE id = ?')
            .get('backup-article'),
        ).toEqual({
          read: 1,
          saved: 1,
        });
      } finally {
        restored.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('registers deterministic strip_html on in-memory SQLite connections', async () => {
    const { registerDbFunctions } = await import('./index');
    const memoryDb = new Database(':memory:');
    try {
      registerDbFunctions(memoryDb);
      const stripped = memoryDb
        .prepare('SELECT strip_html(?) AS plain')
        .pluck()
        .get('<p class="secret-attr">Hello &amp; <strong>world</strong></p>');
      expect(stripped).toBe('Hello & world');
    } finally {
      memoryDb.close();
    }
  });
});
