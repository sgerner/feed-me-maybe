import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFeed } from '$lib/server/feed/fetcher';
import {
  isRedditUrl,
  normalizeRedditUrl,
  extractBestRedditImage,
  parseRedditPost,
  fetchRedditSource,
} from './reddit';

vi.mock('$lib/server/feed/fetcher', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    fetchFeed: vi.fn(),
  };
});

describe('isRedditUrl', () => {
  it('matches common Reddit hosts', () => {
    expect(isRedditUrl('https://reddit.com/r/codex')).toBe(true);
    expect(isRedditUrl('https://www.reddit.com/r/codex')).toBe(true);
    expect(isRedditUrl('https://old.reddit.com/r/codex')).toBe(true);
    expect(isRedditUrl('https://new.reddit.com/r/codex')).toBe(true);
    expect(isRedditUrl('https://m.reddit.com/r/codex')).toBe(true);
  });

  it('rejects non-Reddit URLs', () => {
    expect(isRedditUrl('https://example.com/rss')).toBe(false);
    expect(isRedditUrl('https://news.ycombinator.com')).toBe(false);
    expect(
      isRedditUrl('https://reddit-proxy.steven-619.workers.dev/r/codex'),
    ).toBe(false);
    expect(isRedditUrl('not-a-url')).toBe(false);
  });
});

describe('normalizeRedditUrl', () => {
  it('normalizes subreddit default feed', () => {
    const r = normalizeRedditUrl('https://reddit.com/r/codex');
    expect(r.redditKind).toBe('subreddit');
    expect(r.fetchUrl).toBe('https://www.reddit.com/r/codex/new.rss?limit=25');
  });

  it('normalizes www subreddit with trailing slash', () => {
    const r = normalizeRedditUrl('https://www.reddit.com/r/codex/');
    expect(r.fetchUrl).toBe('https://www.reddit.com/r/codex/new.rss?limit=25');
  });

  it('normalizes subreddit listing feeds', () => {
    expect(
      normalizeRedditUrl('https://www.reddit.com/r/codex/new').fetchUrl,
    ).toBe('https://www.reddit.com/r/codex/new.rss?limit=25');
    expect(
      normalizeRedditUrl('https://www.reddit.com/r/codex/hot').fetchUrl,
    ).toBe('https://www.reddit.com/r/codex/hot.rss?limit=25');
    expect(
      normalizeRedditUrl('https://www.reddit.com/r/codex/top').fetchUrl,
    ).toBe('https://www.reddit.com/r/codex/top.rss?limit=25');
    expect(
      normalizeRedditUrl('https://www.reddit.com/r/codex/rising').fetchUrl,
    ).toBe('https://www.reddit.com/r/codex/rising.rss?limit=25');
  });

  it('preserves query params like t and limit', () => {
    const r = normalizeRedditUrl('https://old.reddit.com/r/codex/top?t=week');
    expect(r.fetchUrl).toBe(
      'https://www.reddit.com/r/codex/top.rss?t=week&limit=25',
    );
  });

  it('does not override existing limit', () => {
    const r = normalizeRedditUrl('https://www.reddit.com/r/codex.rss?limit=50');
    expect(r.fetchUrl).toBe('https://www.reddit.com/r/codex/new.rss?limit=50');
  });

  it('normalizes Reddit search', () => {
    const r = normalizeRedditUrl('https://www.reddit.com/search?q=openclaw');
    expect(r.redditKind).toBe('search');
    expect(r.fetchUrl).toBe(
      'https://www.reddit.com/search.rss?q=openclaw&limit=25',
    );
    expect(r.query).toBe('openclaw');
  });

  it('normalizes subreddit search', () => {
    const r = normalizeRedditUrl(
      'https://www.reddit.com/r/selfhosted/search?q=caprover&restrict_sr=1',
    );
    expect(r.redditKind).toBe('search');
    expect(r.fetchUrl).toBe(
      'https://www.reddit.com/r/selfhosted/search.rss?q=caprover&restrict_sr=1&limit=25',
    );
    expect(r.subreddit).toBe('selfhosted');
    expect(r.query).toBe('caprover');
  });

  it('normalizes user feeds', () => {
    expect(
      normalizeRedditUrl('https://www.reddit.com/user/spez').fetchUrl,
    ).toBe('https://www.reddit.com/user/spez.rss?limit=25');
    expect(
      normalizeRedditUrl('https://www.reddit.com/user/spez/submitted').fetchUrl,
    ).toBe('https://www.reddit.com/user/spez/submitted.rss?limit=25');
    expect(
      normalizeRedditUrl('https://www.reddit.com/user/spez/comments').fetchUrl,
    ).toBe('https://www.reddit.com/user/spez/comments.rss?limit=25');
  });

  it('normalizes comments / single post', () => {
    const r = normalizeRedditUrl(
      'https://www.reddit.com/r/codex/comments/abc123/example_post_title',
    );
    expect(r.redditKind).toBe('comments');
    expect(r.fetchUrl).toBe(
      'https://www.reddit.com/r/codex/comments/abc123/example_post_title.rss',
    );
    expect(r.subreddit).toBe('codex');
  });
});

