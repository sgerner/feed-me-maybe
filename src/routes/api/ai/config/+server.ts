import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { encrypt } from '$lib/server/ai/crypto';
import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid body' }, { status: 400 });
  }

  const { providerId, modelId, config, customBaseUrl } = body as {
    providerId: unknown;
    modelId: unknown;
    config?: unknown;
    customBaseUrl?: unknown;
  };
  if (!providerId || !modelId)
    return json({ error: 'providerId and modelId required' }, { status: 400 });

  if (
    (config !== undefined &&
      (typeof config !== 'object' ||
        config === null ||
        Array.isArray(config))) ||
    (customBaseUrl !== undefined && typeof customBaseUrl !== 'string')
  ) {
    return json({ error: 'Invalid AI configuration' }, { status: 400 });
  }

  const safeConfig = Object.fromEntries(
    Object.entries((config || {}) as Record<string, unknown>)
      .filter(
        ([, value]) => typeof value === 'string' && value.trim().length > 0,
      )
      .map(([key, value]) => [key, String(value)]),
  );

  const providerIdValue = String(providerId);
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM provider_configs WHERE provider_id = ?')
    .get(providerIdValue) as { id: string } | undefined;

  let encrypted: string | undefined;
  let nonce: string | undefined;
  if (Object.keys(safeConfig).length > 0 || !existing) {
    const result = encrypt(JSON.stringify(safeConfig));
    encrypted = result.encrypted;
    nonce = result.nonce;
  }

  if (existing) {
    if (encrypted && nonce) {
      db.prepare(
        'UPDATE provider_configs SET model_id = ?, api_key_encrypted = ?, api_key_nonce = ?, custom_base_url = ?, updated_at = ? WHERE id = ?',
      ).run(
        String(modelId),
        encrypted,
        nonce,
        customBaseUrl || null,
        Date.now(),
        existing.id,
      );
    } else {
      db.prepare(
        'UPDATE provider_configs SET model_id = ?, custom_base_url = ?, updated_at = ? WHERE id = ?',
      ).run(String(modelId), customBaseUrl || null, Date.now(), existing.id);
    }
  } else {
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(
      id,
      providerIdValue,
      String(modelId),
      encrypted || '',
      nonce || '',
      customBaseUrl || null,
      Date.now(),
      Date.now(),
    );
  }

  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_enabled', 'true', ?) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = ?",
  ).run(Date.now(), Date.now());

  return json({ success: true });
};

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const configs = db
    .prepare(
      'SELECT id, provider_id, model_id, custom_base_url, enabled FROM provider_configs',
    )
    .all();

  return json({ configs });
};
