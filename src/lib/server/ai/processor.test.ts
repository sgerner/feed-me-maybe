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

  it('does not re-auto-hide restored, thumbs-upped, or saved articles and bumps state_version on auto-hide', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    const { getConfiguredAiClient } = await import('./runtime');
    const { processArticle } = await import('./processor');
    db = new Database(':memory:');
    vi.mocked(getDb).mockReturnValue(db);
    initializeDatabase();
    const now = Date.now();

    vi.mocked(getConfiguredAiClient).mockResolvedValue({
      analyzeArticle: async () => ({
        summary: 'Obituary coverage',
        topics: ['obituary'],
        contentType: 'obituary',
        relevanceScore: 0.1,
      }),
    } as never);

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-guard', 'https://example.com/guard', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, content, hidden, saved, thumbs_up, state_version, fetched_at, created_at, updated_at)
       VALUES
         ('restored-item', 'feed-guard', 'https://example.com/r', 'Restored', 'Obituary body text', 0, 0, 0, 2, ?, ?, ?),
         ('liked-item', 'feed-guard', 'https://example.com/l', 'Liked', 'Obituary body text', 0, 0, 1, 1, ?, ?, ?),
         ('fresh-item', 'feed-guard', 'https://example.com/f', 'Fresh', 'Obituary body text', 0, 0, 0, 0, ?, ?, ?)`,
    ).run(now, now, now, now, now, now, now, now, now);
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('i-restore', 'restored-item', 'restore', now, '{}');
    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'neg-obit',
      'negative_filter:obituary',
      'negative_filter',
      'negative',
      1.0,
      4,
      now,
      '',
      now,
    );

    await processArticle('restored-item');
    await processArticle('liked-item');
    await processArticle('fresh-item');

    expect(
      db
        .prepare('SELECT hidden, state_version FROM articles WHERE id = ?')
        .get('restored-item'),
    ).toEqual({ hidden: 0, state_version: 2 });
    expect(
      db
        .prepare('SELECT hidden, state_version FROM articles WHERE id = ?')
        .get('liked-item'),
    ).toEqual({ hidden: 0, state_version: 1 });
    expect(
      db
        .prepare('SELECT hidden, state_version FROM articles WHERE id = ?')
        .get('fresh-item'),
    ).toEqual({ hidden: 1, state_version: 1 });
  });

  it('skips articles in paused feeds or cleared articles before calling LLM and before committing', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    const { getConfiguredAiClient } = await import('./runtime');
    const { processArticle } = await import('./processor');
    db = new Database(':memory:');
    vi.mocked(getDb).mockReturnValue(db);
    initializeDatabase();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
    ).run('feed-paused', 'https://example.com/paused', now, now);
    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run('feed-active', 'https://example.com/active', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, content, cleared_at, fetched_at, created_at, updated_at)
       VALUES
         ('paused-feed-art', 'feed-paused', 'https://example.com/pf', 'Paused Feed Story', 'Readable body text', NULL, ?, ?, ?),
         ('cleared-art', 'feed-active', 'https://example.com/cl', 'Cleared Story', 'Readable body text', ?, ?, ?, ?),
         ('cleared-midflight', 'feed-active', 'https://example.com/cm', 'Cleared Midflight', 'Readable body text', NULL, ?, ?, ?)`,
    ).run(now, now, now, now, now, now, now, now, now, now);

    const analyzeMock = vi.fn(async () => {
      db.prepare('UPDATE articles SET cleared_at = ? WHERE id = ?').run(
        now,
        'cleared-midflight',
      );
      return { summary: 'Should not commit', relevanceScore: 0.9 };
    });
    vi.mocked(getConfiguredAiClient).mockResolvedValue({
      analyzeArticle: analyzeMock,
    } as never);

    await processArticle('paused-feed-art');
    await processArticle('cleared-art');
    expect(analyzeMock).not.toHaveBeenCalled();

    await processArticle('cleared-midflight');
    expect(analyzeMock).toHaveBeenCalledOnce();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) FROM article_ai_metadata WHERE article_id = 'cleared-midflight'",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });
});
