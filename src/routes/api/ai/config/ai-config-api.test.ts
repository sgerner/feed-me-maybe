import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';

vi.mock('#lib/server/ai/models-dev.ts', () => ({
  getProvider: vi.fn(async (id: string) =>
    id === 'test-provider'
      ? {
          id,
          requiredEnvVars: ['TEST_API_KEY'],
          models: [{ id: 'test-model' }],
        }
      : undefined,
  ),
}));

vi.mock('#lib/server/network.ts', () => ({
  assertPublicNetworkUrl: vi.fn(async (value: string) => new URL(value)),
  SafeFetchError: class SafeFetchError extends Error {},
}));

import { GET, POST } from './+server';

describe('AI configuration API', () => {
  let testDb: TestDbHandle;
  const originalAppSecret = process.env.APP_SECRET;

  beforeAll(() => {
    process.env.APP_SECRET = 'test-app-secret-which-is-at-least-32-characters';
    testDb = createTestDb('feed-me-maybe-ai-config-api-');
  });

  beforeEach(() => {
    testDb.reset();
    testDb.db
      .prepare(
        "DELETE FROM app_settings WHERE key IN ('ai_enabled', 'provider_cooldown_ai_process')",
      )
      .run();
  });

  afterAll(() => {
    testDb.cleanup();
    if (originalAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = originalAppSecret;
  });

  function post(body: unknown) {
    return POST({
      request: new Request('http://localhost/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof POST>[0]);
  }

  it('rejects a new config with no usable credential', async () => {
    const response = await post({
      providerId: 'test-provider',
      modelId: 'test-model',
      config: {},
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('credential');
    const { getDb } = await import('#lib/server/db/index.ts');
    expect(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS count FROM provider_configs')
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });

  it('reports only the enabled config, preserves pause state, and clears the saved provider', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run('disabled-config', 'disabled-provider', 'old-model', now, now);
    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_enabled', 'false', ?)",
    ).run(now);

    const saveResponse = await post({
      providerId: 'test-provider',
      modelId: 'test-model',
      config: { TEST_API_KEY: 'secret-key' },
    });
    expect(saveResponse.status).toBe(200);

    const getResponse = await GET({
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof GET>[0]);
    const payload = await getResponse.json();
    expect(payload.aiEnabled).toBe(false);
    expect(payload.aiConfigured).toBe(true);
    expect(payload.configs).toEqual([
      expect.objectContaining({
        provider_id: 'test-provider',
        model_id: 'test-model',
        enabled: 1,
        has_api_key: true,
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain('secret-key');

    const clearResponse = await post({ clear: true });
    expect(clearResponse.status).toBe(200);
    const afterClear = await GET({
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof GET>[0]);
    const clearPayload = await afterClear.json();
    expect(clearPayload.configs).toEqual([]);
    expect(clearPayload.aiConfigured).toBe(false);
    expect(clearPayload.aiEnabled).toBe(false);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM provider_configs').get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it('reports provider cooldown and retries failed analyses in a bounded batch', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    await post({
      providerId: 'test-provider',
      modelId: 'test-model',
      config: { TEST_API_KEY: 'secret-key' },
    });
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('retry-feed', 'https://example.com/feed', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'retry-article',
      'retry-feed',
      'https://example.com/article',
      'Retry me',
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO article_ai_metadata
       (id, article_id, analysis_status, analysis_error, processed_at, created_at)
       VALUES (?, ?, 'failed', ?, ?, ?)`,
    ).run(
      'retry-metadata',
      'retry-article',
      'Temporary provider issue',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO jobs
       (id, type, status, payload, error_message, attempts, max_attempts,
        completed_at, created_at)
       VALUES (?, 'ai_process', 'failed', ?, ?, 3, 3, ?, ?)`,
    ).run(
      'failed-ai-job',
      JSON.stringify({ articleId: 'retry-article', feedId: 'retry-feed' }),
      'Temporary provider issue',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('provider_cooldown_ai_process', ?, ?)`,
    ).run(String(now + 60_000), now);

    const getResponse = await GET({
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof GET>[0]);
    const beforeRetry = await getResponse.json();
    expect(beforeRetry.aiCooldownUntil).toBe(now + 60_000);
    expect(beforeRetry.analysisCounts.failed).toBe(1);
    expect(beforeRetry.aiJobCounts.failed).toBe(1);

    const retryResponse = await post({ retryFailed: true });
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({ queued: 1, limit: 25 });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE type = 'ai_process' AND status = 'queued'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      db
        .prepare(
          'SELECT analysis_status FROM article_ai_metadata WHERE article_id = ?',
        )
        .get('retry-article'),
    ).toEqual({ analysis_status: 'pending' });
    const afterRetry = await (
      await GET({ locals: { sessionId: 'test-session' } } as Parameters<
        typeof GET
      >[0])
    ).json();
    expect(afterRetry.aiJobCounts.failed).toBe(0);
  });

  it('keeps only one active provider row after saving a duplicate', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const saved = await post({
      providerId: 'test-provider',
      modelId: 'test-model',
      config: { TEST_API_KEY: 'secret-key' },
    });
    expect(saved.status).toBe(200);
    const config = db
      .prepare('SELECT * FROM provider_configs WHERE provider_id = ?')
      .get('test-provider') as {
      custom_base_url: string | null;
      created_at: number;
      updated_at: number;
    };
    db.prepare(
      `INSERT INTO provider_configs
       (id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url,
        enabled, created_at, updated_at)
       VALUES (?, ?, ?, '', '', ?, 0, ?, ?)`,
    ).run(
      'duplicate-config',
      'test-provider',
      'test-model',
      config.custom_base_url,
      config.created_at,
      config.updated_at + 1,
    );

    const savedAgain = await post({
      providerId: 'test-provider',
      modelId: 'test-model',
      config: {},
    });
    expect(savedAgain.status).toBe(200);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM provider_configs').get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM provider_configs WHERE enabled = 1',
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  it('accepts a custom model ID only with a validated custom endpoint', async () => {
    const response = await post({
      providerId: 'test-provider',
      modelId: 'local-llama:8b',
      config: { TEST_API_KEY: 'secret-key' },
      customBaseUrl: 'https://public.example/v1',
    });
    expect(response.status).toBe(200);

    const { getDb } = await import('#lib/server/db/index.ts');
    const row = getDb()
      .prepare(
        'SELECT model_id, custom_base_url FROM provider_configs WHERE enabled = 1',
      )
      .get();
    expect(row).toEqual({
      model_id: 'local-llama:8b',
      custom_base_url: 'https://public.example/v1',
    });

    const invalid = await post({
      providerId: 'test-provider',
      modelId: 'local llama',
      config: { TEST_API_KEY: 'secret-key' },
      customBaseUrl: 'https://public.example/v1',
    });
    expect(invalid.status).toBe(400);

    // Rejects arbitrary http://, query strings, and fragments, while normalizing trailing slashes and allowing loopback http://
    for (const badBaseUrl of [
      'http://public.example/v1',
      'https://public.example/v1?key=1',
      'https://public.example/v1#frag',
    ]) {
      const rejected = await post({
        providerId: 'test-provider',
        modelId: 'local-llama:8b',
        config: { TEST_API_KEY: 'secret-key' },
        customBaseUrl: badBaseUrl,
      });
      expect(rejected.status).toBe(400);
    }

    const trailingSlash = await post({
      providerId: 'test-provider',
      modelId: 'local-llama:8b',
      config: { TEST_API_KEY: 'secret-key' },
      customBaseUrl: 'https://public.example/v1/',
    });
    expect(trailingSlash.status).toBe(200);
    expect(
      getDb()
        .prepare(
          'SELECT custom_base_url FROM provider_configs WHERE enabled = 1',
        )
        .get(),
    ).toEqual({ custom_base_url: 'https://public.example/v1' });

    const loopback = await post({
      providerId: 'test-provider',
      modelId: 'local-llama:8b',
      config: { TEST_API_KEY: 'secret-key' },
      customBaseUrl: 'http://127.0.0.1:11434/v1/',
    });
    expect(loopback.status).toBe(200);
    expect(
      getDb()
        .prepare(
          'SELECT custom_base_url FROM provider_configs WHERE enabled = 1',
        )
        .get(),
    ).toEqual({ custom_base_url: 'http://127.0.0.1:11434/v1' });
  });

  it('allows retryFailed when the saved model was removed from models.dev catalog', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { encrypt } = await import('#lib/server/ai/crypto.ts');
    const db = getDb();
    const now = Date.now();
    const creds = encrypt(JSON.stringify({ TEST_API_KEY: 'secret-key' }));

    db.prepare(
      `INSERT INTO provider_configs
       (id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url, enabled, created_at, updated_at)
       VALUES ('retired-cfg', 'test-provider', 'retired-model-id', ?, ?, NULL, 1, ?, ?)`,
    ).run(creds.encrypted, creds.nonce, now, now);
    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run('retired-feed', 'https://example.com/retired', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at)
       VALUES ('retired-art', 'retired-feed', 'https://example.com/retired/1', 'Story', ?, ?, ?)`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO article_ai_metadata (id, article_id, analysis_status, analysis_error, processed_at, created_at)
       VALUES ('retired-meta', 'retired-art', 'failed', 'Timeout', ?, ?)`,
    ).run(now, now);

    const retryResponse = await post({ retryFailed: true });
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({ queued: 1 });
  });

  it('queues backlog on config save and counts unindexed pending jobs in status', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('backlog-feed', 'https://example.com/backlog', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, fetched_at, created_at, updated_at)
       VALUES ('backlog-1', 'backlog-feed', 'https://example.com/b1', 'Backlog', 'Readable summary text', ?, ?, ?)`,
    ).run(now, now, now);

    const saved = await post({
      providerId: 'test-provider',
      modelId: 'test-model',
      config: { TEST_API_KEY: 'secret-key' },
    });
    expect(saved.status).toBe(200);

    const status = await (
      await GET({ locals: { sessionId: 'test-session' } } as Parameters<
        typeof GET
      >[0])
    ).json();
    expect(status.aiJobCounts.queued).toBe(1);
    expect(status.analysisCounts.pending).toBe(1);
    expect(status.oldestQueuedJobAt).toBeTypeOf('number');
  });
});
