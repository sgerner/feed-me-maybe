import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DELETE, PATCH, POST } from './+server';

type Handler = typeof POST | typeof PATCH | typeof DELETE;

describe('webhooks API request bodies', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-webhooks-api.db');
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
    sessionId: string | null = 'test-session',
  ) {
    return handler({
      request: new Request('http://localhost/api/webhooks', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      locals: { sessionId: sessionId ?? undefined },
    } as Parameters<Handler>[0]);
  }

  const handlers: Array<[string, Handler]> = [
    ['POST', POST],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ];

  const validWebhook = {
    name: 'Reader hook',
    url: 'https://example.com/hook',
    events: ['article.saved'],
  };

  async function webhookCount() {
    const { getDb } = await import('#lib/server/db/index.ts');
    return (
      getDb().prepare('SELECT COUNT(*) AS count FROM webhooks').get() as {
        count: number;
      }
    ).count;
  }

  describe.each(handlers)('%s', (method, handler) => {
    it.each([
      ['malformed JSON', 'not json'],
      ['an empty body', ''],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"text"'],
      ['a JSON number', '123'],
    ])('rejects %s with 400 instead of failing', async (_label, body) => {
      const response = await send(handler, method, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid body' });
    });

    it('still requires a session before reading the body', async () => {
      const response = await send(handler, method, 'not json', null);

      expect(response.status).toBe(401);
    });
  });

  describe.each([
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ] as Array<[string, Handler]>)('%s id', (method, handler) => {
    it.each([
      ['missing', {}],
      ['empty', { id: '' }],
      ['a number', { id: 1 }],
      ['an object', { id: {} }],
    ])('rejects an id that is %s', async (_label, body) => {
      const response = await send(handler, method, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'id is required' });
    });
  });

  it('rejects field values of the wrong type instead of reaching the database', async () => {
    const wrongTypes: Array<[Handler, string, unknown, string]> = [
      [POST, 'POST', { ...validWebhook, name: {} }, 'name'],
      [POST, 'POST', { ...validWebhook, url: 5 }, 'url'],
      [POST, 'POST', { ...validWebhook, secret: {} }, 'secret'],
      [POST, 'POST', { ...validWebhook, secret: 5 }, 'secret'],
      [PATCH, 'PATCH', { id: 'x', name: {} }, 'name'],
    ];

    for (const [handler, method, body, field] of wrongTypes) {
      const response = await send(handler, method, JSON.stringify(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).field).toBe(field);
    }
    expect(await webhookCount()).toBe(0);
  });

  it('accepts a null secret as no secret, as before', async () => {
    const response = await send(
      POST,
      'POST',
      JSON.stringify({ ...validWebhook, secret: null }),
    );

    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(typeof id).toBe('string');
    await send(DELETE, 'DELETE', JSON.stringify({ id }));
  });

  it('still creates, updates and deletes a webhook with valid bodies', async () => {
    const created = await send(POST, 'POST', JSON.stringify(validWebhook));
    expect(created.status).toBe(200);
    const { id } = await created.json();
    expect(await webhookCount()).toBe(1);

    const updated = await send(
      PATCH,
      'PATCH',
      JSON.stringify({ id, name: 'Renamed', enabled: false }),
    );
    expect(updated.status).toBe(200);
    const { getDb } = await import('#lib/server/db/index.ts');
    expect(
      getDb()
        .prepare('SELECT name, enabled FROM webhooks WHERE id = ?')
        .get(id),
    ).toEqual({ name: 'Renamed', enabled: 0 });

    const deleted = await send(DELETE, 'DELETE', JSON.stringify({ id }));
    expect(deleted.status).toBe(200);
    expect(await webhookCount()).toBe(0);
  });
});
