import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('$lib/server/ai/models-dev', () => ({
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

import { GET, POST } from './+server';

describe('AI configuration API', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-ai-config-api.db');
  const originalDbUrl = process.env.DATABASE_URL;
  const originalAppSecret = process.env.APP_SECRET;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    process.env.APP_SECRET = 'test-app-secret-which-is-at-least-32-characters';
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    db.prepare('DELETE FROM provider_configs').run();
    db.prepare(
      "DELETE FROM app_settings WHERE key IN ('ai_enabled', 'provider_cooldown_ai_process')",
    ).run();
  });

  afterAll(async () => {
    const { closeDb } = await import('$lib/server/db');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (originalAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = originalAppSecret;
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${testDbPath}${suffix}`))
        unlinkSync(`${testDbPath}${suffix}`);
    }
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
    const { getDb } = await import('$lib/server/db');
    expect(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS count FROM provider_configs')
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });

  it('reports only the enabled config, preserves pause state, and clears the saved provider', async () => {
    const { getDb } = await import('$lib/server/db');
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
  });
});
