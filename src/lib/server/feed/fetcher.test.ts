import { describe, it, expect } from 'vitest';

describe('Feed Fetcher', () => {
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
});