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
