import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { parseOpml, importOpml } from './opml';
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
});
