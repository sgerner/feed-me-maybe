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

vi.mock('./models-dev', () => ({
  getProvider: vi.fn(async (id: string) => {
    if (id === 'openai') {
      return {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        requiredEnvVars: ['OPENAI_API_KEY'],
        models: [{ id: 'gpt-active', temperature: true }],
      };
    }
    if (id === 'clarifai') {
      return {
        id: 'clarifai',
        name: 'Clarifai',
        baseUrl: 'https://api.clarifai.com/v2/ext/openai/v1',
        requiredEnvVars: ['CLARIFAI_PAT'],
        models: [{ id: 'clarifai-model', temperature: true }],
      };
    }
    if (id === 'runinfra') {
      return {
        id: 'runinfra',
        name: 'RunInfra',
        baseUrl: 'https://api.runinfra.com/v1',
        requiredEnvVars: ['RUNINFRA_KEY'],
        models: [{ id: 'runinfra-model', temperature: true }],
      };
    }
    if (id === 'abliteration-ai') {
      return {
        id: 'abliteration-ai',
        name: 'Abliteration',
        baseUrl: 'https://api.abliteration.ai/v1',
        requiredEnvVars: ['ABLITERATION_SECRET'],
        models: [{ id: 'abliteration-model', temperature: true }],
      };
    }
    return undefined;
  }),
}));

describe('AI runtime configuration', () => {
  let testDb: TestDbHandle;
  const originalAppSecret = process.env.APP_SECRET;

  beforeAll(() => {
    process.env.APP_SECRET = 'test-app-secret-which-is-at-least-32-characters';
    testDb = createTestDb('feed-me-maybe-ai-runtime-');
  });

  beforeEach(() => {
    testDb.reset();
    testDb.db
      .prepare("DELETE FROM app_settings WHERE key = 'ai_enabled'")
      .run();
  });

  afterAll(() => {
    testDb.cleanup();
    if (originalAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = originalAppSecret;
  });

  it('builds a client when a configured model was removed from models.dev catalog', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { encrypt } = await import('./crypto');
    const { getConfiguredAiClient } = await import('./runtime');
    const db = getDb();
    const now = Date.now();
    const creds = encrypt(JSON.stringify({ apiKey: 'sk-test-1234' }));

    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)',
    ).run(
      'cfg-retired-model',
      'openai',
      'gpt-retired-from-catalog',
      creds.encrypted,
      creds.nonce,
      now,
      now,
    );

    const client = await getConfiguredAiClient();
    expect(client).not.toBeNull();
  });

  it('recognizes _PAT, _KEY, and _SECRET provider credential variable names', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { encrypt } = await import('./crypto');
    const { getConfiguredAiClient } = await import('./runtime');
    const db = getDb();
    const now = Date.now();

    for (const [providerId, envKey] of [
      ['clarifai', 'CLARIFAI_PAT'],
      ['runinfra', 'RUNINFRA_KEY'],
      ['abliteration-ai', 'ABLITERATION_SECRET'],
    ] as const) {
      db.prepare('DELETE FROM provider_configs').run();
      const creds = encrypt(JSON.stringify({ [envKey]: 'secret-val-123' }));
      db.prepare(
        'INSERT INTO provider_configs (id, provider_id, model_id, api_key_encrypted, api_key_nonce, custom_base_url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)',
      ).run(
        `cfg-${providerId}`,
        providerId,
        `${providerId}-model`,
        creds.encrypted,
        creds.nonce,
        now,
        now,
      );
      expect(await getConfiguredAiClient()).not.toBeNull();
    }
  });
});
