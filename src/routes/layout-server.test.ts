import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';
import { load } from './+layout.server';

describe('+layout.server load feed counts', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-layout-load-');
  });

  beforeEach(() => {
    testDb.reset();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('returns zero total and paused counts when no feeds exist or signed out', async () => {
    const signedOut = (await load({
      locals: {},
      depends: () => undefined,
    } as unknown as Parameters<typeof load>[0])) as {
      feeds: unknown[];
      totalFeeds: number;
      pausedFeeds: number;
      feedCategories: string[];
    };
    expect(signedOut).toMatchObject({
      feeds: [],
      totalFeeds: 0,
      pausedFeeds: 0,
      feedCategories: [],
    });

    const emptySignedIn = (await load({
      locals: { sessionId: 'sess-1' },
      depends: () => undefined,
    } as unknown as Parameters<typeof load>[0])) as {
      feeds: unknown[];
      totalFeeds: number;
      pausedFeeds: number;
      feedCategories: string[];
    };
    expect(emptySignedIn).toMatchObject({
      feeds: [],
      totalFeeds: 0,
      pausedFeeds: 0,
      feedCategories: [],
    });
  });

  it('distinguishes total feeds and paused feeds and includes categories from paused feeds', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, category, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'f-active',
      'https://example.com/active.xml',
      'Active Feed',
      'Tech',
      1,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO feeds (id, url, title, category, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'f-paused',
      'https://example.com/paused.xml',
      'Paused Feed',
      'Releases',
      0,
      now,
      now,
    );

    const result = (await load({
      locals: { sessionId: 'sess-1' },
      depends: () => undefined,
    } as unknown as Parameters<typeof load>[0])) as {
      feeds: Array<{ id: string }>;
      totalFeeds: number;
      pausedFeeds: number;
      feedCategories: string[];
    };

    expect(result.feeds.map((f) => f.id)).toEqual(['f-active']);
    expect(result.totalFeeds).toBe(2);
    expect(result.pausedFeeds).toBe(1);
    expect(result.feedCategories).toEqual(['Releases', 'Tech']);
  });
});
