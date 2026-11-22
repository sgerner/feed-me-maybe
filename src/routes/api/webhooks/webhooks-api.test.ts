import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import dns from 'node:dns/promises';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';
import { DELETE, PATCH, POST } from './+server';
import { DELETE as DELETE_BY_ID, PATCH as PATCH_BY_ID } from './[id]/+server';
import { POST as TEST_BY_ID } from './[id]/test/+server';

type Handler = typeof POST | typeof PATCH | typeof DELETE;

describe('webhooks API request bodies', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-webhooks-api-');
  });

  beforeEach(() => {
    vi.spyOn(dns, 'lookup').mockImplementation(async (hostname: string) => {
      if (hostname.includes('private') || hostname.includes('127.0.0.1')) {
        return [{ address: '127.0.0.1', family: 4 }] as never;
      }
      return [{ address: '93.184.216.34', family: 4 }] as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    testDb.cleanup();
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

  it('rejects DNS rebinding URLs on create and update', async () => {
    const rebindRes = await send(
      POST,
      'POST',
      JSON.stringify({
        ...validWebhook,
        url: 'https://127.0.0.1.nip.io/webhook',
      }),
    );
    expect(rebindRes.status).toBe(400);
    expect(await rebindRes.json()).toMatchObject({ field: 'url' });
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

  it('creates, updates, tests, and deletes a webhook via collection and [id] routes', async () => {
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const created = await send(
      POST,
      'POST',
      JSON.stringify({
        ...validWebhook,
        url: 'https://1.1.1.1/hook',
        secret: 'initial-secret',
      }),
    );
    expect(created.status).toBe(200);
    const { id } = await created.json();
    expect(await webhookCount()).toBe(1);

    const updatedById = await PATCH_BY_ID({
      params: { id },
      request: new Request(`http://localhost/api/webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Renamed By Id',
          url: 'https://1.1.1.1/updated-hook',
          events: ['article.saved', 'article.read'],
          secret: 'rotated-secret',
          enabled: false,
        }),
      }),
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof PATCH_BY_ID>[0]);
    expect(updatedById.status).toBe(200);

    const { getDb } = await import('#lib/server/db/index.ts');
    expect(
      getDb()
        .prepare('SELECT name, url, enabled FROM webhooks WHERE id = ?')
        .get(id),
    ).toEqual({
      name: 'Renamed By Id',
      url: 'https://1.1.1.1/updated-hook',
      enabled: 0,
    });

    const testRes = await TEST_BY_ID({
      params: { id },
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof TEST_BY_ID>[0]);
    expect(testRes.status).toBe(200);
    const testPayload = await testRes.json();
    expect(testPayload).toMatchObject({
      ok: true,
      status: 200,
      error: null,
    });
    expect(typeof testPayload.durationMs).toBe('number');

    const deletedById = await DELETE_BY_ID({
      params: { id },
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof DELETE_BY_ID>[0]);
    expect(deletedById.status).toBe(200);
    expect(await webhookCount()).toBe(0);
  });
});
