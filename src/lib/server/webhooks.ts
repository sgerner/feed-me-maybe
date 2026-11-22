import { getDb } from '#lib/server/db/index.ts';
import crypto from 'node:crypto';
import { recordAppError } from '#lib/server/logging.ts';
import { decrypt, encrypt } from '#lib/server/ai/crypto.ts';
import {
  assertPublicNetworkUrl,
  fetchSafe,
  isPrivateIpAddress,
  SafeFetchError,
  validatePublicUrl,
} from '#lib/server/network.ts';

const ENCRYPTED_SECRET_PREFIX = 'v1:';
const REBIND_WILDCARD_REGEX =
  /(?:^|\.)(\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3})\.(?:nip\.io|sslip\.io|xip\.io)$/i;

export class WebhookNotFoundError extends Error {
  constructor(id: string) {
    super(`Webhook not found: ${id}`);
    this.name = 'WebhookNotFoundError';
  }
}

function logSafeWebhookTarget(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-webhook-url';
  }
}

function protectSecret(secret: string | undefined | null): string | null {
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

export async function validatePublicUrlWithDns(
  input: string | URL,
): Promise<URL> {
  const parsed = validatePublicUrl(input);
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');

  const wildcardMatch = hostname.match(REBIND_WILDCARD_REGEX);
  if (wildcardMatch) {
    const candidateIp = wildcardMatch[1].replace(/-/g, '.');
    if (isPrivateIpAddress(candidateIp)) {
      throw new SafeFetchError(
        'Remote host resolves to a private network',
        'private_network',
      );
    }
  }
  if (/^(?:localhost)\.(?:nip\.io|sslip\.io|xip\.io)$/i.test(hostname)) {
    throw new SafeFetchError(
      'Remote host resolves to a private network',
      'private_network',
    );
  }

  return await assertPublicNetworkUrl(parsed);
}

export const WEBHOOK_EVENTS = [
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

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number] | 'webhook.test';

export type WebhookEvent = {
  type: WebhookEventType;
  timestamp: number;
  payload: any;
};

export type WebhookTestResult = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
};

function clearWebhookErrors(webhookId: string): void {
  try {
    const db = getDb();
    db.prepare(
      `DELETE FROM app_error_logs
       WHERE source IN ('webhooks', 'webhook.dispatch')
         AND json_valid(details) = 1
         AND json_extract(details, '$.webhookId') = ?`,
    ).run(webhookId);
  } catch {
    // Best-effort cleanup
  }
}

export async function dispatchWebhookEvent(event: WebhookEvent) {
  const db = getDb();
  const hooks = db
    .prepare('SELECT * FROM webhooks WHERE enabled = 1')
    .all() as any[];

  const deliveries: Promise<void>[] = [];
  for (const hook of hooks) {
    if (parseWebhookEvents(hook.events).includes(event.type)) {
      deliveries.push(
        sendWebhook(hook, event)
          .then(() => {
            clearWebhookErrors(hook.id);
          })
          .catch((err) => {
            const target = logSafeWebhookTarget(hook.url);
            console.error(`[webhook] Failed to send to ${target}:`, err);
            recordAppError({
              source: 'webhooks',
              error: err,
              details: { webhookId: hook.id, target, event: event.type },
            });
          }),
      );
    }
  }
  await Promise.all(deliveries);
}

