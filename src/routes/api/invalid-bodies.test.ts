import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { POST as articleStatePost } from './articles/state/+server';
import { POST as opmlImportPost } from './opml/import/+server';
import { POST as redditCommentsPost } from './reddit/comments/+server';
import { POST as savedSearchesPost } from './saved-searches/+server';
import { PATCH as savedSearchPatch } from './saved-searches/[id]/+server';
import { POST as settingsPost } from './settings/+server';

type Handler = (event: never) => Response | Promise<Response>;

// Routes that read a JSON object body. A JSON `null` body used to throw on the
// first property access and surface as a 500.
const routes: Array<[string, string, Handler]> = [
  ['POST /api/articles/state', 'POST', articleStatePost],
  ['POST /api/opml/import', 'POST', opmlImportPost],
  ['POST /api/reddit/comments', 'POST', redditCommentsPost],
  ['POST /api/saved-searches', 'POST', savedSearchesPost],
  ['PATCH /api/saved-searches/[id]', 'PATCH', savedSearchPatch],
  ['POST /api/settings', 'POST', settingsPost],
];

describe('API routes with JSON object bodies', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-invalid-bodies-api.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
  });

  afterAll(async () => {
    const { closeDb } = await import('#lib/server/db/index.ts');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${testDbPath}${suffix}`))
        unlinkSync(`${testDbPath}${suffix}`);
    }
  });

  function send(
    handler: Handler,
    method: string,
    body: string | undefined,
    { sessionId = 'test-session', id = 'missing' } = {},
  ) {
    return handler({
      request: new Request('http://localhost/api', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      locals: { sessionId: sessionId || undefined },
      params: { id },
    } as never);
  }

  describe.each(routes)('%s', (_name, method, handler) => {
    it.each([
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"text"'],
      ['a JSON number', '123'],
      ['malformed JSON', 'not json'],
      ['an empty body', ''],
    ])('answers 400 for %s instead of failing', async (_label, body) => {
      const response = await send(handler, method, body);

      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe('string');
    });

    it('checks the session before reading the body', async () => {
      const response = await send(handler, method, 'null', { sessionId: '' });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/opml/import', () => {
    it.each([
      ['missing', {}],
      ['empty', { opml: '' }],
      ['a number', { opml: 123 }],
      ['an object', { opml: {} }],
      ['an array', { opml: ['<opml/>'] }],
      ['true', { opml: true }],
    ])('rejects opml content that is %s', async (_label, body) => {
      const response = await send(opmlImportPost, 'POST', JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'OPML content required',
      });
    });

    it('still imports valid OPML text', async () => {
      const response = await send(
        opmlImportPost,
        'POST',
        JSON.stringify({
          opml: '<opml version="2.0"><head/><body></body></opml>',
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ imported: 0, errors: [] });
    });
  });

  it('still creates and renames a saved search with valid bodies', async () => {
    const created = await send(
      savedSearchesPost,
      'POST',
      JSON.stringify({ name: 'Rust', query: 'rust' }),
    );
    expect(created.status).toBe(201);
    const { savedSearch } = await created.json();
    expect(savedSearch).toMatchObject({ name: 'Rust', query: 'rust' });

    const renamed = await send(
      savedSearchPatch,
      'PATCH',
      JSON.stringify({ name: 'Rust news' }),
      { id: savedSearch.id },
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).savedSearch.name).toBe('Rust news');
  });
});
