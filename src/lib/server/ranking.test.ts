import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('ranking recency boost for undated articles', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-ranking-undated.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
  });

  afterAll(async () => {
    const { closeDb } = await import('#lib/server/db/index.ts');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${testDbPath}${suffix}`))
        unlinkSync(`${testDbPath}${suffix}`);
    }
  });

  it('gives zero recency boost when published_at is null so fresh dated stories outrank undated archives', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { queryGlobalArticleRanking } = await import('./ranking');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run('feed-a', 'https://a.example/rss', 'Feed A', now, now);
    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run('feed-b', 'https://b.example/rss', 'Feed B', now, now);

    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, heuristic_score, published_at, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 50, ?, ?, ?, ?)`,
    ).run(
      'undated-archive',
      'feed-a',
      'https://a.example/archive',
      'Undated Archive',
      null,
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, heuristic_score, published_at, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 50, ?, ?, ?, ?)`,
    ).run(
      'fresh-dated',
      'feed-b',
      'https://b.example/fresh',
      'Fresh Dated',
      now - 60_000,
      now - 60_000,
      now,
      now,
    );

    const ranked = queryGlobalArticleRanking(
      db,
      'a.hidden = 0',
      [],
      10,
      0,
    ) as Array<{
      id: string;
    }>;
    expect(ranked.map((row) => row.id)).toEqual([
      'fresh-dated',
      'undated-archive',
    ]);

    const newest = queryGlobalArticleRanking(
      db,
      'a.hidden = 0',
      [],
      10,
      0,
      'newest',
    ) as Array<{ id: string }>;
    expect(newest.map((row) => row.id)).toEqual([
      'undated-archive',
      'fresh-dated',
    ]);

    const oldest = queryGlobalArticleRanking(
      db,
      'a.hidden = 0',
      [],
      10,
      0,
      'oldest',
    ) as Array<{ id: string }>;
    expect(oldest.map((row) => row.id)).toEqual([
      'fresh-dated',
      'undated-archive',
    ]);
  });
});
