import { getDb } from '$lib/server/db';
import { createAiClient, createNullAiClient } from '$lib/server/ai/client';
import crypto from 'node:crypto';

const APP_SECRET = process.env.APP_SECRET || 'dev-secret-key-32-chars-min!!';

function decrypt(encrypted: string, nonceHex: string): string {
  try {
    const key = crypto.createHash('sha256').update(APP_SECRET).digest();
    const nonce = Buffer.from(nonceHex, 'hex');
    const authTag = Buffer.from(encrypted.slice(-32), 'hex');
    const ciphertext = encrypted.slice(0, -32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    let dec = decipher.update(ciphertext, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch {
    return '';
  }
}

export async function processArticle(articleId: string): Promise<void> {
  const db = getDb();

  const config = db.prepare('SELECT * FROM provider_configs WHERE enabled = 1 LIMIT 1').get() as Record<string, string> | undefined;
  if (!config) return;

  const article = db.prepare('SELECT title, summary, content FROM articles WHERE id = ?').get(articleId) as Record<string, string> | undefined;
  if (!article) return;

  const apiKey = decrypt(config.api_key_encrypted || '', config.api_key_nonce || '');
  if (!apiKey) return;

  const client = createAiClient({
    baseUrl: config.custom_base_url || `https://api.${config.provider_id}.com/v1`,
    apiKey,
    model: config.model_id
  });

  const score = await client.scoreArticle(article.title, article.summary || article.content || '');
  const now = Date.now();

  const existing = db.prepare('SELECT id FROM article_ai_metadata WHERE article_id = ?').get(articleId);
  if (existing) {
    db.prepare('UPDATE article_ai_metadata SET ai_relevance_score = ?, explanation = ?, processed_at = ? WHERE article_id = ?')
      .run(score.relevanceScore || 0, score.explanation || '', now, articleId);
  } else {
    db.prepare('INSERT INTO article_ai_metadata (id, article_id, ai_relevance_score, explanation, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), articleId, score.relevanceScore || 0, score.explanation || '', now, now);
  }

  // Combined score: 40% AI + 60% heuristic
  const articleRow = db.prepare('SELECT heuristic_score FROM articles WHERE id = ?').get(articleId) as { heuristic_score: number } | undefined;
  const heuristic = articleRow?.heuristic_score || 50;
  const ai = (score.relevanceScore || 0) * 100;
  const combined = Math.round(heuristic * 0.6 + ai * 0.4);
  db.prepare('UPDATE articles SET combined_score = ? WHERE id = ?').run(Math.max(0, Math.min(100, combined)), articleId);
}