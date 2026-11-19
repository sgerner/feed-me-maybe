import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { encrypt } from '$lib/server/ai/crypto';
import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import { assertPublicNetworkUrl, SafeFetchError } from '$lib/server/network';
import { getModel } from '$lib/server/ai/models-dev';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid body' }, { status: 400 });
  }

  const { providerId, modelId, config, customBaseUrl, enabled } = body as {
    providerId: unknown;
    modelId: unknown;
    config?: unknown;
    customBaseUrl?: unknown;
    enabled?: unknown;
  };

  if (
    typeof enabled === 'boolean' &&
    providerId === undefined &&
    modelId === undefined
  ) {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('ai_enabled', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(String(enabled), now);
    return json({ success: true, aiEnabled: enabled });
  }

  if (typeof providerId !== 'string' || typeof modelId !== 'string')
    return json({ error: 'providerId and modelId required' }, { status: 400 });
  const providerIdValue = providerId.trim();
  const modelIdValue = modelId.trim();
  if (!providerIdValue || !modelIdValue)
    return json({ error: 'providerId and modelId required' }, { status: 400 });

  if (!(await getModel(providerIdValue, modelIdValue))) {
    return json(
      { error: 'Select a supported text chat model and provider.' },
      { status: 400 },
    );
  }

  if (
    (config !== undefined &&
      (typeof config !== 'object' ||
        config === null ||
        Array.isArray(config))) ||
    (customBaseUrl !== undefined && typeof customBaseUrl !== 'string')
  ) {
    return json({ error: 'Invalid AI configuration' }, { status: 400 });
  }

  let validatedBaseUrl: string | null = null;
  if (typeof customBaseUrl === 'string' && customBaseUrl.trim()) {
    try {
      validatedBaseUrl = (await assertPublicNetworkUrl(customBaseUrl.trim()))
        .href;
    } catch (err) {
      if (err instanceof SafeFetchError) {
        return json(
          { error: 'Custom base URL must resolve to a public HTTP(S) host' },
          { status: 400 },
        );
      }
      throw err;
    }
  }

  const safeConfig = Object.fromEntries(
    Object.entries((config || {}) as Record<string, unknown>)
      .filter(
        ([, value]) => typeof value === 'string' && value.trim().length > 0,
      )
      .map(([key, value]) => [key, String(value)]),
  );

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

  db.transaction(() => {
    if (existing) {
      if (encrypted && nonce) {
        db.prepare(
          'UPDATE provider_configs SET model_id = ?, api_key_encrypted = ?, api_key_nonce = ?, custom_base_url = ?, updated_at = ? WHERE id = ?',
        ).run(
          modelIdValue,
          encrypted,
          nonce,
          validatedBaseUrl,
          Date.now(),
          existing.id,
        );
      } else {
        db.prepare(
          'UPDATE provider_configs SET model_id = ?, custom_base_url = ?, updated_at = ? WHERE id = ?',
        ).run(modelIdValue, validatedBaseUrl, Date.now(), existing.id);
      }
    } else {
      const id = crypto.randomUUID();
      db.prepare(
        'INSERT INTO provider_configs (id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      ).run(
        id,
        providerIdValue,
        modelIdValue,
        encrypted || '',
        nonce || '',
        validatedBaseUrl,
        Date.now(),
        Date.now(),
      );
    }

    db.prepare('UPDATE provider_configs SET enabled = (provider_id = ?)').run(
      providerIdValue,
    );

    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_enabled', 'true', ?) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = ?",
    ).run(Date.now(), Date.now());
    db.prepare(
      "DELETE FROM app_settings WHERE key = 'provider_cooldown_ai_process'",
    ).run();
  })();

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

  const setting = db
    .prepare("SELECT value FROM app_settings WHERE key = 'ai_enabled'")
    .get() as { value: string } | undefined;
  const statuses = db
    .prepare(
      `SELECT analysis_status, COUNT(*) AS count
       FROM article_ai_metadata
       GROUP BY analysis_status`,
    )
    .all() as Array<{ analysis_status: string; count: number }>;
  const analysisCounts = {
    pending: 0,
    ready: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of statuses) {
    if (row.analysis_status in analysisCounts) {
      analysisCounts[row.analysis_status as keyof typeof analysisCounts] =
        Number(row.count) || 0;
    }
  }
  const activeJobRows = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM jobs
       WHERE type = 'ai_process' AND status IN ('queued', 'processing')
       GROUP BY status`,
    )
    .all() as Array<{ status: 'queued' | 'processing'; count: number }>;
  const aiJobCounts = { queued: 0, processing: 0 };
  for (const row of activeJobRows) {
    aiJobCounts[row.status] = Number(row.count) || 0;
  }
  const recentFailures = db
    .prepare(
      `SELECT am.article_id, a.title, f.title AS feed_title,
              am.analysis_status, am.analysis_error, am.processed_at
       FROM article_ai_metadata am
       JOIN articles a ON a.id = am.article_id
       JOIN feeds f ON f.id = a.feed_id
       WHERE am.analysis_status IN ('failed', 'skipped')
         AND COALESCE(am.analysis_error, '') != ''
       ORDER BY COALESCE(am.processed_at, am.created_at) DESC
       LIMIT 12`,
    )
    .all() as Array<{
    article_id: string;
    title: string;
    feed_title: string;
    analysis_status: 'failed' | 'skipped';
    analysis_error: string;
    processed_at: number | null;
  }>;

  return json({
    configs,
    aiEnabled: setting?.value !== 'false',
    aiConfigured: configs.some(
      (config) => (config as { enabled: number }).enabled === 1,
    ),
    analysisCounts,
    aiJobCounts,
    recentFailures: recentFailures.map((item) => ({
      ...item,
      title: String(item.title || 'Untitled article').slice(0, 180),
      feed_title: String(item.feed_title || 'Unknown feed').slice(0, 100),
      analysis_error: String(item.analysis_error || '').slice(0, 500),
    })),
  });
};
