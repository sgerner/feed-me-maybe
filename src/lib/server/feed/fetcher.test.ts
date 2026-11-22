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

  it('discovers a JSON Feed from a headless HTML5 document', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            '<!doctype html><link REL="alternate" TYPE="application/json" HREF="feed.json">',
            { headers: { 'content-type': 'text/html' } },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            version: 'https://jsonfeed.org/version/1.1',
            title: 'Discovered feed',
            items: [],
          }),
        ),
    );
    const { fetchFeed } = await import('./fetcher');
    expect(
      await fetchFeed('https://example.com/blog/', { discover: true }),
    ).toMatchObject({
      success: true,
      subscriptionUrl: 'https://example.com/blog/feed.json',
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

  it('handles Atom prologs, XHTML/HTML title stripping, Media RSS, and rejects truncated Atom feeds', async () => {
    const truncated = `<?xml version="1.0"?>
      <?xml-stylesheet type="text/xsl" href="style.xsl"?>
      <!DOCTYPE feed>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Truncated</title>
        <entry><id>1</id><title>Partial</title><link href="https://example.com/1"/></entry>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(truncated, {
          headers: { 'content-type': 'application/atom+xml', etag: '"e1"' },
        }),
      ),
    );
    const { fetchFeed } = await import('./fetcher');
    const truncatedResult = await fetchFeed('https://example.com/atom.xml');
    expect(truncatedResult.success).toBe(false);
    expect(truncatedResult.items).toEqual([]);
    expect(truncatedResult.etag).toBeUndefined();

    const valid = `<?xml version="1.0"?>
      <?xml-stylesheet type="text/xsl" href="style.xsl"?>
      <!-- comment -->
      <!DOCTYPE feed>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:base="https://example.com/feed/">
        <title type="html">&lt;b&gt;News &amp;amp; Notes&lt;/b&gt;</title>
        <entry xml:base="posts/">
          <id>atom-1</id>
          <title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><em>XHTML</em> &amp; Title</div></title>
          <link href="post-1"/>
          <content type="html" xml:base="assets/">&lt;p&gt;&lt;img src="diagram.png"&gt;&lt;/p&gt;</content>
          <media:group>
            <media:content url="video.mp4" type="video/mp4" medium="video"/>
            <media:thumbnail url="thumb.jpg"/>
            <media:description>Media summary text</media:description>
          </media:group>
        </entry>
      </feed>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(valid, {
          headers: { 'content-type': 'application/atom+xml' },
        }),
      ),
    );
    const validResult = await fetchFeed('https://example.com/atom.xml');
    expect(validResult.success).toBe(true);
    expect(validResult.title).toBe('News & Notes');
    expect(validResult.items[0]).toMatchObject({
      guid: 'atom-1',
      url: 'https://example.com/feed/posts/post-1',
      title: 'XHTML & Title',
      summary: 'Media summary text',
      imageUrl: 'https://example.com/feed/posts/thumb.jpg',
    });
    expect(validResult.items[0]?.content).toContain(
      'src="https://example.com/feed/posts/assets/diagram.png"',
    );
  });

  it('parses RSS bare ampersands, image over audio media, empty guid objects, dc:date, and regional timezones', async () => {
    const rss = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel>
          <title>R&D Feed</title>
          <item>
            <title>Episode 1</title>
            <link>https://example.com/ep1?a=1&b=2</link>
            <guid isPermaLink="false"></guid>
            <dc:date>2026-02-01T12:00:00Z</dc:date>
            <media:content url="https://example.com/ep1.mp3" type="audio/mpeg" medium="audio"/>
            <media:thumbnail url="/thumbs/ep1.jpg"/>
            <description><![CDATA[<script>alert(1)</script><p>Hello <a href="notes">notes</a> ${'a'.repeat(520)}</p>]]></description>
          </item>
          <item>
            <title>Regional TZ</title>
            <link>https://example.com/tz</link>
            <pubDate>Mon, 02 Feb 2026 10:00:00 CET</pubDate>
          </item>
        </channel>
      </rss>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(rss, {
          headers: { 'content-type': 'application/rss+xml' },
        }),
      ),
    );
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/rss');
    expect(result.success).toBe(true);
    expect(result.title).toBe('R&D Feed');
    expect(result.items[0]).toMatchObject({
      guid: undefined,
      url: 'https://example.com/ep1?a=1&b=2',
      imageUrl: 'https://example.com/thumbs/ep1.jpg',
      publishedAt: new Date('2026-02-01T12:00:00Z'),
    });
    expect(result.items[0]?.summary).not.toContain('alert(1)');
    expect(result.items[0]?.summary?.length).toBeLessThanOrEqual(500);
    expect(result.items[1]?.guid).toBeUndefined();
    expect(result.items[1]?.publishedAt?.toISOString()).toBe(
      '2026-02-02T09:00:00.000Z',
    );
  });

  it('keeps external_url alongside url and derives summary in JSON Feed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'JSON Feed',
          items: [
            {
              id: 'jf-1',
              url: 'https://example.com/posts/1',
              external_url: 'https://upstream.example/story',
              title: 'Link Post',
              content_html: '<p>Body <a href="sub/ref">ref</a></p>',
            },
          ],
        }),
      ),
    );
    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/feed.json');
    expect(result.items[0]).toMatchObject({
      guid: 'jf-1',
      url: 'https://example.com/posts/1',
      externalUrl: 'https://upstream.example/story',
      summary:
        '<p>Body <a href="https://example.com/posts/sub/ref" target="_blank" rel="noopener noreferrer">ref</a></p>',
    });
  });

  it('discovers a valid 4th feed after 3 broken links and caps alternate link scanning at 12', async () => {
    const links = Array.from({ length: 14 }, (_, idx) => {
      const n = idx + 1;
      return `<link rel="alternate" type="application/rss+xml" title="Feed ${n}" href="/feed-${n}.xml">`;
    }).join('');
    const fetchMock = vi.fn(async (input: string | URL) => {
      const target = String(input);
      if (target === 'https://example.com/blog/') {
        return new Response(
          `<!doctype html><html><head>${links}</head></html>`,
          {
            headers: { 'content-type': 'text/html' },
          },
        );
      }
      if (target === 'https://example.com/feed-4.xml') {
        return new Response(
          '<rss version="2.0"><channel><title>Fourth Feed</title></channel></rss>',
          { headers: { 'content-type': 'application/rss+xml' } },
        );
      }
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/blog/', {
      discover: true,
    });

    expect(result.success).toBe(true);
    expect(result.subscriptionUrl).toBe('https://example.com/feed-4.xml');
    expect(result.discoveredFeeds).toHaveLength(1);
    expect(result.discoveredFeeds?.[0]).toMatchObject({
      url: 'https://example.com/feed-4.xml',
      linkTitle: 'Feed 4',
      format: 'rss',
    });
    // 1 HTML fetch + at most 12 candidate fetches (feed-13 and feed-14 skipped)
    expect(fetchMock).toHaveBeenCalledTimes(13);
    const requestedUrls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(requestedUrls).not.toContain('https://example.com/feed-13.xml');
    expect(requestedUrls).not.toContain('https://example.com/feed-14.xml');
  });

  it('preserves titles and formats across multiple valid alternate feeds and skips private SSRF links', async () => {
    const html = `<!doctype html>
      <html>
        <head>
          <link rel="alternate" type="application/rss+xml" title="Internal" href="http://127.0.0.1/private.xml">
          <link rel="alternate" type="application/rss+xml" title="Main Posts" href="/posts.xml">
          <link rel="alternate" type="application/atom+xml" title="Comments" href="/comments.atom">
          <link rel="alternate" type="application/feed+json" title="Releases JSON" href="/releases.json">
        </head>
      </html>`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const target = String(input);
      if (target === 'https://example.com/') {
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      }
      if (target === 'https://example.com/posts.xml') {
        return new Response(
          '<rss version="2.0"><channel><title>Example Blog</title></channel></rss>',
          { headers: { 'content-type': 'application/rss+xml' } },
        );
      }
      if (target === 'https://example.com/comments.atom') {
        return new Response(
          '<feed xmlns="http://www.w3.org/2005/Atom"><title>Example Comments</title></feed>',
          { headers: { 'content-type': 'application/atom+xml' } },
        );
      }
      if (target === 'https://example.com/releases.json') {
        return Response.json({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Example Releases',
          items: [],
        });
      }
      throw new Error(`Unexpected fetch to ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/', { discover: true });

    expect(result.success).toBe(true);
    expect(
      result.discoveredFeeds?.map((c) => ({
        url: c.url,
        linkTitle: c.linkTitle,
        format: c.format,
      })),
    ).toEqual([
      {
        url: 'https://example.com/posts.xml',
        linkTitle: 'Main Posts',
        format: 'rss',
      },
      {
        url: 'https://example.com/comments.atom',
        linkTitle: 'Comments',
        format: 'atom',
      },
      {
        url: 'https://example.com/releases.json',
        linkTitle: 'Releases JSON',
        format: 'json',
      },
    ]);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('127.0.0.1')),
    ).toBe(false);
  });

  it('bounds concurrent candidate validation to at most 4 parallel requests', async () => {
    const links = Array.from({ length: 9 }, (_, idx) => {
      const n = idx + 1;
      return `<link rel="alternate" type="application/rss+xml" title="Stream ${n}" href="/stream-${n}.xml">`;
    }).join('');
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchMock = vi.fn(async (input: string | URL) => {
      const target = String(input);
      if (target === 'https://example.com/hub') {
        return new Response(
          `<!doctype html><html><head>${links}</head></html>`,
          {
            headers: { 'content-type': 'text/html' },
          },
        );
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return new Response(
        `<rss version="2.0"><channel><title>${target}</title></channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchFeed } = await import('./fetcher');
    const result = await fetchFeed('https://example.com/hub', {
      discover: true,
    });

    expect(result.success).toBe(true);
    expect(result.discoveredFeeds).toHaveLength(9);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
