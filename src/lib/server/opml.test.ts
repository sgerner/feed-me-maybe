import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
vi.mock('./poller', () => ({ wakePoller: vi.fn() }));

import { exportOpml, parseOpml, importOpml } from './opml';
import { closeDb, getDb } from './db';
import { initializeDatabase } from './db/migrate';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const testDbPath = join(process.cwd(), 'data', 'test-opml.db');
const originalDbUrl = process.env.DATABASE_URL;

beforeAll(() => {
  closeDb();
  process.env.DATABASE_URL = testDbPath;
  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  initializeDatabase();
});

afterAll(() => {
  closeDb();
  process.env.DATABASE_URL = originalDbUrl ?? '';
  if (existsSync(testDbPath)) unlinkSync(testDbPath);
});

describe('parseOpml', () => {
  it('should parse simple OPML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
<head><title>Test</title></head>
<body>
  <outline text="Example" type="rss" xmlUrl="https://example.com/rss"/>
</body>
</opml>`;
    const result = parseOpml(xml);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Example');
    expect(result[0].xmlUrl).toBe('https://example.com/rss');
  });

  it('should handle multiple outlines', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
<body>
  <outline text="A" type="rss" xmlUrl="https://a.com/rss"/>
  <outline text="B" type="rss" xmlUrl="https://b.com/rss"/>
</body>
</opml>`;
    const result = parseOpml(xml);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('B');
  });

  it('should handle single quotes', () => {
    const xml = `<outline text='Example' type='rss' xmlUrl='https://example.com/rss'/>`;
    const result = parseOpml(xml);
    expect(result).toHaveLength(1);
    expect(result[0].xmlUrl).toBe('https://example.com/rss');
  });

  it('should handle nested outlines (categories)', () => {
    const xml = `
<outline text="News">
  <outline text="BBC" type="rss" xmlUrl="https://bbc.com/rss"/>
</outline>`;
    const result = parseOpml(xml);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('BBC');
    expect(result[0].category).toBe('News');
  });

  it('parses nested non-self-closing outlines and decodes XML entities', () => {
    const result = parseOpml(`<?xml version="1.0"?>
<opml><body><outline text="News &amp; Tech">
  <outline text="Research &quot;Daily&quot;" xmlUrl="https://feed.example/rss?a=1&amp;b=2">
    <outline text="Nested" xmlUrl="https://nested.example/rss" />
  </outline>
</outline></body></opml>`);

    expect(result).toEqual([
      {
        text: 'Research "Daily"',
        xmlUrl: 'https://feed.example/rss?a=1&b=2',
        htmlUrl: undefined,
        type: undefined,
        category: 'News & Tech',
      },
      {
        text: 'Nested',
        xmlUrl: 'https://nested.example/rss',
        htmlUrl: undefined,
        type: undefined,
        category: 'Research "Daily"',
      },
    ]);
  });

  it('should handle htmlUrl attribute', () => {
    const xml = `<outline text="BBC" type="rss" xmlUrl="https://bbc.com/rss" htmlUrl="https://bbc.com"/>`;
    const result = parseOpml(xml);
    expect(result).toHaveLength(1);
    expect(result[0].htmlUrl).toBe('https://bbc.com');
  });

  it('does not persist executable or non-HTTP htmlUrl values', () => {
    const result = importOpml(
      `<outline text="BBC" xmlUrl="https://bbc.example/rss" htmlUrl="javascript:alert(1)"/>`,
    );

    expect(result.imported).toBe(1);
    const feed = getDb()
      .prepare('SELECT site_url FROM feeds WHERE url = ?')
      .get('https://bbc.example/rss') as { site_url: string };
    expect(feed.site_url).toBe('');
  });

  it('rejects non-HTTP feed URLs in OPML', () => {
    const result = importOpml(
      `<outline text="Bad" xmlUrl="javascript:alert(1)" htmlUrl="https://safe.example"/>`,
    );

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it('round-trips escaped titles, URLs, site URLs, and categories', () => {
    const db = getDb();
    const now = Date.now();
    const sourceUrl = 'https://entities.example/rss?first=1&second=two';
    db.prepare(
      'INSERT INTO feeds (id, url, title, site_url, category, custom_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'entity-round-trip',
      sourceUrl,
      'R&D "Books" <Tech>',
      'https://entities.example/?a=1&b=2',
      'News & <Research>',
      1,
      now,
      now,
    );

    const exported = exportOpml();
    db.prepare('DELETE FROM feeds WHERE id = ?').run('entity-round-trip');
    const result = importOpml(exported);
    const imported = db
      .prepare(
        'SELECT url, title, site_url, category, custom_title, poll_interval_mins, source_type FROM feeds WHERE url = ?',
      )
      .get(sourceUrl) as Record<string, string | number | null>;

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
    expect(imported).toEqual({
      url: sourceUrl,
      title: 'R&D "Books" <Tech>',
      site_url: 'https://entities.example/?a=1&b=2',
      category: 'News & <Research>',
      custom_title: 1,
      poll_interval_mins: null,
      source_type: 'rss',
    });
    expect(
      db
        .prepare(
          "SELECT status FROM jobs WHERE type = 'feed_fetch' AND json_extract(payload, '$.feedId') = (SELECT id FROM feeds WHERE url = ?)",
        )
        .get(sourceUrl),
    ).toEqual({ status: 'queued' });
  });

  it('round-trips Reddit subscriptions as Reddit sources with a queued fetch', () => {
    const db = getDb();
    const now = Date.now();
    const originalUrl =
      'https://old.reddit.com/r/selfhosted/search?q=caprover&restrict_sr=1';
    const normalized =
      'https://www.reddit.com/r/selfhosted/search?q=caprover&restrict_sr=1';
    db.prepare(
      'INSERT INTO feeds (id, url, title, source_type, source_metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'reddit-round-trip',
      normalized,
      'Selfhosted search',
      'reddit',
      JSON.stringify({ originalUrl }),
      now,
      now,
    );

    const exported = exportOpml();
    db.prepare('DELETE FROM feeds WHERE id = ?').run('reddit-round-trip');
    const result = importOpml(exported);
    const imported = db
      .prepare(
        'SELECT url, source_type, source_metadata, poll_interval_mins FROM feeds WHERE url = ?',
      )
      .get(normalized) as {
      url: string;
      source_type: string;
      source_metadata: string;
      poll_interval_mins: number | null;
    };

    expect(result.imported).toBe(1);
    expect(imported.url).toBe(normalized);
    expect(imported.source_type).toBe('reddit');
    expect(JSON.parse(imported.source_metadata)).toMatchObject({
      originalUrl,
      redditKind: 'search',
      subreddit: 'selfhosted',
      query: 'caprover',
    });
    expect(imported.poll_interval_mins).toBeNull();
  });

  it('rejects private feed URLs and normalizes accepted feed URLs', () => {
    const privateResult = importOpml(
      '<outline text="Local" xmlUrl="http://127.0.0.1/private.xml"/>',
    );
    expect(privateResult.imported).toBe(0);
    expect(privateResult.errors).toHaveLength(1);

    const result = importOpml(
      '<outline text="Normalized" xmlUrl="HTTPS://NORMALIZE.EXAMPLE:443/feed/?b=2&amp;a=1#latest"/>',
    );
    expect(result.imported).toBe(1);
    expect(
      getDb()
        .prepare('SELECT url FROM feeds WHERE title = ?')
        .get('Normalized'),
    ).toEqual({ url: 'https://normalize.example/feed?a=1&b=2' });
  });

  it('includes disabled feeds in OPML exports', () => {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(
      'disabled-opml-feed',
      'https://disabled-opml.example/rss',
      'Paused Source',
      now,
      now,
    );

    const exported = exportOpml();
    expect(exported).toContain('https://disabled-opml.example/rss');
    expect(exported).toContain('Paused Source');
  });
});
