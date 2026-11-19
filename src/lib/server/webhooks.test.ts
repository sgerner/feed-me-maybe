import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  createWebhook,
  dispatchWebhookEvent,
  deleteWebhook,
  getWebhooks,
  updateWebhook,
} from './webhooks';
import { recordInteraction } from './interactions';
import { closeDb, getDb } from './db';
import { initializeDatabase } from './db/migrate';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

describe('Webhooks', () => {
  let receivedRequest: any = null;
  let fetchMock: ReturnType<typeof vi.fn>;
  const WEBHOOK_URL = 'https://1.1.1.1/webhook';
  const testDbPath = join(process.cwd(), 'data', 'test-webhooks.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    closeDb();
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    initializeDatabase();
  });

  beforeEach(() => {
    closeDb();
    receivedRequest = null;
    fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      receivedRequest = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return new Response('OK', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeDb();
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  it('should register and dispatch a webhook event', async () => {
    const hookId = createWebhook(
      'Test Hook',
      WEBHOOK_URL,
      ['article.saved'],
      'test-secret',
    );

    const event = {
      type: 'article.saved' as const,
      timestamp: Date.now(),
      payload: { article: { id: '123', title: 'Test' } },
    };

    await dispatchWebhookEvent(event);

    // Wait a bit for async dispatch
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest.url).toBe(WEBHOOK_URL);
    expect(receivedRequest.headers.get('x-feed-me-maybe-event')).toBe(
      'article.saved',
    );
    expect(
      receivedRequest.headers.get('x-feed-me-maybe-signature'),
    ).toBeDefined();
    expect(receivedRequest.body.type).toBe('article.saved');
    expect(receivedRequest.body.payload.article.title).toBe('Test');

    deleteWebhook(hookId);
  });

  it('does not expose webhook secrets through settings data', () => {
    const hookId = createWebhook(
      'Private Hook',
      WEBHOOK_URL,
      ['article.saved'],
      'test-secret',
    );
    const db = getDb();
    const stored = db
      .prepare('SELECT secret FROM webhooks WHERE id = ?')
      .get(hookId) as { secret: string };
    const publicHook = getWebhooks().find((hook) => hook.id === hookId);

    expect(stored.secret).not.toBe('test-secret');
    expect(publicHook).toMatchObject({ has_secret: 1 });
    expect(publicHook).not.toHaveProperty('secret');

    deleteWebhook(hookId);
  });

  it('does not send an unsigned event when an encrypted secret cannot be read', async () => {
    const hookId = createWebhook('Restored Hook', WEBHOOK_URL, [
      'article.saved',
    ]);
    const db = getDb();
    db.prepare('UPDATE webhooks SET secret = ? WHERE id = ?').run(
      'v1:unreadable:secret',
      hookId,
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await dispatchWebhookEvent({
        type: 'article.saved',
        timestamp: Date.now(),
        payload: { article: { id: 'test' } },
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        db
          .prepare(
            "SELECT message FROM app_error_logs WHERE source = 'webhook.dispatch'",
          )
          .pluck()
          .all(),
      ).toContain(
        'Webhook signing secret is unreadable. Restore APP_SECRET or replace the signing secret.',
      );
    } finally {
      errorLog.mockRestore();
      deleteWebhook(hookId);
    }
  });

  it('rejects private webhook destinations on create and update', () => {
    expect(() =>
      createWebhook('Local Hook', 'http://127.0.0.1:5555/webhook', [
        'article.saved',
      ]),
    ).toThrow(/private network/i);

    const hookId = createWebhook('Public Hook', WEBHOOK_URL, ['article.saved']);
    expect(() =>
      updateWebhook(hookId, { url: 'http://localhost/webhook' }),
    ).toThrow(/private network/i);
    deleteWebhook(hookId);
  });

  it('should not dispatch if event type is not subscribed', async () => {
    const hookId = createWebhook('Test Hook', WEBHOOK_URL, ['other.event']);

    const event = {
      type: 'article.saved' as const,
      timestamp: Date.now(),
      payload: { article: { id: '123' } },
    };

    await dispatchWebhookEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(receivedRequest).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    deleteWebhook(hookId);
  });

  it('should trigger webhook when article is saved via recordInteraction', async () => {
    // Seed an article
    const db = getDb();
    db.prepare(
      'INSERT OR IGNORE INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run('test-feed', 'http://test.com', 'Test Feed', Date.now(), Date.now());
    db.prepare(
      'INSERT OR IGNORE INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'test-article',
      'test-feed',
      'http://test.com/a1',
      'Test Article',
      Date.now(),
      Date.now(),
      Date.now(),
    );

    const hookId = createWebhook('Integration Hook', WEBHOOK_URL, [
      'article.saved',
    ]);

    recordInteraction('test-article', 'save');

    // Wait a bit for async dispatch
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest.headers.get('x-feed-me-maybe-event')).toBe(
      'article.saved',
    );
    expect(receivedRequest.body.payload.article.id).toBe('test-article');

    deleteWebhook(hookId);
  });
});
