import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchArchivedArticle,
  fetchPublisherArticle,
  isCloudflareChallenge,
  isGarbageContent,
  isJinaErrorPayload,
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
});
