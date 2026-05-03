import type { ArticleScore } from './types';

interface AiClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultHeaders?: Record<string, string>;
}

export function createAiClient(config: AiClientConfig) {
  const { baseUrl, apiKey, model, defaultHeaders = {} } = config;

  async function chatComplete(systemPrompt: string, userPrompt: string): Promise<string | null> {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...defaultHeaders
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 1024
        })
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.choices?.[0]?.message?.content || null;
    } catch {
      return null;
    }
  }

  async function classifyArticle(title: string, content: string): Promise<Partial<ArticleScore>> {
    const result = await chatComplete(
      'You are an article classifier. Return JSON only.',
      `Classify this article:\nTitle: ${title}\nContent: ${content?.substring(0, 2000)}`
    );
    if (!result) return {};
    try { return JSON.parse(result); } catch { return {}; }
  }

  async function scoreArticle(title: string, summary: string): Promise<Partial<ArticleScore>> {
    const result = await chatComplete(
      'You are a relevance scorer. Return JSON only with relevanceScore (0-1).',
      `Score: ${title}\n${summary?.substring(0, 1000)}`
    );
    if (!result) return {};
    try { return JSON.parse(result); } catch { return {}; }
  }

  async function summarizeArticle(content: string): Promise<string | null> {
    return chatComplete(
      'Summarize concisely in 2-3 sentences.',
      content.substring(0, 3000)
    );
  }

  return { classifyArticle, scoreArticle, summarizeArticle };
}

export function createNullAiClient() {
  return {
    classifyArticle: async () => ({}),
    scoreArticle: async () => ({ relevanceScore: 0 }),
    summarizeArticle: async () => null
  };
}