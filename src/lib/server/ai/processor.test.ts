import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/server/db/index.ts', () => ({ getDb: vi.fn() }));
vi.mock('./runtime', () => ({
  isAiProcessingConfigured: vi.fn(() => true),
  getConfiguredAiClient: vi.fn(async () => ({
    analyzeArticle: async () => ({
      summary: 'Enriched summary',
      relevanceScore: 0.8,
    }),
  })),
}));
vi.mock('./jev', () => ({ isRankingProviderConfigured: () => true }));

let db: Database.Database;
afterEach(() => db?.close());

describe('article enrichment', () => {
  it('commits score refresh intent even when all ranking jobs are occupied', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
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

  it('reuses canonical URL AI metadata, skips hidden items, and aborts commit when paused mid-flight', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    const { getConfiguredAiClient, isAiProcessingConfigured } =
      await import('./runtime');
    const { processArticle } = await import('./processor');
    db = new Database(':memory:');
    vi.mocked(getDb).mockReturnValue(db);
    initializeDatabase();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-a', 'https://example.com/a', now, now);
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-b', 'https://example.com/b', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, content, hidden, fetched_at, created_at, updated_at)
       VALUES
         ('orig', 'feed-a', 'https://shared.example/story', 'Story', 'Full body text', 0, ?, ?, ?),
         ('copy', 'feed-b', 'https://shared.example/story', 'Story copy', 'Full body text', 0, ?, ?, ?),
         ('hidden-item', 'feed-a', 'https://hidden.example/story', 'Hidden', 'Full body text', 1, ?, ?, ?),
         ('paused-item', 'feed-a', 'https://paused.example/story', 'Paused', 'Full body text', 0, ?, ?, ?)`,
    ).run(now, now, now, now, now, now, now, now, now, now, now, now);
    db.prepare(
      `INSERT INTO article_ai_metadata
       (id, article_id, summary, topics, entities, content_type, ai_relevance_score, novelty_score, quality_score, signals, analysis_status, processed_at, created_at)
       VALUES ('meta-orig', 'orig', 'Cached summary', '["ai"]', '[]', 'news', 0.9, 0.8, 0.8, '["primary_source"]', 'ready', ?, ?)`,
    ).run(now, now);

    const analyzeMock = vi.fn(async () => {
      vi.mocked(isAiProcessingConfigured).mockReturnValue(false);
      return { summary: 'Should not persist', relevanceScore: 0.7 };
    });
    vi.mocked(getConfiguredAiClient).mockResolvedValue({
      analyzeArticle: analyzeMock,
    } as never);

    const reused = await processArticle('copy');
    expect(reused).toEqual({ cached: true });
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT summary FROM article_ai_metadata WHERE article_id = 'copy'",
        )
        .pluck()
        .get(),
    ).toBe('Cached summary');

    await processArticle('hidden-item');
    expect(analyzeMock).not.toHaveBeenCalled();

    await processArticle('paused-item');
    expect(analyzeMock).toHaveBeenCalledOnce();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) FROM article_ai_metadata WHERE article_id = 'paused-item'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    vi.mocked(isAiProcessingConfigured).mockReturnValue(true);
  });
});
