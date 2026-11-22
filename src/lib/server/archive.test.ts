import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractWithCssSelector,
  fetchArchivedArticle,
  fetchPublisherArticle,
  isCloudflareChallenge,
  isGarbageContent,
  isJinaErrorPayload,
  validateCssSelector,
} from './archive';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi
      .fn()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
}));

describe('archive fetching safety and challenge detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not send private article URLs to archive services', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchArchivedArticle(
      'http://169.254.169.254/latest/meta-data',
      'metadata',
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects Cloudflare challenge pages in fetchPublisherArticle', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        '<html><head><title>Just a moment...</title></head><body><article><p>Verify you are a human by completing the action below. Ray ID: 123456</p></article></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPublisherArticle('https://93.184.216.34/story');
    expect(result).toBeNull();
  });

  it('preserves https:// when building r.jina.ai URLs and rejects Jina Warning error payloads', async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.startsWith('https://r.jina.ai/')) {
        return new Response(
          'Title: Access Denied\nURL Source: https://93.184.216.34/story\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\nAccess denied',
          {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          },
        );
      }
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchArchivedArticle(
      'https://93.184.216.34/story',
      'Story Title',
    );

    expect(result).toBeNull();
    expect(requestedUrls).toContain(
      'https://r.jina.ai/https://93.184.216.34/story',
    );
    expect(requestedUrls).not.toContain(
      'https://r.jina.ai/http://93.184.216.34/story',
    );
  });

  it('detects challenge and error wrappers accurately', () => {
    expect(
      isCloudflareChallenge(
        '<html><body>Just a moment... Enable JavaScript and cookies to continue</body></html>',
      ),
    ).toBe(true);
    expect(
      isJinaErrorPayload(
        'Title: Story\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\nBlocked',
      ),
    ).toBe(true);
    expect(
      isGarbageContent(
        '<p>Target URL returned error 404: Page not found on this server</p>',
      ),
    ).toBe(true);
  });

  it('validates CSS selector syntax accurately', () => {
    expect(validateCssSelector('  ')).toEqual({ valid: true, normalized: '' });
    expect(
      validateCssSelector(
        '  article  .post-body ,  [itemprop="articleBody"] > p:not(.ad) ',
      ),
    ).toEqual({
      valid: true,
      normalized: 'article .post-body , [itemprop="articleBody"] > p:not(.ad)',
    });
    expect(validateCssSelector('article:has(> .lead)')).toEqual({
      valid: true,
      normalized: 'article:has(> .lead)',
    });

    for (const invalid of [
      'div[',
      'div >',
      '> p',
      'div,,p',
      ',div',
      'div,',
      '.123',
      '#123',
      'a[href=]',
      'div:not()',
      'div:nth-child(abc)',
      'div$foo',
      'body { color: red }',
    ]) {
      expect(validateCssSelector(invalid).valid).toBe(false);
    }
  });

  it('evaluates CSS selector rules before Readability and falls back to Readability when selector misses', async () => {
    const nonStandardHtml = `<!doctype html>
      <html>
        <head><title>Custom Layout Post</title></head>
        <body>
          <article>
            <h1>Custom Layout Post</h1>
            <p>Readability default paragraph one containing substantial article prose so Readability recognizes the main article container when custom selectors miss.</p>
            <p>Readability default paragraph two continuing the main narrative with enough sentences, punctuation, and structure to outscore auxiliary custom containers.</p>
            <p>Readability default paragraph three concluding the primary article section with additional editorial detail for fallback verification.</p>
          </article>
          <aside class="custom-story-shell" data-story="1">
            <div class="custom-story-body">
              <p>Custom CSS selector extracted paragraph one with detailed technical explanation.</p>
              <p><a href="/docs/guide">Relative guide link</a> and second paragraph from custom container.</p>
            </div>
          </aside>
        </body>
      </html>`;

    // Deduplicates overlapping nested matches when both outer and inner match
    const direct = extractWithCssSelector(
      nonStandardHtml,
      'https://93.184.216.34/posts/1',
      '.custom-story-shell, .custom-story-body',
    );
    expect(direct?.content).toContain(
      'Custom CSS selector extracted paragraph one',
    );
    expect(direct?.content).toContain('https://93.184.216.34/docs/guide');
    expect(
      direct?.content.match(/Custom CSS selector extracted paragraph one/g),
    ).toHaveLength(1);

    const fetchMock = vi.fn(
      async () =>
        new Response(nonStandardHtml, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const withMatchingSelector = await fetchPublisherArticle(
      'https://93.184.216.34/posts/1',
      undefined,
      '.custom-story-body',
    );
    expect(withMatchingSelector?.content).toContain(
      'Custom CSS selector extracted paragraph one',
    );
    expect(withMatchingSelector?.content).not.toContain(
      'Readability default paragraph',
    );

    // Falls back to Readability without refetching when CSS selector misses
    const withMissingSelector = await fetchPublisherArticle(
      'https://93.184.216.34/posts/1',
      undefined,
      '.non-existent-container',
    );
    expect(withMissingSelector?.content).toContain(
      'Readability default paragraph',
    );

    // Blocks SSRF private publisher URLs even when CSS selector is configured
    fetchMock.mockClear();
    const ssrfBlocked = await fetchPublisherArticle(
      'http://127.0.0.1:8080/internal',
      undefined,
      '.custom-story-body',
    );
    expect(ssrfBlocked).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
