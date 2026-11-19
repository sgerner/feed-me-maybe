import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
  },
}));

describe('Feed Fetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should reject invalid URLs', async () => {
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('not-a-url');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('should reject non-http protocols', async () => {
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('ftp://example.com/rss');
    expect(result.success).toBe(false);
    expect(result.error).toContain('http');
  });

  it('discovers a relative alternate feed URL from a website', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          '<html><head><link rel="alternate" type="application/rss+xml" href="feed.xml"></head></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          '<rss version="2.0"><channel><title>Feed</title></channel></rss>',
          { headers: { 'content-type': 'application/rss+xml' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/blog/', {
      discover: true,
    });
    expect(result).toMatchObject({
      success: true,
      subscriptionUrl: 'https://example.com/blog/feed.xml',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts JSON Feed and preserves plain-text content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            title: 'A JSON feed',
            items: [{ id: 'one', url: '/story', content_text: 'A < B' }],
          }),
          { headers: { 'content-type': 'application/feed+json' } },
        ),
      ),
    );
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/feed.json');
    expect(result).toMatchObject({
      success: true,
      items: [
        { guid: 'one', url: 'https://example.com/story', content: 'A &lt; B' },
      ],
    });
  });

  it('proxies requests through a configured worker', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/rss+xml',
      }),
      text: async () =>
        '<rss version="2.0"><channel><title>Proxy Feed</title><item><title>Item 1</title><link>https://example.com/1</link></item></channel></rss>',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/rss', {
      proxyBaseUrl: 'https://proxy.example.workers.dev',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://proxy.example.workers.dev/?url=https%3A%2F%2Fexample.com%2Frss',
    );
    expect(result.success).toBe(true);
    expect(result.title).toBe('Proxy Feed');
  });

  it('keeps redirect hops behind the proxy and resolves links against the feed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/moved/feed.xml' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://publisher.example/story/feed.xml' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          '<rss version="2.0"><channel><title>Feed</title><item><title>Story</title><link>item</link></item></channel></rss>',
          { headers: { 'content-type': 'application/rss+xml' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/rss', {
      proxyBaseUrl: 'https://proxy.example.workers.dev',
    });
    const targets = fetchMock.mock.calls.map(([url]) => {
      const proxy = new URL(url);
      expect(proxy.hostname).toBe('proxy.example.workers.dev');
      return proxy.searchParams.get('url');
    });
    expect(targets).toEqual([
      'https://example.com/rss',
      'https://example.com/moved/feed.xml',
      'https://publisher.example/story/feed.xml',
    ]);
    expect(result.items[0]?.url).toBe('https://publisher.example/story/item');
  });

  it('sanitizes imported feed content before returning it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      text: async () =>
        '<rss version="2.0"><channel><title>Safe Feed</title><item><title>Item</title><link>https://example.com/1</link><description><![CDATA[<p onclick="alert(1)">Safe</p><script>alert(1)</script>]]></description><content:encoded><![CDATA[<img src="javascript:alert(1)" onerror="alert(1)"><strong>Kept</strong>]]></content:encoded></item></channel></rss>',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://1.1.1.1/rss');

    expect(result.success).toBe(true);
    expect(result.items[0]?.content).toContain('<strong>Kept</strong>');
    expect(result.items[0]?.content).not.toMatch(
      /script|onclick|onerror|javascript:/i,
    );
  });

  it('reads Atom summary metadata and skips malformed entry dates', async () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/releases/">
        <title>Releases</title><author><name>Feed author</name></author>
        <entry><id>urn:release:first</id><title>First</title>
          <link href="self" rel="self"/><link href="#first"/>
          <summary type="html">&lt;p&gt;First release&lt;/p&gt;</summary>
          <category term="alpha"/><published>yesterday-ish</published><updated>2026-01-15T08:00:00Z</updated>
        </entry>
        <entry><id>urn:release:second</id><title>Second</title>
          <link href="#second" rel="alternate"/><updated>bad</updated>
        </entry>
      </feed>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(xml, {
          headers: { 'content-type': 'application/atom+xml' },
        }),
      ),
    );
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/feed');
    expect(result.items).toMatchObject([
      {
        guid: 'urn:release:first',
        url: 'https://example.com/releases/#first',
        author: 'Feed author',
        summary: '<p>First release</p>',
        content: '<p>First release</p>',
        categories: ['alpha'],
        publishedAt: new Date('2026-01-15T08:00:00Z'),
      },
      {
        guid: 'urn:release:second',
        url: 'https://example.com/releases/#second',
        publishedAt: undefined,
      },
    ]);
  });

  it.each([
    ['latin1', 'text/plain', 'windows-1252'],
    ['utf16le', 'application/octet-stream', 'UTF-16'],
    ['utf8', 'application/rdf+xml', 'UTF-8'],
  ] as const)(
    'decodes %s feeds served as %s',
    async (encoding, mimeType, declaration) => {
      const xml = `<?xml version="1.0" encoding="${declaration}"?><rss version="2.0"><channel><title>Café</title></channel></rss>`;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(Buffer.from(xml, encoding), {
            headers: { 'content-type': mimeType },
          }),
        ),
      );
      const { fetchFeed } = await import('./fetcher');
      expect(await fetchFeed('https://example.com/feeds')).toMatchObject({
        success: true,
        title: 'Café',
      });
    },
  );

  it('forwards Retry-After even when the server returns a problem document', async () => {
    const before = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 429,
          headers: {
            'content-type': 'application/problem+json',
            'retry-after': '120',
          },
        }),
      ),
    );
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/feeds');
    expect(result.httpStatus).toBe(429);
    expect(result.retryAt).toBeGreaterThanOrEqual(before + 120_000);
  });

  it('rejects non-feed content types', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>not a feed</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://1.1.1.1/rss');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unsupported content type/i);
  });
});
