import { describe, it, expect } from 'vitest';
import { parseOpml } from './opml';

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
});
