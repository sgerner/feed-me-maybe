import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildProxyRequestUrl } from '$lib/proxy';
import { normalizeRedditUrl, fetchRedditSource } from './reddit';

describe('Proxy support', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a generic proxy URL for arbitrary targets', () => {
    expect(
      buildProxyRequestUrl(
        'https://proxy.example.workers.dev',
        'https://news.ycombinator.com/rss',
      ),
    ).toBe(
      'https://proxy.example.workers.dev/?url=https%3A%2F%2Fnews.ycombinator.com%2Frss',
    );
  });

  it('routes reddit fetches through the configured worker', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          data: {
            children: [
              {
                data: {
                  id: 'x1',
                  title: 'Proxy post',
                  permalink: '/r/test/comments/x1/proxy_post/',
                  author: 'a',
                  selftext: 'Body',
                  is_self: true,
                  created_utc: 1710000000,
                  subreddit: 'test',
                  preview: null,
                  thumbnail: null,
                  media_metadata: null,
                },
              },
            ],
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source, {
      proxyBaseUrl: 'https://proxy.example.workers.dev',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://proxy.example.workers.dev/?url=https%3A%2F%2Fwww.reddit.com%2Fr%2Ftest%2Fnew.json%3Flimit%3D25',
    );
    expect(result.success).toBe(true);
    expect(result.items.length).toBe(1);
  });
});
