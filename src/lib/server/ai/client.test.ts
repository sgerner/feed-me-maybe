import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiClient } from './client';

const validAnalysis = {
  summary: 'A concise article summary.',
  topics: ['testing'],
  entities: ['Example'],
  contentType: 'news',
  relevanceScore: 0.7,
  noveltyScore: 0.5,
  qualityScore: 0.8,
  likelyUserInterest: 'medium',
  signals: ['specific_details'],
  explanation: 'It contains concrete details.',
};

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
                content:
                  '{"summary":"Text with ,}", "topics":["test",], "entities":[], "contentType":"news", "relevanceScore":0.7, "noveltyScore":0.5, "qualityScore":0.8, "likelyUserInterest":"medium", "signals":["specific_details"], "explanation":"Concrete details",}',
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
    const response = await client.analyzeArticle({ title: 'Test' });
    expect(response).toMatchObject({
      summary: 'Text with ,}',
      topics: ['test'],
    });
  });

  it('rejects article analysis scores outside the supported range', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ ...validAnalysis, qualityScore: 8 }),
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

    await expect(client.analyzeArticle({ title: 'Test' })).rejects.toThrow(
      'AI provider returned invalid article analysis',
    );
  });

  it('rejects unexpected article analysis labels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...validAnalysis,
                  signals: ['buy_now'],
                }),
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

    await expect(client.analyzeArticle({ title: 'Test' })).rejects.toThrow(
      'AI provider returned invalid article analysis',
    );
  });

  it('omits temperature for models that do not support it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: 'Summary.' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = createAiClient({
      baseUrl: 'https://1.1.1.1/v1',
      apiKey: 'secret',
      model: 'test',
      supportsTemperature: false,
    });

    await client.summarizeArticle('article text');
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request).not.toHaveProperty('temperature');
  });

  it('redacts secrets in HTTP errors, parses fenced JSON with newlines, and avoids retrying truncations', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('Invalid token secret-api-key-123 and sk-abcdefgh123', {
            status: 401,
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            model: 'resolved-test-model',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content:
                    'Here is the {note} output:\n```json\n{"summary":"Line 1\nLine 2","topics":["ai"],"entities":[],"contentType":"news","relevanceScore":0.8,"noveltyScore":0.7,"qualityScore":0.9,"signals":["cited_sources"]}\n```',
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            choices: [
              {
                finish_reason: 'length',
                message: { content: '{"summary":"partial' },
              },
            ],
          }),
        ),
    );
    const client = createAiClient({
      baseUrl: 'https://1.1.1.1/v1',
      apiKey: 'secret-api-key-123',
      model: 'test',
    });

    const authErr = await client.summarizeArticle('hello').catch((e) => e);
    expect(authErr.message).not.toContain('secret-api-key-123');
    expect(authErr.message).not.toContain('sk-abcdefgh123');
    expect(authErr.message).toContain('[REDACTED]');

    const analyzed = await client.analyzeArticleWithMeta({ title: 'Test' });
    expect(analyzed.model).toBe('resolved-test-model');
    expect(analyzed.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(analyzed.analysis.summary).toBe('Line 1 Line 2');

    const truncatedErr = await client
      .analyzeArticle({ title: 'Truncated' })
      .catch((e) => e);
    expect(truncatedErr.permanent).toBe(true);
  });
});
