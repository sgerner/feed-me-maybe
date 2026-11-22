import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createTestDb,
  insertTestArticle,
  insertTestFeed,
  type TestDbHandle,
} from '#lib/server/db/test-db.ts';

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

describe('article enrichment', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-ai-processor-');
  });

  beforeEach(() => {
    testDb.reset();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('commits score refresh intent even when all ranking jobs are occupied', async () => {
    const { processArticle } = await import('./processor');
    const db = testDb.db;
    const now = Date.now();

    insertTestFeed(db, { id: 'feed', url: 'https://example.com/feed', now });
    insertTestArticle(db, {
      id: 'story',
      feedId: 'feed',
      url: 'https://example.com/story',
      title: 'Story',
      content: 'Now has full text',
      jevScore: 0.6,
      now,
    });
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
    const { getConfiguredAiClient, isAiProcessingConfigured } =
      await import('./runtime');
    const { processArticle } = await import('./processor');
    const db = testDb.db;
    const now = Date.now();

    insertTestFeed(db, { id: 'feed-a', url: 'https://example.com/a', now });
    insertTestFeed(db, { id: 'feed-b', url: 'https://example.com/b', now });
    insertTestArticle(db, {
      id: 'orig',
      feedId: 'feed-a',
      url: 'https://shared.example/story',
      title: 'Story',
      content: 'Full body text',
      now,
    });
    insertTestArticle(db, {
      id: 'copy',
      feedId: 'feed-b',
      url: 'https://shared.example/story',
      title: 'Story copy',
      content: 'Full body text',
      now,
    });
    insertTestArticle(db, {
      id: 'hidden-item',
      feedId: 'feed-a',
      url: 'https://hidden.example/story',
      title: 'Hidden',
      content: 'Full body text',
      hidden: true,
      now,
    });
    insertTestArticle(db, {
      id: 'paused-item',
      feedId: 'feed-a',
      url: 'https://paused.example/story',
      title: 'Paused',
      content: 'Full body text',
      now,
    });
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
    const { getConfiguredAiClient } = await import('./runtime');
    const { processArticle } = await import('./processor');
    const db = testDb.db;
    const now = Date.now();

    vi.mocked(getConfiguredAiClient).mockResolvedValue({
      analyzeArticle: async () => ({
        summary: 'Obituary coverage',
        topics: ['obituary'],
        contentType: 'obituary',
        relevanceScore: 0.1,
      }),
    } as never);

    insertTestFeed(db, {
      id: 'feed-guard',
      url: 'https://example.com/guard',
      now,
    });
    insertTestArticle(db, {
      id: 'restored-item',
      feedId: 'feed-guard',
      url: 'https://example.com/r',
      title: 'Restored',
      content: 'Obituary body text',
      stateVersion: 2,
      now,
    });
    insertTestArticle(db, {
      id: 'liked-item',
      feedId: 'feed-guard',
      url: 'https://example.com/l',
      title: 'Liked',
      content: 'Obituary body text',
      thumbsUp: true,
      stateVersion: 1,
      now,
    });
    insertTestArticle(db, {
      id: 'fresh-item',
      feedId: 'feed-guard',
      url: 'https://example.com/f',
      title: 'Fresh',
      content: 'Obituary body text',
      now,
    });
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
    const { getConfiguredAiClient } = await import('./runtime');
    const { processArticle } = await import('./processor');
    const db = testDb.db;
    const now = Date.now();

    insertTestFeed(db, {
      id: 'feed-paused',
      url: 'https://example.com/paused',
      enabled: false,
      now,
    });
    insertTestFeed(db, {
      id: 'feed-active',
      url: 'https://example.com/active',
      enabled: true,
      now,
    });
    insertTestArticle(db, {
      id: 'paused-feed-art',
      feedId: 'feed-paused',
      url: 'https://example.com/pf',
      title: 'Paused Feed Story',
      content: 'Readable body text',
      now,
    });
    insertTestArticle(db, {
      id: 'cleared-art',
      feedId: 'feed-active',
      url: 'https://example.com/cl',
      title: 'Cleared Story',
      content: 'Readable body text',
      clearedAt: now,
      now,
    });
    insertTestArticle(db, {
      id: 'cleared-midflight',
      feedId: 'feed-active',
      url: 'https://example.com/cm',
      title: 'Cleared Midflight',
      content: 'Readable body text',
      now,
    });

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
