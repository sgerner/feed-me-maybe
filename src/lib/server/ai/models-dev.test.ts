import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModel, getProviders } from './models-dev';

describe('models.dev catalog compatibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns only supported text chat providers and active models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          openai: {
            name: 'OpenAI',
            npm: '@ai-sdk/openai',
            api: null,
            env: ['OPENAI_API_KEY'],
            models: {
              'gpt-compatible': {
                name: 'GPT Compatible',
                family: 'gpt',
                limit: { context: 16_000 },
                modalities: { input: ['text'], output: ['text'] },
                temperature: false,
              },
              embedding: {
                name: 'Embedding Model',
                limit: { context: 8_000 },
                modalities: { input: ['text'], output: ['embedding'] },
              },
              deprecated: {
                name: 'Deprecated Model',
                status: 'deprecated',
                limit: { context: 8_000 },
                modalities: { input: ['text'], output: ['text'] },
              },
            },
          },
          deepseek: {
            name: 'DeepSeek',
            npm: '@ai-sdk/openai-compatible',
            api: 'https://api.deepseek.com/v1/',
            env: ['DEEPSEEK_API_KEY'],
            models: {
              'deepseek-chat': {
                name: 'DeepSeek Chat',
                limit: { context: 32_000 },
                modalities: { input: ['text', 'image'], output: ['text'] },
              },
            },
          },
          anthropic: {
            name: 'Anthropic',
            npm: '@ai-sdk/anthropic',
            api: null,
            env: ['ANTHROPIC_API_KEY'],
            models: {
              claude: {
                name: 'Claude',
                limit: { context: 32_000 },
                modalities: { input: ['text'], output: ['text'] },
              },
            },
          },
          dynamic: {
            name: 'Dynamic endpoint',
            npm: '@ai-sdk/openai-compatible',
            api: 'https://api.example.com/${ACCOUNT}/v1',
            models: {
              model: {
                limit: { context: 32_000 },
                modalities: { input: ['text'], output: ['text'] },
              },
            },
          },
          local: {
            name: 'Local endpoint',
            npm: '@ai-sdk/openai-compatible',
            api: 'http://127.0.0.1:11434/v1',
            models: {
              model: {
                limit: { context: 32_000 },
                modalities: { input: ['text'], output: ['text'] },
              },
            },
          },
        }),
      ),
    );

    const providers = await getProviders();
    expect(providers.map((provider) => provider.id)).toEqual([
      'openai',
      'deepseek',
    ]);
    expect(providers[0]).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-compatible', temperature: false }],
    });
    expect(providers[1].baseUrl).toBe('https://api.deepseek.com/v1');
    await expect(getModel('anthropic', 'claude')).resolves.toBeUndefined();
    await expect(getModel('openai', 'embedding')).resolves.toBeUndefined();
  });
});
