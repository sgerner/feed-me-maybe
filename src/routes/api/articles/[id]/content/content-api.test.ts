import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';

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
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-content-api-');
  });

  beforeEach(async () => {
    testDb.reset();
    const { fetchPublisherArticle } = await import('#lib/server/archive.ts');
    vi.mocked(fetchPublisherArticle).mockReset();
  });

  afterAll(() => {
    testDb.cleanup();
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

  it('passes configured feed css_selector to fetchPublisherArticle and settles queued article_crawl jobs', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { fetchPublisherArticle } = await import('#lib/server/archive.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, fetch_full_text, css_selector, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    ).run(
      'feed-css-manual',
      'https://example.com/css-rss',
      'CSS Feed',
      'article .story-body',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, content, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'art-css-manual',
      'feed-css-manual',
      'https://example.com/css-story',
      'CSS Story',
      'Short teaser',
      '<p>Short teaser</p>',
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at)
       VALUES ('crawl-manual-1', 'article_crawl', 'queued', ?, 0, 2, ?)`,
    ).run(
      JSON.stringify({
        articleId: 'art-css-manual',
        feedId: 'feed-css-manual',
      }),
      now,
    );

    vi.mocked(fetchPublisherArticle).mockResolvedValueOnce({
      title: 'CSS Story',
      content:
        '<p>Full body extracted using configured CSS selector rule from publisher page.</p>',
      imageUrl: undefined,
    });

    const response = await POST({
      locals: { sessionId: 'sess-1' },
      params: { id: 'art-css-manual' },
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    expect(fetchPublisherArticle).toHaveBeenCalledWith(
      'https://example.com/css-story',
      undefined,
      'article .story-body',
    );
    expect(
      db.prepare("SELECT status FROM jobs WHERE id = 'crawl-manual-1'").get(),
    ).toEqual({ status: 'completed' });
  });

  it('restores stripped user-content- footnote IDs on full-text reload when plain-text length matches', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { fetchPublisherArticle } = await import('#lib/server/archive.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-fn', 'https://example.com/rss', 'Footnote Feed', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, content, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'art-footnotes',
      'feed-fn',
      'https://example.com/footnotes',
      'Footnotes Story',
      'Short summary',
      '<p>Body claim<a href="#fn1" target="_blank" rel="noopener noreferrer">1</a></p><ol><li>Footnote source details</li></ol>',
      now,
      now,
      now,
    );

    vi.mocked(fetchPublisherArticle).mockResolvedValueOnce({
      title: 'Footnotes Story',
      content:
        '<p>Body claim<a id="user-content-fnref1" href="#user-content-fn1">1</a></p><ol><li id="user-content-fn1">Footnote source details</li></ol>',
      imageUrl: undefined,
    });

    const response = await POST({
      locals: { sessionId: 'sess-1' },
      params: { id: 'art-footnotes' },
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { content?: string };
    expect(body.content).toContain('id="user-content-fn1"');
    expect(body.content).toContain('href="#user-content-fn1"');

    const stored = db
      .prepare('SELECT content FROM articles WHERE id = ?')
      .get('art-footnotes') as { content: string };
    expect(stored.content).toContain('id="user-content-fn1"');
  });

  it('does not replace equal-length article text just because the reload has more IDs', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { fetchPublisherArticle } = await import('#lib/server/archive.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'feed-equal-length',
      'https://example.com/rss',
      'Example Feed',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, content, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
    ).run(
      'art-equal-length',
      'feed-equal-length',
      'https://example.com/post',
      'Post Title',
      '<p>Original story body.</p>',
      now,
      now,
      now,
    );

    vi.mocked(fetchPublisherArticle).mockResolvedValueOnce({
      title: 'Post Title',
      content:
        '<p>Different text <span id="user-content-body">body.</span></p>',
      imageUrl: undefined,
    });

    const response = await POST({
      locals: { sessionId: 'sess-1' },
      params: { id: 'art-equal-length' },
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(422);
    const body = (await response.json()) as { alreadyFullText?: boolean };
    expect(body.alreadyFullText).toBe(true);
    expect(
      db
        .prepare('SELECT content FROM articles WHERE id = ?')
        .get('art-equal-length'),
    ).toEqual({ content: '<p>Original story body.</p>' });
  });
});
