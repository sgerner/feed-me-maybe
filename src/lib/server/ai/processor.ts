import { getDb } from '$lib/server/db';
import { createAiClient } from '$lib/server/ai/client';
import { getProvider } from '$lib/server/ai/models-dev';
import { decrypt } from './crypto';
import { incorporateAiClassificationIntoMemory } from '$lib/server/preferences';
import crypto from 'node:crypto';

export async function processArticle(articleId: string): Promise<void> {
  const db = getDb();

  const config = db
    .prepare('SELECT * FROM provider_configs WHERE enabled = 1 LIMIT 1')
    .get() as Record<string, any> | undefined;
  if (!config) return;

  const article = db
    .prepare('SELECT title, summary, content FROM articles WHERE id = ?')
    .get(articleId) as Record<string, string> | undefined;
  if (!article) return;

  const decryptedConfigRaw = decrypt(
    config.api_key_encrypted || '',
    config.api_key_nonce || '',
  );
  if (!decryptedConfigRaw) return;

  const decryptedConfig: Record<string, string> = (() => {
    try {
      return JSON.parse(decryptedConfigRaw) as Record<string, string>;
    } catch {
      // Fallback for old single-key configs
      return { apiKey: decryptedConfigRaw };
    }
  })();

  const providerInfo = await getProvider(config.provider_id);
  const baseUrl = config.custom_base_url || providerInfo?.baseUrl || '';

  // Try to find an API key. Prefer the first required one, or any key if none specified.
  const apiKey = providerInfo?.requiredEnvVars?.length
    ? decryptedConfig[providerInfo.requiredEnvVars[0]] ||
      Object.values(decryptedConfig)[0] ||
      ''
    : decryptedConfig.apiKey || Object.values(decryptedConfig)[0] || '';

  if (!apiKey || !baseUrl) return;

  const client = createAiClient({
    baseUrl,
    apiKey,
    model: config.model_id,
  });

  const classification = await client.classifyArticle(
    article.title,
    article.summary || article.content || '',
  );
  const score = await client.scoreArticle(
    article.title,
    article.summary || article.content || '',
  );
  const now = Date.now();
  const topicsJson = JSON.stringify(classification.topics || []);
  const entitiesJson = JSON.stringify(classification.entities || []);
  const contentType = String(classification.contentType || '');
  const aiSummary = String(classification.summary || '');
  const noveltyScore =
    typeof classification.noveltyScore === 'number'
      ? classification.noveltyScore
      : 0;
  const qualityScore =
    typeof classification.qualityScore === 'number'
      ? classification.qualityScore
      : 0;
  const likelyInterest = String(classification.likelyUserInterest || '');

  const existing = db
    .prepare('SELECT id FROM article_ai_metadata WHERE article_id = ?')
    .get(articleId);
  if (existing) {
    db.prepare(
      `
      UPDATE article_ai_metadata
      SET summary = ?, topics = ?, entities = ?, content_type = ?,
          ai_relevance_score = ?, novelty_score = ?, quality_score = ?, likely_user_interest = ?,
          explanation = ?, processed_at = ?
      WHERE article_id = ?
    `,
    ).run(
      aiSummary,
      topicsJson,
      entitiesJson,
      contentType,
      score.relevanceScore || 0,
      noveltyScore,
      qualityScore,
      likelyInterest,
      score.explanation || '',
      now,
      articleId,
    );
  } else {
    db.prepare(
      `
      INSERT INTO article_ai_metadata (
        id, article_id, summary, topics, entities, content_type,
        ai_relevance_score, novelty_score, quality_score, likely_user_interest,
        explanation, processed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      crypto.randomUUID(),
      articleId,
      aiSummary,
      topicsJson,
      entitiesJson,
      contentType,
      score.relevanceScore || 0,
      noveltyScore,
      qualityScore,
      likelyInterest,
      score.explanation || '',
      now,
      now,
    );
  }

  // Combined score: 40% AI + 60% heuristic
  const articleRow = db
    .prepare('SELECT heuristic_score FROM articles WHERE id = ?')
    .get(articleId) as { heuristic_score: number } | undefined;
  const heuristic = articleRow?.heuristic_score || 50;
  const ai = (score.relevanceScore || 0) * 100;
  const combined = Math.round(heuristic * 0.6 + ai * 0.4);
  db.prepare('UPDATE articles SET combined_score = ? WHERE id = ?').run(
    Math.max(0, Math.min(100, combined)),
    articleId,
  );

  incorporateAiClassificationIntoMemory(articleId, classification);
}
