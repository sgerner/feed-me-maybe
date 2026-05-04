import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isRedditUrl, normalizeRedditUrl } from './reddit';

describe('Reddit Proxy Support', () => {
  const originalBaseUrl = process.env.REDDIT_BASE_URL;

  beforeEach(() => {
    process.env.REDDIT_BASE_URL = 'https://reddit-proxy.steven-619.workers.dev';
  });

  afterEach(() => {
    process.env.REDDIT_BASE_URL = originalBaseUrl;
  });

  describe('isRedditUrl with Proxy', () => {
    it('matches official Reddit hosts', () => {
      expect(isRedditUrl('https://reddit.com/r/codex')).toBe(true);
      expect(isRedditUrl('https://www.reddit.com/r/codex')).toBe(true);
    });

    it('matches the configured proxy host', () => {
      expect(isRedditUrl('https://reddit-proxy.steven-619.workers.dev/r/codex')).toBe(true);
      expect(isRedditUrl('https://reddit-proxy.steven-619.workers.dev/r/codex/new.json')).toBe(true);
    });

    it('rejects other hosts', () => {
      expect(isRedditUrl('https://example.com/r/codex')).toBe(false);
    });
  });

  describe('normalizeRedditUrl with Proxy', () => {
    it('normalizes a Reddit URL using the proxy hostname', () => {
      const r = normalizeRedditUrl('https://www.reddit.com/r/codex');
      expect(r.fetchUrl).toBe('https://reddit-proxy.steven-619.workers.dev/r/codex/new.json?limit=25');
    });

    it('normalizes a Proxy URL and preserves path', () => {
      const r = normalizeRedditUrl('https://reddit-proxy.steven-619.workers.dev/r/codex/new.json');
      expect(r.redditKind).toBe('subreddit_listing');
      expect(r.fetchUrl).toBe('https://reddit-proxy.steven-619.workers.dev/r/codex/new.json?limit=25');
    });
  });
});
