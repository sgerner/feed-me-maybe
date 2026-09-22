import type { ArticleAnalysisInput, ArticleScore } from './types';
import {
  ARTICLE_ANALYSIS_SYSTEM_PROMPT,
  buildArticleAnalysisPrompt,
} from './prompts';
import { coerceText, normalizeTextArray } from '$lib/server/normalization';

interface AiClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string;
  defaultHeaders?: Record<string, string>;
}

function clampScore(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeText(value: unknown): string {
  return coerceText(value);
}

function normalizeTag(value: unknown): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  return normalizeTextArray(value, limit);
}

function normalizeTagArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const tag = normalizeTag(item);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeSignals(data: Record<string, unknown>): string[] {
  return normalizeTagArray(data.signals, 8);
}

function normalizeLikelihood(value: unknown): string {
  const normalized = normalizeTag(value);
  if (
    normalized === 'high' ||
    normalized === 'medium' ||
    normalized === 'low'
  ) {
    return normalized;
  }
  return '';
}

function normalizeAnalysis(raw: unknown): Partial<ArticleScore> {
  if (!raw || typeof raw !== 'object') return {};
  const data = raw as Record<string, unknown>;
  return {
    summary: normalizeText(data.summary),
    topics: normalizeStringArray(data.topics, 8),
    entities: normalizeStringArray(data.entities, 8),
    contentType: normalizeTag(data.contentType),
    relevanceScore: clampScore(data.relevanceScore),
    noveltyScore: clampScore(data.noveltyScore),
    qualityScore: clampScore(data.qualityScore),
    likelyUserInterest: normalizeLikelihood(data.likelyUserInterest),
    signals: normalizeSignals(data),
    explanation: normalizeText(data.explanation),
  };
}

export function createAiClient(config: AiClientConfig) {
  const {
    baseUrl,
    apiKey,
    model,
    providerId = '',
    defaultHeaders = {},
  } = config;
  const isDeepSeek =
    providerId.toLowerCase() === 'deepseek' ||
    model.toLowerCase().startsWith('deepseek-');

  async function completeChat(
    systemPrompt: string,
    userPrompt: string,
    maxTokens = 512,
    options: { jsonMode?: boolean } = {},
  ): Promise<string> {
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
    };

    if (isDeepSeek) {
      // DeepSeek V4 enables thinking by default. With a small JSON budget it
      // can spend the entire completion on reasoning_content and return an
      // empty message.content. Article enrichment needs the final JSON, not
      // the hidden reasoning trace.
      requestBody.thinking = { type: 'disabled' };
      if (options.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }
    } else {
      requestBody.temperature = 0.1;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...defaultHeaders,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
      throw new Error(
        `AI provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: unknown; reasoning_content?: unknown };
      }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const text = Array.isArray(content)
      ? content
          .map((part) => {
            if (!part || typeof part !== 'object') return coerceText(part);
            const record = part as Record<string, unknown>;
            return coerceText(record.text ?? record.content ?? record);
          })
          .filter(Boolean)
          .join('\n')
      : coerceText(content);
    if (!text) {
      const hasReasoning = Boolean(
        coerceText(choice?.message?.reasoning_content),
      );
      if (choice?.finish_reason === 'length' && hasReasoning) {
        throw new Error(
          'AI provider returned no final message content; reasoning consumed the output limit',
        );
      }
      throw new Error('AI provider returned no message content');
    }
    return text;
  }

  function parseJsonObject(result: string): unknown {
    const trimmed = result.trim();
    const unfenced = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    const candidate =
      start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
    try {
      return JSON.parse(candidate);
    } catch {
      throw new Error('AI provider returned invalid JSON');
    }
  }

  async function analyzeArticle(
    input: ArticleAnalysisInput,
  ): Promise<Partial<ArticleScore>> {
    const result = await completeChat(
      ARTICLE_ANALYSIS_SYSTEM_PROMPT,
      buildArticleAnalysisPrompt(input),
      isDeepSeek ? 1024 : 768,
      { jsonMode: true },
    );
    return normalizeAnalysis(parseJsonObject(result));
  }

  async function summarizeArticle(content: string): Promise<string | null> {
    return completeChat(
      'Summarize concisely in 2-3 sentences.',
      content.substring(0, 3000),
      256,
    );
  }

  return { completeChat, analyzeArticle, summarizeArticle };
}

export function createNullAiClient() {
  return {
    completeChat: async () => null,
    analyzeArticle: async () => ({}),
    summarizeArticle: async () => null,
  };
}
