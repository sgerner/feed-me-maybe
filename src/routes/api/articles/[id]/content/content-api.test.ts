import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('#lib/server/archive.ts', () => ({
  fetchPublisherArticle: vi.fn(),
}));
vi.mock('#lib/server/poller.ts', () => ({
  wakePoller: vi.fn(),
}));
vi.mock('#lib/server/ai/runtime.ts', () => ({
  isAiProcessingConfigured: vi.fn(() => true),
}));

import { POST } from './+server';

describe('POST /api/articles/[id]/content', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-content-api.db');
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
    db.prepare('DELETE FROM ranking_refresh_queue').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM article_ai_metadata').run();
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
    const { fetchPublisherArticle } = await import('#lib/server/archive.ts');
    vi.mocked(fetchPublisherArticle).mockReset();
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

  it('upgrades content, resets ready AI metadata to pending, refreshes ranking, and queues AI', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { fetchPublisherArticle } = await import('#lib/server/archive.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-c', 'https://example.com/rss', 'Example Feed', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, content, heuristic_score, jev_score, combined_score, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 40, 0.9, 85, ?, ?, ?)`,
    ).run(
      'art-upgrade',
      'feed-c',
      'https://example.com/post',
      'Post Title',
      'Short stub',
      '<p>Short stub</p>',
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO article_ai_metadata (id, article_id, summary, ai_relevance_score, analysis_status, processed_at, created_at)
       VALUES (?, ?, ?, 0.9, 'ready', ?, ?)`,
    ).run('meta-upgrade', 'art-upgrade', 'Old AI summary', now, now);

    vi.mocked(fetchPublisherArticle).mockResolvedValueOnce({
      title: 'Post Title',
      content:
        '<p>Full extracted article body with plenty of substantive content for analysis and ranking.</p>',
      imageUrl: 'https://example.com/hero.jpg',
    });

    const response = await POST({
      locals: { sessionId: 'sess-1' },
      params: { id: 'art-upgrade' },
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    const art = db
      .prepare(
        'SELECT content, image_url, heuristic_score, jev_score, combined_score FROM articles WHERE id = ?',
      )
      .get('art-upgrade') as {
      content: string;
      image_url: string;
      heuristic_score: number;
      jev_score: number | null;
      combined_score: number | null;
    };
    expect(art.content).toContain('Full extracted article body');
    expect(art.image_url).toBe('https://example.com/hero.jpg');
    expect(art.heuristic_score).toBe(50);
    expect(art.jev_score).toBeNull();
    expect(art.combined_score).toBeNull();

    const meta = db
      .prepare(
        'SELECT analysis_status, processed_at FROM article_ai_metadata WHERE article_id = ?',
      )
      .get('art-upgrade') as {
      analysis_status: string;
      processed_at: number | null;
    };
    expect(meta).toEqual({ analysis_status: 'pending', processed_at: null });

    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('art-upgrade'),
    ).toEqual({ article_id: 'art-upgrade' });

    expect(
      db
        .prepare(
          "SELECT status FROM jobs WHERE type = 'ai_process' AND json_extract(payload, '$.articleId') = ?",
        )
        .get('art-upgrade'),
    ).toEqual({ status: 'queued' });
  });

  it('refuses to overwrite an article when extracted content is shorter than the existing summary', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { fetchPublisherArticle } = await import('#lib/server/archive.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-s', 'https://example.com/rss', 'Example Feed', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, content, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`,
    ).run(
      'art-summary-longer',
      'feed-s',
      'https://example.com/paywalled',
      'Paywalled Story',
      'This existing feed summary contains a substantial multi-sentence overview of the story that is much longer than a paywall teaser.',
      now,
      now,
      now,
    );

    vi.mocked(fetchPublisherArticle).mockResolvedValueOnce({
      title: 'Paywalled Story',
      content: '<p>Subscribe now to read.</p>',
      imageUrl: undefined,
    });

    const response = await POST({
      locals: { sessionId: 'sess-1' },
      params: { id: 'art-summary-longer' },
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: string;
      alreadyFullText?: boolean;
    };
    expect(body.alreadyFullText).toBe(true);

    const art = db
      .prepare('SELECT content, summary FROM articles WHERE id = ?')
      .get('art-summary-longer') as { content: string; summary: string };
    expect(art.content).toBe('');
    expect(art.summary).toContain('substantial multi-sentence overview');
  });
});
