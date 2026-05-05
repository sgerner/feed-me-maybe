import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createWebhook, dispatchWebhookEvent, deleteWebhook } from './webhooks';
import { recordInteraction } from './interactions';
import { closeDb, getDb } from './db';
import { initializeDatabase } from './db/migrate';
import http from 'node:http';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

describe('Webhooks', () => {
  let server: http.Server;
  let receivedRequest: any = null;
  const PORT = 5555;
  const WEBHOOK_URL = `http://localhost:${PORT}/webhook`;
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

  beforeEach(async () => {
    closeDb();

    // Start a local mock server
    receivedRequest = null;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          receivedRequest = {
            headers: req.headers,
            body: JSON.parse(body)
          };
        } catch (e) {}
        res.writeHead(200);
        res.end('OK');
      });
    });

    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterEach(() => {
    server.close();
    closeDb();
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  it('should register and dispatch a webhook event', async () => {
    const hookId = createWebhook('Test Hook', WEBHOOK_URL, ['article.saved'], 'test-secret');
    
    const event = {
      type: 'article.saved' as const,
      timestamp: Date.now(),
      payload: { article: { id: '123', title: 'Test' } }
    };

    await dispatchWebhookEvent(event);

    // Wait a bit for async dispatch
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest.headers['x-feed-me-maybe-event']).toBe('article.saved');
    expect(receivedRequest.headers['x-feed-me-maybe-signature']).toBeDefined();
    expect(receivedRequest.body.type).toBe('article.saved');
    expect(receivedRequest.body.payload.article.title).toBe('Test');

    deleteWebhook(hookId);
  });

  it('should not dispatch if event type is not subscribed', async () => {
    const hookId = createWebhook('Test Hook', WEBHOOK_URL, ['other.event']);
    
    const event = {
      type: 'article.saved' as const,
      timestamp: Date.now(),
      payload: { article: { id: '123' } }
    };

    await dispatchWebhookEvent(event);

    await new Promise(resolve => setTimeout(resolve, 500));
    expect(receivedRequest).toBeNull();

    deleteWebhook(hookId);
  });

  it('should trigger webhook when article is saved via recordInteraction', async () => {
    // Seed an article
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run('test-feed', 'http://test.com', 'Test Feed', Date.now(), Date.now());
    db.prepare('INSERT OR IGNORE INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('test-article', 'test-feed', 'http://test.com/a1', 'Test Article', Date.now(), Date.now(), Date.now());

    const hookId = createWebhook('Integration Hook', WEBHOOK_URL, ['article.saved']);
    
    recordInteraction('test-article', 'save');

    // Wait a bit for async dispatch
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest.headers['x-feed-me-maybe-event']).toBe('article.saved');
    expect(receivedRequest.body.payload.article.id).toBe('test-article');

    deleteWebhook(hookId);
  });
});
