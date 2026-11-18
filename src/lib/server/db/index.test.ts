import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { join } from 'path';
describe('Database initialization', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-feed-me-maybe.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    // Set test database path
    process.env.DATABASE_URL = testDbPath;
    // Ensure data directory exists
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test DB
    process.env.DATABASE_URL = originalDbUrl ?? '';
    try {
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('should get database instance', async () => {
    // Dynamic import to get fresh singleton with test env
    const { getDb } = await import('./index');
    const db = getDb();
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should create tables on initialization', async () => {
    const { initializeDatabase } = await import('./migrate');
    initializeDatabase();

    const { getDb } = await import('./index');
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
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
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
});
