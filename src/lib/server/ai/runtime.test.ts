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

vi.mock('./models-dev', () => ({
  getProvider: vi.fn(async (id: string) =>
    id === 'openai'
      ? {
          id: 'openai',
          name: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          requiredEnvVars: ['OPENAI_API_KEY'],
          models: [{ id: 'gpt-active', temperature: true }],
        }
      : undefined,
  ),
}));

describe('AI runtime configuration', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-ai-runtime.db');
  const originalDbUrl = process.env.DATABASE_URL;
  const originalAppSecret = process.env.APP_SECRET;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    process.env.APP_SECRET = 'test-app-secret-which-is-at-least-32-characters';
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    db.prepare('DELETE FROM provider_configs').run();
    db.prepare("DELETE FROM app_settings WHERE key = 'ai_enabled'").run();
  });

  afterAll(async () => {
    const { closeDb } = await import('#lib/server/db/index.ts');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    process.env.APP_SECRET = originalAppSecret ?? '';
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${testDbPath}${suffix}`))
        unlinkSync(`${testDbPath}${suffix}`);
    }
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
});
