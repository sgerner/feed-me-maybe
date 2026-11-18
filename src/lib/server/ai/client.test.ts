import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiClient } from './client';

describe('AI provider network restrictions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects private AI base URLs before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createAiClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'secret',
      model: 'test-model',
    });

    await expect(client.summarizeArticle('article text')).rejects.toMatchObject(
      { code: 'private_network' },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow provider redirects with API credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.example/chat/completions' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createAiClient({
      baseUrl: 'https://1.1.1.1/v1',
      apiKey: 'secret',
      model: 'test-model',
    });

    await expect(client.summarizeArticle('article text')).rejects.toMatchObject(
      { code: 'too_many_redirects' },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('preserves the retry time for a rate limited response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Slow down', {
          status: 429,
          headers: { 'retry-after': '90' },
        }),
      ),
    );
    const client = createAiClient({
      baseUrl: 'https://1.1.1.1/v1',
      apiKey: 'secret',
      model: 'test',
    });
    const before = Date.now();
    const error = await client
      .summarizeArticle('article text')
      .catch((error) => error);
    expect(error.retryAt).toBeGreaterThanOrEqual(before + 90_000);
    expect(error.retryAt).toBeLessThanOrEqual(Date.now() + 90_000);
  });

  it('repairs trailing commas without changing quoted content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                content: '{"summary":"Text with ,}", "topics":["test",],}',
              },
            },
          ],
        }),
      ),
    );
    const client = createAiClient({
      baseUrl: 'https://1.1.1.1/v1',
      apiKey: 'secret',
      model: 'test',
    });
    await expect(
      client.analyzeArticle({ title: 'Test' }),
    ).resolves.toMatchObject({
      summary: 'Text with ,}',
      topics: ['test'],
    });
  });
});
