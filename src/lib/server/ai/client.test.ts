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
});
