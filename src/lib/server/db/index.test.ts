import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'fs';
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
    // Verify sessions table exists
    const sessionsResult = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get();
    expect(sessionsResult).toBeDefined();
    expect((sessionsResult as { name: string }).name).toBe('sessions');

    // Verify app_settings table exists
    const settingsResult = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'"
    ).get();
    expect(settingsResult).toBeDefined();
    expect((settingsResult as { name: string }).name).toBe('app_settings');
  });

  it('should store and retrieve app settings', async () => {
    const { getDb } = await import('./index');
    const db = getDb();

    // Insert a setting
    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run('test_key', 'test_value', Date.now());

    // Read it back
    const row = db.prepare(
      "SELECT value FROM app_settings WHERE key = ?"
    ).get('test_key') as { value: string };

    expect(row).toBeDefined();
    expect(row.value).toBe('test_value');
  });
});