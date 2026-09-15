import { describe, expect, it } from 'vitest';
import { parseDigestQuery } from '$lib/server/digest';
import { GET } from './+server';

describe('digest API query', () => {
  it('accepts configurable windows and explicit cache refresh', () => {
    const query = parseDigestQuery(
      new URL('http://localhost/api/digest?days=14&refresh=true'),
    );
    expect(query).toEqual({ windowDays: 14, forceRefresh: true });
  });

  it('defaults to a weekly cached briefing', () => {
    expect(parseDigestQuery(new URL('http://localhost/api/digest'))).toEqual({
      windowDays: 7,
      forceRefresh: false,
    });
  });

  it('rejects unsafe or ambiguous window sizes', () => {
    expect(() =>
      parseDigestQuery(new URL('http://localhost/api/digest?days=0')),
    ).toThrow(/integer from 1 to 30/);
    expect(() =>
      parseDigestQuery(new URL('http://localhost/api/digest?days=31')),
    ).toThrow(/integer from 1 to 30/);
    expect(() =>
      parseDigestQuery(new URL('http://localhost/api/digest?days=7.5')),
    ).toThrow(/integer from 1 to 30/);
  });

  it('keeps the briefing endpoint authenticated', async () => {
    const response = await GET({
      locals: { sessionId: null },
      url: new URL('http://localhost/api/digest'),
    } as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(401);
  });
});