async function sendWebhook(hook: any, event: WebhookEvent): Promise<number> {
  const safeUrl = (await validatePublicUrlWithDns(hook.url)).href;
  const payloadEvent: WebhookEvent = {
    type: event.type,
    timestamp: event.timestamp || Date.now(),
    payload: event.payload,
  };
  const body = JSON.stringify(payloadEvent);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'feed-me-maybe-webhook/1.0',
    'X-Feed-Me-Maybe-Event': payloadEvent.type,
    'X-Feed-Me-Maybe-Delivery': crypto.randomUUID(),
    'X-Feed-Me-Maybe-Timestamp': String(payloadEvent.timestamp),
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
    safeUrl,
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
    const httpError = new Error(
      `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
    ) as Error & { status?: number };
    httpError.status = response.status;
    throw httpError;
  }
  return response.status;
}

export async function testWebhook(id: string): Promise<WebhookTestResult> {
  const db = getDb();
  const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as any;
  if (!hook) {
    throw new WebhookNotFoundError(id);
  }

  const startedAt = Date.now();
  const event: WebhookEvent = {
    type: 'webhook.test',
    timestamp: startedAt,
    payload: {
      test: true,
      webhook: {
        id: hook.id,
        name: hook.name,
      },
    },
  };

  try {
    const status = await sendWebhook(hook, event);
    clearWebhookErrors(hook.id);
    return {
      ok: true,
      status,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: null,
    };
  } catch (err: any) {
    const target = logSafeWebhookTarget(hook.url);
    recordAppError({
      source: 'webhooks',
      error: err,
      details: { webhookId: hook.id, target, event: 'webhook.test' },
    });
    return {
      ok: false,
      status: typeof err?.status === 'number' ? err.status : null,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: err instanceof Error ? err.message : 'Webhook test failed',
    };
  }
}

export function getWebhooks() {
  const db = getDb();
  const hooks = db
    .prepare(
      `SELECT id, name, url, events, enabled, created_at, updated_at,
        CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
       FROM webhooks ORDER BY created_at DESC`,
    )
    .all() as any[];

  const errorRows = db
    .prepare(
      `SELECT message, details, created_at
       FROM app_error_logs
       WHERE source IN ('webhooks', 'webhook.dispatch')
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all() as Array<{ message: string; details: string; created_at: number }>;

  const latestByHookId = new Map<
    string,
    { message: string; failedAt: number; event?: string }
  >();
  const latestByTarget = new Map<
    string,
    { message: string; failedAt: number; event?: string }
  >();

  for (const row of errorRows) {
    try {
      const parsed = JSON.parse(row.details || '{}') as {
        webhookId?: string;
        target?: string;
        event?: string;
      };
      const entry = {
        message: row.message,
        failedAt: row.created_at,
        ...(typeof parsed.event === 'string' ? { event: parsed.event } : {}),
      };
      if (
        typeof parsed.webhookId === 'string' &&
        parsed.webhookId &&
        !latestByHookId.has(parsed.webhookId)
      ) {
        latestByHookId.set(parsed.webhookId, entry);
      }
      if (
        typeof parsed.target === 'string' &&
        parsed.target &&
        !latestByTarget.has(parsed.target)
      ) {
        latestByTarget.set(parsed.target, entry);
      }
    } catch {
      // Ignore malformed JSON details
    }
  }

  return hooks.map((hook) => {
    const failure =
      latestByHookId.get(hook.id) ||
      latestByTarget.get(logSafeWebhookTarget(hook.url)) ||
      null;
    return {
      ...hook,
      last_error: failure?.message ?? null,
      last_error_at: failure?.failedAt ?? null,
      last_failure: failure,
    };
  });
}

export async function createWebhook(
  name: string,
  url: string,
  events: string[],
  secret?: string,
) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  const safeUrl = (await validatePublicUrlWithDns(url)).href;
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

export async function updateWebhook(
  id: string,
  updates: {
    name?: string;
    url?: string;
    events?: string[];
    secret?: string | null;
    enabled?: boolean;
  },
) {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM webhooks WHERE id = ?')
    .get(id) as { id: string } | undefined;
  if (!existing) {
    throw new WebhookNotFoundError(id);
  }

  const sets: string[] = [];
  const params: any[] = [];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.url !== undefined) {
    sets.push('url = ?');
    params.push((await validatePublicUrlWithDns(updates.url)).href);
  }
  if (updates.events !== undefined) {
    sets.push('events = ?');
    params.push(JSON.stringify(updates.events));
  }
  if (updates.secret === null) {
    sets.push('secret = NULL');
  } else if (
    typeof updates.secret === 'string' &&
    updates.secret.trim().length > 0
  ) {
    sets.push('secret = ?');
    params.push(protectSecret(updates.secret.trim()));
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
  clearWebhookErrors(id);
}

export function deleteWebhook(id: string) {
  const db = getDb();
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  clearWebhookErrors(id);
}
