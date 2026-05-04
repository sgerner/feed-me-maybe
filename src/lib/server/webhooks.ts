import { getDb } from './db';
import crypto from 'node:crypto';
import { recordAppError } from './logging';

export type WebhookEvent = {
  type: 'article.saved' | 'article.read' | 'article.thumbs_up' | 'article.ingested';
  timestamp: number;
  payload: any;
};

export async function dispatchWebhookEvent(event: WebhookEvent) {
  const db = getDb();
  const hooks = db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all() as any[];

  for (const hook of hooks) {
    const events = JSON.parse(hook.events);
      if (events.includes(event.type)) {
        // Dispatch asynchronously
        sendWebhook(hook, event).catch((err) => {
          console.error(`[webhook] Failed to send to ${hook.url}:`, err);
          recordAppError({
            source: 'webhook.dispatch',
            error: err,
            details: { url: hook.url, event: event.type },
          });
        });
      }
  }
}

async function sendWebhook(hook: any, event: WebhookEvent) {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'feed-me-maybe-webhook/1.0',
    'X-Feed-Me-Maybe-Event': event.type,
    'X-Feed-Me-Maybe-Delivery': crypto.randomUUID(),
  };

  if (hook.secret) {
    const signature = crypto
      .createHmac('sha256', hook.secret)
      .update(body)
      .digest('hex');
    headers['X-Feed-Me-Maybe-Signature'] = `sha256=${signature}`;
  }

  const response = await fetch(hook.url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}

export function getWebhooks() {
  const db = getDb();
  return db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as any[];
}

export function createWebhook(name: string, url: string, events: string[], secret?: string) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO webhooks (id, name, url, events, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(id, name, url, JSON.stringify(events), secret || null, now, now);
  return id;
}

export function updateWebhook(id: string, updates: { name?: string; url?: string; events?: string[]; secret?: string; enabled?: boolean }) {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];
  
  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.url !== undefined) {
    sets.push('url = ?');
    params.push(updates.url);
  }
  if (updates.events !== undefined) {
    sets.push('events = ?');
    params.push(JSON.stringify(updates.events));
  }
  if (updates.secret !== undefined) {
    sets.push('secret = ?');
    params.push(updates.secret || null);
  }
  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }
  
  if (sets.length === 0) return;
  
  sets.push('updated_at = ?');
  params.push(Date.now());
  
  params.push(id);
  db.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteWebhook(id: string) {
  const db = getDb();
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
}
