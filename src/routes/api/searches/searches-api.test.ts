import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertTestArticle,
  insertTestFeed,
  type TestDbHandle,
} from '#lib/server/db/test-db.ts';
import { DELETE, GET, PATCH, POST } from './+server';

function send(
  handler: (event: never) => Response | Promise<Response>,
  method: string,
  body?: unknown,
  sessionId: string | null = 'test-session',
): Promise<Response> {
  return Promise.resolve(
    handler({
      request: new Request('http://localhost/api/searches', {
        method,
        headers:
          body === undefined
            ? undefined
            : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      locals: { sessionId: sessionId ?? undefined },
    } as never),
  );
}

describe('/api/searches endpoints', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-searches-api-');
  });

  beforeEach(() => {
    testDb.reset();
    const db = testDb.db;
    const now = Date.now();
    insertTestFeed(db, {
      id: 'feed-tech',
      url: 'https://example.com/tech.xml',
      title: 'Tech Wire',
      category: 'tech',
      enabled: 1,
      now,
    });
    insertTestArticle(db, {
      id: 'tech-1',
      feedId: 'feed-tech',
      url: 'https://example.com/rust-1',
      title: 'Rust async improvements',
      summary: 'Unread Rust compiler update.',
      content: 'Async traits and borrow checker details.',
      read: 0,
      now,
    });
    insertTestArticle(db, {
      id: 'tech-2',
      feedId: 'feed-tech',
      url: 'https://example.com/rust-2',
      title: 'Rust web ecosystem',
      summary: 'Read story on Rust web servers and spam benchmarks.',
      content: 'Benchmarks and crate overview.',
      read: 1,
      now,
    });
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('creates saved searches with sort persistence, filter-only coercion, and live counts', async () => {
    const unauthorized = await send(GET, 'GET', undefined, null);
    expect(unauthorized.status).toBe(401);

    const createdRecent = await send(POST, 'POST', {
      name: 'Rust Latest',
      query: 'rust',
      sort: 'recent',
      pinned: true,
    });
    expect(createdRecent.status).toBe(201);
    const { search: rustRecent } = await createdRecent.json();
    expect(rustRecent).toMatchObject({
      name: 'Rust Latest',
      query: 'rust',
      sort: 'recent',
      pinned: true,
      unreadCount: 1,
      totalCount: 2,
    });

    const createdFilterOnly = await send(POST, 'POST', {
      name: 'Unread Tech',
      query: 'category:tech is:unread',
      sort: 'relevance',
      pinned: true,
    });
    expect(createdFilterOnly.status).toBe(201);
    const { search: filterSearch } = await createdFilterOnly.json();
    expect(filterSearch).toMatchObject({
      name: 'Unread Tech',
      query: 'category:tech is:unread',
      sort: 'recent',
      unreadCount: 1,
      totalCount: 1,
    });

    const listed = await send(GET, 'GET');
    expect(listed.status).toBe(200);
    const { searches } = await listed.json();
    expect(searches).toHaveLength(2);
  });

  it('validates PATCH /api/searches edits for query syntax, sort values, types, and missing IDs', async () => {
    const created = await send(POST, 'POST', {
      name: 'Rust Monitor',
      query: 'rust',
      sort: 'relevance',
      pinned: true,
    });
    const { search } = await created.json();

    // Update query, sort, name, and pin state
    const updatedRes = await send(PATCH, 'PATCH', {
      id: search.id,
      name: 'Rust Filtered',
      query: 'rust -spam',
      sort: 'recent',
      pinned: false,
    });
    expect(updatedRes.status).toBe(200);
    const { search: updated } = await updatedRes.json();
    expect(updated).toMatchObject({
      id: search.id,
      name: 'Rust Filtered',
      query: 'rust -spam',
      sort: 'recent',
      pinned: false,
      unreadCount: 1,
      totalCount: 1,
    });

    // Invalid operator syntax returns 400 and preserves previous query
    const invalidSyntax = await send(PATCH, 'PATCH', {
      id: search.id,
      query: 'rust before:not-a-date',
    });
    expect(invalidSyntax.status).toBe(400);
    expect((await invalidSyntax.json()).error).toContain('before must be');

    // Invalid sort mode returns 400
    const invalidSort = await send(PATCH, 'PATCH', {
      id: search.id,
      sort: 'alphabetical',
    });
    expect(invalidSort.status).toBe(400);
    expect((await invalidSort.json()).error).toBe(
      'sort must be recent or relevance',
    );

    // Non-boolean pinned returns 400
    const invalidPinned = await send(PATCH, 'PATCH', {
      id: search.id,
      pinned: 'true',
    });
    expect(invalidPinned.status).toBe(400);

    // Empty query returns 400
    const emptyQuery = await send(PATCH, 'PATCH', {
      id: search.id,
      query: '   ',
    });
    expect(emptyQuery.status).toBe(400);

    // Unknown ID returns 404
    const notFound = await send(PATCH, 'PATCH', {
      id: 'missing-search-id',
      name: 'Missing',
    });
    expect(notFound.status).toBe(404);

    // Verify stored search remained intact after rejected PATCH calls
    const listed = await send(GET, 'GET');
    const { searches } = await listed.json();
    expect(searches[0]).toMatchObject({
      id: search.id,
      name: 'Rust Filtered',
      query: 'rust -spam',
      sort: 'recent',
      pinned: false,
    });

    const deleted = await send(DELETE, 'DELETE', { id: search.id });
    expect(deleted.status).toBe(200);
    const deletedAgain = await send(DELETE, 'DELETE', { id: search.id });
    expect(deletedAgain.status).toBe(404);
  });
});
