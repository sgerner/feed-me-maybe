import { getDb } from './db';
import crypto from 'node:crypto';
import { recordAppError } from './logging';
import { decrypt, encrypt } from './ai/crypto';
import { fetchSafe, validatePublicUrl } from './network';

const ENCRYPTED_SECRET_PREFIX = 'v1:';

function logSafeWebhookTarget(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-webhook-url';
  }
}

function protectSecret(secret: string | undefined): string | null {
  if (!secret) return null;
  const { encrypted, nonce } = encrypt(secret);
  return `${ENCRYPTED_SECRET_PREFIX}${nonce}:${encrypted}`;
}

function revealSecret(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith(ENCRYPTED_SECRET_PREFIX)) return stored;
  const separator = stored.indexOf(':', ENCRYPTED_SECRET_PREFIX.length);
  if (separator < 0) return '';
  return decrypt(
    stored.slice(separator + 1),
    stored.slice(ENCRYPTED_SECRET_PREFIX.length, separator),
  );
}

const WEBHOOK_EVENTS = [
  'article.saved',
  'article.read',
  'article.thumbs_up',
  'article.ingested',
] as const;

export function isWebhookEventList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((event) => WEBHOOK_EVENTS.some((allowed) => allowed === event))
  );
}

export function parseWebhookEvents(value: string): string[] {
  try {
    const events: unknown = JSON.parse(value);
    return isWebhookEventList(events) ? events : [];
  } catch {
    return [];
  }
}

export type WebhookEvent = {
  type: (typeof WEBHOOK_EVENTS)[number];
  timestamp: number;
  payload: any;
};

export async function dispatchWebhookEvent(event: WebhookEvent) {
  const db = getDb();
  const hooks = db
    .prepare('SELECT * FROM webhooks WHERE enabled = 1')
    .all() as any[];

  for (const hook of hooks) {
    if (parseWebhookEvents(hook.events).includes(event.type)) {
      sendWebhook(hook, event).catch((err) => {
        const target = logSafeWebhookTarget(hook.url);
        console.error(`[webhook] Failed to send to ${target}:`, err);
        recordAppError({
          source: 'webhook.dispatch',
          error: err,
          details: { target, event: event.type },
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

  const secret = revealSecret(hook.secret);
  if (hook.secret && !secret) {
    throw new Error(
      'Webhook signing secret is unreadable. Restore APP_SECRET or replace the signing secret.',
    );
  }
  if (secret) {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    headers['X-Feed-Me-Maybe-Signature'] = `sha256=${signature}`;
  }

  const { response } = await fetchSafe(
    hook.url,
    {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    },
    { maxRedirects: 0 },
  );

  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}

export function getWebhooks() {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, name, url, events, enabled, created_at, updated_at,
        CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
       FROM webhooks ORDER BY created_at DESC`,
    )
    .all() as any[];
}

export function createWebhook(
  name: string,
  url: string,
  events: string[],
  secret?: string,
) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  const safeUrl = validatePublicUrl(url).href;
  db.prepare(
    'INSERT INTO webhooks (id, name, url, events, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(
    id,
    name,
    safeUrl,
    JSON.stringify(events),
    protectSecret(secret),
    now,
    now,
  );
  return id;
}

export function updateWebhook(
  id: string,
  updates: {
    name?: string;
    url?: string;
    events?: string[];
    secret?: string;
    enabled?: boolean;
  },
) {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.url !== undefined) {
    sets.push('url = ?');
    params.push(validatePublicUrl(updates.url).href);
  }
  if (updates.events !== undefined) {
    sets.push('events = ?');
    params.push(JSON.stringify(updates.events));
  }
  if (updates.secret) {
    sets.push('secret = ?');
    params.push(protectSecret(updates.secret));
  }
  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }

  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  params.push(Date.now());

  params.push(id);
  db.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`).run(
    ...params,
  );
}

export function deleteWebhook(id: string) {
  const db = getDb();
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
}