describe('extractBestRedditImage', () => {
  it('extracts preview source image', () => {
    const post = {
      preview: {
        images: [
          {
            source: { url: 'https://example.com/img.jpg' },
            resolutions: [{ url: 'https://example.com/small.jpg' }],
          },
        ],
      },
    };
    expect(extractBestRedditImage(post)).toBe('https://example.com/img.jpg');
  });

  it('falls back to thumbnail when valid', () => {
    const post = { thumbnail: 'https://b.thumbs.redditmedia.com/x.jpg' };
    expect(extractBestRedditImage(post)).toBe(
      'https://b.thumbs.redditmedia.com/x.jpg',
    );
  });

  it('skips default thumbnails', () => {
    const post = { thumbnail: 'self' };
    expect(extractBestRedditImage(post)).toBeUndefined();
  });

  it('extracts gallery media metadata', () => {
    const post = {
      media_metadata: {
        abc: { s: { u: 'https://example.com/gallery.jpg' } },
      },
    };
    expect(extractBestRedditImage(post)).toBe(
      'https://example.com/gallery.jpg',
    );
  });
});

describe('parseRedditPost', () => {
  it('maps a self-post correctly', () => {
    const post = {
      id: 'abc123',
      title: 'Hello world',
      permalink: '/r/test/comments/abc123/hello_world/',
      author: 'alice',
      selftext: 'This is the body.',
      selftext_html: null,
      is_self: true,
      created_utc: 1710000000,
      subreddit: 'test',
      score: 42,
      num_comments: 7,
      upvote_ratio: 0.95,
      over_18: false,
      spoiler: false,
      stickied: false,
      locked: false,
      link_flair_text: 'Discussion',
      domain: 'self.test',
      preview: null,
      thumbnail: null,
      media_metadata: null,
    };

    const item = parseRedditPost(post);
    expect(item.guid).toBe('reddit_abc123');
    expect(item.url).toBe(
      'https://www.reddit.com/r/test/comments/abc123/hello_world/',
    );
    expect(item.title).toBe('Hello world');
    expect(item.author).toBe('u/alice');
    expect(item.content).toBe('This is the body.');
    expect(item.summary).toBe('This is the body.');
    expect(item.categories).toEqual(['r/test', 'Discussion']);
    expect(item.publishedAt?.toISOString()).toBe(
      new Date(1710000000 * 1000).toISOString(),
    );
  });

  it('maps a link post correctly', () => {
    const post = {
      id: 'def456',
      title: 'Cool article',
      permalink: '/r/test/comments/def456/cool_article/',
      author: 'bob',
      selftext: '',
      selftext_html: null,
      is_self: false,
      url: 'https://example.com/article',
      created_utc: 1710000000,
      subreddit: 'test',
      domain: 'example.com',
      preview: null,
      thumbnail: null,
      media_metadata: null,
    };

    const item = parseRedditPost(post);
    expect(item.guid).toBe('reddit_def456');
    expect(item.url).toBe(
      'https://www.reddit.com/r/test/comments/def456/cool_article/',
    );
    expect(item.content).toBeUndefined();
    expect(item.summary).toBe('Cool article');
  });

  it('handles missing author and dates', () => {
    const post = {
      id: 'ghi789',
      title: 'No author',
      permalink: '/r/test/comments/ghi789/no_author/',
      is_self: true,
      selftext: '',
      created_utc: null,
      subreddit: null,
      preview: null,
      thumbnail: null,
      media_metadata: null,
    };

    const item = parseRedditPost(post);
    expect(item.author).toBeUndefined();
    expect(item.publishedAt).toBeUndefined();
    expect(item.categories).toEqual([]);
  });
});

