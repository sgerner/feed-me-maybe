import { getDb } from '$lib/server/db';
import type { InteractionType } from '$lib/server/interactions';
import crypto from 'node:crypto';

type ArticleContext = {
  id: string;
  title: string;
  summary: string;
  content: string;
  categories: string;
  feed_id: string;
  feed_url: string;
};

type Feature = {
  type: string;
  label: string;
  weight: number;
};

type PreferenceState = {
  adjustment: number;
  totalNegativeEvidence: number;
};

const TITLE_PHRASE_LIMIT = 5;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'have', 'has', 'are',
  'was', 'were', 'will', 'would', 'could', 'should', 'about', 'into', 'their', 'there',
  'after', 'before', 'what', 'when', 'where', 'which', 'while', 'who', 'how', 'its',
  'his', 'her', 'our', 'you', 'new', 'over', 'under', 'out', 'off', 'all', 'not'
]);

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function detectContentType(title: string, summary: string, content: string): string {
  const blob = `${title} ${summary} ${content}`.toLowerCase();
  if (
    /\bobituary\b|\bobit\b|\bin memoriam\b|\bpassed away\b|\bdied at\b|\bdeath of\b/.test(blob)
  ) {
    return 'obituary';
  }
  if (/\bopinion\b|\beditorial\b|\bguest essay\b/.test(blob)) {
    return 'opinion';
  }
  return 'news';
}

function extractFeatures(ctx: ArticleContext): Feature[] {
  const features: Feature[] = [];
  const title = ctx.title || '';
  const summary = ctx.summary || '';
  const content = ctx.content || '';

  features.push({ type: 'source', label: `feed:${ctx.feed_id}`, weight: 0.4 });

  try {
    const domain = new URL(ctx.feed_url).hostname.replace(/^www\./, '');
    features.push({ type: 'source', label: `domain:${domain}`, weight: 0.6 });
  } catch {
    // Ignore invalid feed URL.
  }

  try {
    const categories = JSON.parse(ctx.categories || '[]') as string[];
    for (const c of categories.slice(0, 5)) {
      const token = normalizeToken(c);
      if (token) {
        features.push({ type: 'topic', label: `topic:${token}`, weight: 1.1 });
      }
    }
  } catch {
    // Ignore malformed category payload.
  }

  const contentType = detectContentType(title, summary, content);
  features.push({ type: 'content_type', label: `content_type:${contentType}`, weight: 1.6 });
  if (contentType === 'obituary') {
    features.push({ type: 'negative_filter', label: 'negative_filter:obituary', weight: 2.2 });
  }

  const tokens = tokenize(title).slice(0, TITLE_PHRASE_LIMIT);
  for (const token of tokens) {
    features.push({ type: 'phrase', label: `phrase:${token}`, weight: 0.7 });
  }

  const dedup = new Map<string, Feature>();
  for (const feature of features) {
    dedup.set(`${feature.type}|${feature.label}`, feature);
  }
  return [...dedup.values()];
}

function getArticleContext(articleId: string): ArticleContext | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT a.id, a.title, a.summary, a.content, a.categories, a.feed_id, f.url as feed_url
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ?
  `).get(articleId) as ArticleContext | undefined;
}

function upsertPreference(type: string, label: string, polarity: 'positive' | 'negative', delta: number): void {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare(
    'SELECT id, strength, evidence_count FROM user_preference_memory WHERE type = ? AND label = ? AND polarity = ? ORDER BY strength DESC LIMIT 1'
  ).get(type, label, polarity) as { id: string; strength: number; evidence_count: number } | undefined;

  if (existing) {
    const strength = Math.max(0, Math.min(1, existing.strength + delta));
    db.prepare(
      'UPDATE user_preference_memory SET strength = ?, evidence_count = ?, last_reinforced = ? WHERE id = ?'
    ).run(strength, (existing.evidence_count || 0) + 1, now, existing.id);
    return;
  }

  db.prepare(
    'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), label, type, polarity, Math.max(0.1, Math.min(1, delta)), 1, now, '', now);
}

export function updatePreferenceMemoryFromInteraction(articleId: string, type: InteractionType): void {
  const positiveDelta = type === 'thumbs_up' ? 0.2 : type === 'open' ? 0.05 : type === 'read' ? 0.03 : 0;
  const negativeDelta = type === 'thumbs_down' ? 0.2 : type === 'hide' ? 0.15 : 0;
  if (!positiveDelta && !negativeDelta) return;

  const ctx = getArticleContext(articleId);
  if (!ctx) return;
  const features = extractFeatures(ctx);

  for (const feature of features) {
    if (negativeDelta) {
      upsertPreference(feature.type, feature.label, 'negative', negativeDelta * feature.weight);
    }
    if (positiveDelta) {
      upsertPreference(feature.type, feature.label, 'positive', positiveDelta * feature.weight);
    }
  }
}

export function getPreferenceStateForArticle(articleId: string): PreferenceState {
  const ctx = getArticleContext(articleId);
  if (!ctx) return { adjustment: 0, totalNegativeEvidence: 0 };

  const db = getDb();
  const features = extractFeatures(ctx);
  if (!features.length) return { adjustment: 0, totalNegativeEvidence: 0 };

  let signal = 0;
  let totalNegativeEvidence = 0;

  for (const feature of features) {
    const rows = db.prepare(
      'SELECT polarity, strength, evidence_count FROM user_preference_memory WHERE type = ? AND label = ?'
    ).all(feature.type, feature.label) as { polarity: string; strength: number; evidence_count: number }[];

    for (const row of rows) {
      const contribution = feature.weight * (row.strength || 0);
      if (row.polarity === 'negative') {
        signal -= contribution;
        totalNegativeEvidence += row.evidence_count || 0;
      } else if (row.polarity === 'positive') {
        signal += contribution;
      }
    }
  }

  const adjustment = Math.max(-25, Math.min(25, Math.round(signal * 8)));
  return { adjustment, totalNegativeEvidence };
}

export function applyPreferenceModelToArticle(articleId: string): void {
  const db = getDb();
  const prefState = getPreferenceStateForArticle(articleId);
  const base = 50;
  const score = Math.max(0, Math.min(100, base + prefState.adjustment));
  db.prepare('UPDATE articles SET heuristic_score = ? WHERE id = ?').run(score, articleId);

  const shouldAutoHide = prefState.adjustment <= -18 && prefState.totalNegativeEvidence >= 3;
  if (shouldAutoHide) {
    db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(articleId);
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), articleId, 'hide', Date.now(), '{"auto":true,"reason":"preference_model"}');
  }
}
