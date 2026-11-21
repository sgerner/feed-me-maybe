import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { encrypt } from '#lib/server/ai/crypto.ts';
import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import { assertPublicNetworkUrl, SafeFetchError } from '$lib/server/network';
import { getProvider } from '$lib/server/ai/models-dev';
import {
  enqueueAiBackfill,
  enqueueAiProcess,
} from '$lib/server/feed/job-queue';
import { wakePoller } from '$lib/server/poller';
import {
  decryptProviderCredentials,
  hasProviderCredentials,
} from '#lib/server/ai/credentials.ts';

function isValidCustomModelId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  );
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ error: 'Invalid body' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid body' }, { status: 400 });
  }

  if (body.retryFailed === true && Object.keys(body).length === 1) {
    const db = getDb();
    const enabled = db
      .prepare("SELECT value FROM app_settings WHERE key = 'ai_enabled'")
      .get() as { value: string } | undefined;
    if (enabled?.value === 'false') {
      return json(
        { error: 'Enable background AI processing before retrying.' },
        { status: 409 },
      );
    }

    const activeConfig = db
      .prepare(
        `SELECT provider_id, model_id, custom_base_url, api_key_encrypted,
                api_key_nonce
         FROM provider_configs WHERE enabled = 1
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get() as
      | {
          provider_id: string;
          model_id: string;
          custom_base_url: string | null;
          api_key_encrypted: string | null;
          api_key_nonce: string | null;
        }
      | undefined;
    if (
      !activeConfig ||
      !hasProviderCredentials(
        activeConfig.api_key_encrypted,
        activeConfig.api_key_nonce,
      )
    ) {
      return json(
        { error: 'Configure an AI provider before retrying.' },
        { status: 409 },
      );
    }

    let provider;
    try {
      provider = await getProvider(activeConfig.provider_id);
    } catch {
      provider = undefined;
    }
    const currentModelAvailable = Boolean(
      provider &&
      (activeConfig.custom_base_url ||
        provider.models.some((model) => model.id === activeConfig.model_id)),
    );
    if (!currentModelAvailable) {
      return json(
        {
          error:
            'Choose a supported model or add a custom base URL before retrying.',
        },
        { status: 409 },
      );
    }

    const candidates = db
      .prepare(
        `SELECT article_id, feed_id FROM (
           SELECT am.article_id, a.feed_id,
                  COALESCE(am.processed_at, am.created_at) AS failed_at
           FROM article_ai_metadata am
           JOIN articles a ON a.id = am.article_id
           WHERE am.analysis_status IN ('failed', 'skipped')
           UNION
           SELECT a.id AS article_id, a.feed_id,
                  COALESCE(j.completed_at, j.created_at) AS failed_at
           FROM jobs j
           JOIN articles a ON a.id = CASE
             WHEN json_valid(j.payload) = 1
             THEN json_extract(j.payload, '$.articleId')
           END
           WHERE j.type = 'ai_process' AND j.status = 'failed'
         )
         GROUP BY article_id, feed_id
         ORDER BY MAX(failed_at) DESC
         LIMIT 25`,
      )
      .all() as Array<{ article_id: string; feed_id: string }>;

    let queued = 0;
    for (const article of candidates) {
      enqueueAiProcess(article.article_id, { feedId: article.feed_id });
      db.prepare(
        `UPDATE article_ai_metadata
         SET analysis_status = 'pending', analysis_error = '', processed_at = NULL
         WHERE article_id = ? AND analysis_status IN ('failed', 'skipped')`,
      ).run(article.article_id);
      queued += 1;
    }
    return json({ success: true, queued, limit: 25 });
  }

  const { providerId, modelId, config, customBaseUrl, enabled, clear } =
    body as {
      providerId: unknown;
      modelId: unknown;
      config?: unknown;
      customBaseUrl?: unknown;
      enabled?: unknown;
      clear?: unknown;
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
    if (enabled) {
      enqueueAiBackfill({ now, limit: 25 });
      wakePoller();
    }
    return json({ success: true, aiEnabled: enabled });
  }

  if (
    clear === true &&
    providerId === undefined &&
    modelId === undefined &&
    config === undefined &&
    customBaseUrl === undefined
  ) {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM provider_configs').run();
      db.prepare(
        "DELETE FROM app_settings WHERE key = 'provider_cooldown_ai_process'",
      ).run();
    })();
    return json({ success: true, cleared: true });
  }

  if (typeof providerId !== 'string' || typeof modelId !== 'string')
    return json({ error: 'providerId and modelId required' }, { status: 400 });
  const providerIdValue = providerId.trim();
  const modelIdValue = modelId.trim();
  if (!providerIdValue || !modelIdValue)
    return json({ error: 'providerId and modelId required' }, { status: 400 });

  const provider = await getProvider(providerIdValue);
  const isCustomModel =
    typeof customBaseUrl === 'string' && customBaseUrl.trim().length > 0;
  if (
    !provider ||
    (isCustomModel
      ? !isValidCustomModelId(modelIdValue)
      : !provider.models.some((model) => model.id === modelIdValue))
  ) {
    return json(
      {
        error: isCustomModel
          ? 'Enter a valid model ID for the selected provider.'
          : 'Select a supported text chat model and provider.',
      },
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
  const existingRows = db
    .prepare(
      'SELECT id, api_key_encrypted, api_key_nonce FROM provider_configs WHERE provider_id = ? ORDER BY enabled DESC, updated_at DESC, id DESC',
    )
    .all(providerIdValue) as Array<{
    id: string;
    api_key_encrypted: string | null;
    api_key_nonce: string | null;
  }>;
  const existing =
    existingRows.find((row) =>
      hasProviderCredentials(row.api_key_encrypted, row.api_key_nonce),
    ) ?? existingRows[0];

  const existingCredentials = decryptProviderCredentials(
    existing?.api_key_encrypted,
    existing?.api_key_nonce,
  );
  const credentialsToStore = { ...existingCredentials, ...safeConfig };
  if (Object.keys(credentialsToStore).length === 0) {
    return json(
      {
        error: 'Enter a provider credential before saving this configuration.',
      },
      { status: 400 },
    );
  }

  let encrypted: string | undefined;
  let nonce: string | undefined;
  if (Object.keys(safeConfig).length > 0 || !existing) {
    const result = encrypt(JSON.stringify(credentialsToStore));
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

    const insertedRow = db
      .prepare(
        'SELECT id FROM provider_configs WHERE provider_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
      )
      .get(providerIdValue) as { id: string } | undefined;
    const activeId = existing?.id ?? insertedRow?.id;
    db.prepare('UPDATE provider_configs SET enabled = 0').run();
    if (activeId) {
      db.prepare(
        'DELETE FROM provider_configs WHERE provider_id = ? AND id != ?',
      ).run(providerIdValue, activeId);
      db.prepare('UPDATE provider_configs SET enabled = 1 WHERE id = ?').run(
        activeId,
      );
    }

    db.prepare(
      "DELETE FROM app_settings WHERE key = 'provider_cooldown_ai_process'",
    ).run();
  })();

  if (enqueueAiBackfill({ limit: 25 }) > 0) wakePoller();

  return json({ success: true });
};

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const configRows = db
    .prepare(
      'SELECT id, provider_id, model_id, custom_base_url, enabled, api_key_encrypted, api_key_nonce FROM provider_configs WHERE enabled = 1 ORDER BY updated_at DESC, id DESC LIMIT 1',
    )
    .all() as Array<{
    id: string;
    provider_id: string;
    model_id: string;
    custom_base_url: string | null;
    enabled: number;
    api_key_encrypted: string | null;
    api_key_nonce: string | null;
  }>;
  const configs = configRows.map((config) => ({
    id: config.id,
    provider_id: config.provider_id,
    model_id: config.model_id,
    custom_base_url: config.custom_base_url,
    enabled: config.enabled,
    has_api_key: hasProviderCredentials(
      config.api_key_encrypted,
      config.api_key_nonce,
    ),
    model_available: false,
  }));
  const activeProvider = configs[0]
    ? await getProvider(configs[0].provider_id).catch(() => undefined)
    : undefined;
  const activeModelAvailable = Boolean(
    configs[0] &&
    activeProvider &&
    (configs[0].custom_base_url ||
      activeProvider.models.some((model) => model.id === configs[0].model_id)),
  );
  if (configs[0]) configs[0].model_available = activeModelAvailable;

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
  const failedJobCount = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM jobs j
       JOIN articles a ON a.id = CASE
         WHEN json_valid(j.payload) = 1
         THEN json_extract(j.payload, '$.articleId')
       END
       LEFT JOIN article_ai_metadata am ON am.article_id = a.id
       WHERE j.type = 'ai_process' AND j.status = 'failed'
         AND (am.analysis_status IS NULL OR am.analysis_status IN ('failed', 'skipped'))`,
    )
    .get() as { count: number };
  const aiJobCounts = {
    queued: 0,
    processing: 0,
    failed: Number(failedJobCount.count) || 0,
  };
  for (const row of activeJobRows) {
    aiJobCounts[row.status] = Number(row.count) || 0;
  }
  const unindexedQueuedAiRow = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM jobs j
       WHERE j.type = 'ai_process'
         AND j.status IN ('queued', 'processing')
         AND NOT EXISTS (
           SELECT 1 FROM article_ai_metadata am
           WHERE am.article_id = CASE
             WHEN json_valid(j.payload) = 1
             THEN json_extract(j.payload, '$.articleId')
           END
         )`,
    )
    .get() as { count: number } | undefined;
  analysisCounts.pending += Number(unindexedQueuedAiRow?.count) || 0;
  const oldestQueuedRow = db
    .prepare(
      `SELECT MIN(created_at) AS oldest
       FROM jobs
       WHERE type = 'ai_process' AND status = 'queued'`,
    )
    .get() as { oldest: number | null } | undefined;
  const cooldownRow = db
    .prepare(
      "SELECT CAST(value AS INTEGER) AS due FROM app_settings WHERE key = 'provider_cooldown_ai_process'",
    )
    .get() as { due: number } | undefined;
  const cooldownUntil = Number(cooldownRow?.due || 0);
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
      (config) => config.has_api_key && config.model_available,
    ),
    analysisCounts,
    aiJobCounts,
    oldestQueuedJobAt:
      typeof oldestQueuedRow?.oldest === 'number' &&
      Number.isFinite(oldestQueuedRow.oldest)
        ? oldestQueuedRow.oldest
        : null,
    aiCooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : null,
    recentFailures: recentFailures.map((item) => ({
      ...item,
      title: String(item.title || 'Untitled article').slice(0, 180),
      feed_title: String(item.feed_title || 'Unknown feed').slice(0, 100),
      analysis_error: String(item.analysis_error || '').slice(0, 500),
    })),
  });
};
