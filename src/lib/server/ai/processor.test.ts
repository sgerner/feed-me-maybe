import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ getDb: vi.fn() }));
vi.mock('./runtime', () => ({
  isAiProcessingConfigured: () => true,
  getConfiguredAiClient: async () => ({
    analyzeArticle: async () => ({
      summary: 'Enriched summary',
      relevanceScore: 0.8,
    }),
  }),
}));
vi.mock('./jev', () => ({ isRankingProviderConfigured: () => true }));

let db: Database.Database;
afterEach(() => db?.close());

describe('article enrichment', () => {
  it('commits score refresh intent even when all ranking jobs are occupied', async () => {
    const { getDb } = await import('$lib/server/db');
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    const { processArticle } = await import('./processor');
    db = new Database(':memory:');
    vi.mocked(getDb).mockReturnValue(db);
    initializeDatabase();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed', 'https://example.com/feed', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, content, jev_score, fetched_at, created_at, updated_at)
       VALUES ('story', 'feed', 'https://example.com/story', 'Story', 'Now has full text', 0.6, ?, ?, ?)`,
    ).run(now, now, now);
    const enqueue = db.prepare(
      "INSERT INTO jobs (id, type, status, payload, created_at) VALUES (?, 'jev_process', 'queued', '{}', ?)",
    );
    for (let index = 1; index <= 4; index += 1)
      enqueue.run(`job-${index}`, now);

    await processArticle('story');

    expect(
      db.prepare('SELECT article_id FROM ranking_refresh_queue').pluck().all(),
    ).toEqual(['story']);
    expect(
      db
        .prepare(
          "SELECT summary FROM article_ai_metadata WHERE article_id = 'story'",
        )
        .pluck()
        .get(),
    ).toBe('Enriched summary');
    expect(
      db
        .prepare("SELECT jev_score FROM articles WHERE id = 'story'")
        .pluck()
        .get(),
    ).toBeNull();
    expect(
      db
        .prepare("SELECT COUNT(*) FROM jobs WHERE type = 'jev_process'")
        .pluck()
        .get(),
    ).toBe(4);
  });
});