describe('fetchRedditSource', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(fetchFeed).mockResolvedValue({
      success: false,
      items: [],
      error: 'Default RSS failure for JSON tests',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success with items for a valid listing', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
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
                  title: 'Post 1',
                  permalink: '/r/test/comments/x1/post1/',
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
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(true);
    expect(result.items.length).toBe(1);
    expect(result.items[0].title).toBe('Post 1');
    expect(result.title).toBe('r/test');
  });

  it('handles comments endpoint array shape', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify([
          {
            data: {
              children: [
                {
                  data: {
                    id: 'c1',
                    title: 'Comment Post',
                    permalink: '/r/test/comments/c1/comment_post/',
                    author: 'a',
                    selftext: 'OP text',
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
          },
          {
            data: {
              children: [
                {
                  data: {
                    id: 'c2',
                    author: 'b',
                    body: 'Nice post',
                    score: 5,
                    created_utc: 1710000100,
                  },
                },
              ],
            },
          },
        ]),
    });
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl(
      'https://reddit.com/r/test/comments/c1/comment_post',
    );
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(true);
    expect(result.items.length).toBe(1);
    expect(result.items[0].summary).toContain('Top comments:');
    expect(result.items[0].summary).toContain('Nice post');
  });

  it('returns structured error on 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => '',
    });
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(429);
    expect(result.error).toContain('rate limiting');
  });

  it('tries RSS first and returns it if successful', async () => {
    vi.mocked(fetchFeed).mockResolvedValue({
      success: true,
      items: [{ title: 'RSS Post', url: 'https://reddit.com/post' } as any],
    });

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(true);
    expect(result.items[0].title).toBe('RSS Post');
    expect(fetchFeed).toHaveBeenCalledWith(
      expect.stringContaining('.rss'),
      expect.anything(),
    );
  });

  it('falls back to JSON if RSS fetch returns no items', async () => {
    vi.mocked(fetchFeed).mockResolvedValue({
      success: true,
      items: [],
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          data: {
            children: [
              {
                data: {
                  id: 'j1',
                  title: 'JSON Post',
                  permalink: '/r/test/comments/j1/p1/',
                  is_self: true,
                  subreddit: 'test',
                },
              },
            ],
          },
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(true);
    expect(result.items[0].title).toBe('JSON Post');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('.json'),
      expect.anything(),
    );
  });

  it('returns structured error on 403 if both RSS and JSON fail', async () => {
    vi.mocked(fetchFeed).mockResolvedValue({
      success: false,
      items: [],
      error: 'RSS failed',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: async () => 'Blocked',
    });
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(403);
    expect(result.error).toContain('blocked');
  });

  it('returns structured error on HTML response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html><body>Reddit</body></html>',
    });
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(false);
    expect(result.error).toContain('did not return a readable JSON feed');
  });

  it('returns structured error on malformed JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => 'not json',
    });
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(false);
    expect(result.error).toContain('did not return a readable JSON feed');
  });

  it('returns success with empty items for empty listing', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ data: { children: [] } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(true);
    expect(result.items.length).toBe(0);
  });

  it('returns structured error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const source = normalizeRedditUrl('https://reddit.com/r/test');
    const result = await fetchRedditSource(source);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});
