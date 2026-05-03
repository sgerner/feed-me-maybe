import { getDb } from '$lib/server/db';
import type { InteractionType } from '$lib/server/interactions';
import type { ArticleScore } from '$lib/server/ai/types';
import crypto from 'node:crypto';

type ArticleContext = {
  id: string;
  title: string;
  summary: string;
  content: string;
  categories: string;
  feed_id: string;
  feed_url: string;
  ai_topics: string;
  ai_entities: string;
  ai_content_type: string;
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
const DECAY_HALF_LIFE_DAYS = 45;
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'your',
  'have',
  'has',
  'are',
  'was',
  'were',
  'will',
  'would',
  'could',
  'should',
  'about',
  'into',
  'their',
  'there',
  'after',
  'before',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'how',
  'its',
  'his',
  'her',
  'our',
  'you',
  'new',
  'over',
  'under',
  'out',
  'off',
  'all',
  'not',
]);

function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function detectContentType(
  title: string,
  summary: string,
  content: string,
): string {
  const blob = `${title} ${summary} ${content}`.toLowerCase();
  if (
    /\bobituary\b|\bobit\b|\bin memoriam\b|\bpassed away\b|\bdied at\b|\bdeath of\b/.test(
      blob,
    )
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

  try {
    const aiTopics = JSON.parse(ctx.ai_topics || '[]') as string[];
    for (const topic of aiTopics.slice(0, 5)) {
      const token = normalizeToken(topic);
      if (token) {
        features.push({ type: 'topic', label: `topic:${token}`, weight: 1.4 });
      }
    }
  } catch {
    // Ignore malformed AI topic payload.
  }

  try {
    const aiEntities = JSON.parse(ctx.ai_entities || '[]') as string[];
    for (const entity of aiEntities.slice(0, 5)) {
      const token = normalizeToken(entity);
      if (token) {
        features.push({
          type: 'entity',
          label: `entity:${token}`,
          weight: 1.0,
        });
      }
    }
  } catch {
    // Ignore malformed AI entity payload.
  }

  const contentType =
    normalizeToken(ctx.ai_content_type || '') ||
    detectContentType(title, summary, content);
  features.push({
    type: 'content_type',
    label: `content_type:${contentType}`,
    weight: 1.6,
  });
  if (contentType === 'obituary') {
    features.push({
      type: 'negative_filter',
      label: 'negative_filter:obituary',
      weight: 2.2,
    });
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
  return db
    .prepare(
      `
    SELECT a.id, a.title, a.summary, a.content, a.categories, a.feed_id, f.url as feed_url,
           COALESCE(am.topics, '[]') as ai_topics,
           COALESCE(am.entities, '[]') as ai_entities,
           COALESCE(am.content_type, '') as ai_content_type
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_ai_metadata am ON am.article_id = a.id
    WHERE a.id = ?
  `,
    )
    .get(articleId) as ArticleContext | undefined;
}

function getDecayedStrength(strength: number, lastReinforced: number): number {
  if (!lastReinforced || !Number.isFinite(lastReinforced)) return strength;
  const ageDays = Math.max(
    0,
    (Date.now() - lastReinforced) / (24 * 60 * 60 * 1000),
  );
  const decayFactor = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
  return Math.max(0, Math.min(1, strength * decayFactor));
}

function upsertPreference(
  type: string,
  label: string,
  polarity: 'positive' | 'negative',
  delta: number,
): void {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare(
      'SELECT id, strength, evidence_count, last_reinforced FROM user_preference_memory WHERE type = ? AND label = ? AND polarity = ? ORDER BY strength DESC LIMIT 1',
    )
    .get(type, label, polarity) as
    | {
        id: string;
        strength: number;
        evidence_count: number;
        last_reinforced: number;
      }
    | undefined;

  if (existing) {
    const decayed = getDecayedStrength(
      existing.strength || 0,
      existing.last_reinforced,
    );
    const strength = Math.max(0, Math.min(1, decayed + delta));
    db.prepare(
      'UPDATE user_preference_memory SET strength = ?, evidence_count = ?, last_reinforced = ? WHERE id = ?',
    ).run(strength, (existing.evidence_count || 0) + 1, now, existing.id);
    return;
  }

  db.prepare(
    'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    crypto.randomUUID(),
    label,
    type,
    polarity,
    Math.max(0.1, Math.min(1, delta)),
    1,
    now,
    '',
    now,
  );
}

export function updatePreferenceMemoryFromInteraction(
  articleId: string,
  type: InteractionType,
): void {
  const positiveDelta =
    type === 'thumbs_up'
      ? 0.2
      : type === 'open'
        ? 0.05
        : type === 'read'
          ? 0.03
          : 0;
  const negativeDelta =
    type === 'thumbs_down' ? 0.2 : type === 'hide' ? 0.15 : 0;
  if (!positiveDelta && !negativeDelta) return;

  const ctx = getArticleContext(articleId);
  if (!ctx) return;
  const features = extractFeatures(ctx);

  for (const feature of features) {
    if (negativeDelta) {
      upsertPreference(
        feature.type,
        feature.label,
        'negative',
        negativeDelta * feature.weight,
      );
    }
    if (positiveDelta) {
      upsertPreference(
        feature.type,
        feature.label,
        'positive',
        positiveDelta * feature.weight,
      );
    }
  }
}

export function getPreferenceStateForArticle(
  articleId: string,
): PreferenceState {
  const ctx = getArticleContext(articleId);
  if (!ctx) return { adjustment: 0, totalNegativeEvidence: 0 };

  const db = getDb();
  const features = extractFeatures(ctx);
  if (!features.length) return { adjustment: 0, totalNegativeEvidence: 0 };

  let signal = 0;
  let totalNegativeEvidence = 0;

  const placeholders = features.map(() => '(?, ?)').join(', ');
  const params = features.flatMap((feature) => [feature.type, feature.label]);
  const rows = db
    .prepare(
      `
    SELECT type, label, polarity, strength, evidence_count, last_reinforced
    FROM user_preference_memory
    WHERE (type, label) IN (${placeholders})
  `,
    )
    .all(...params) as Array<{
    type: string;
    label: string;
    polarity: string;
    strength: number;
    evidence_count: number;
    last_reinforced: number;
  }>;

  const featureWeightMap = new Map<string, number>();
  for (const feature of features) {
    featureWeightMap.set(`${feature.type}|${feature.label}`, feature.weight);
  }

  for (const row of rows) {
    const weight = featureWeightMap.get(`${row.type}|${row.label}`) || 0;
    if (!weight) continue;
    const decayedStrength = getDecayedStrength(
      row.strength || 0,
      row.last_reinforced || 0,
    );
    const contribution = weight * decayedStrength;
    if (row.polarity === 'negative') {
      signal -= contribution;
      totalNegativeEvidence += row.evidence_count || 0;
    } else if (row.polarity === 'positive') {
      signal += contribution;
    }
  }

  const adjustment = Math.max(-25, Math.min(25, Math.round(signal * 8)));
  return { adjustment, totalNegativeEvidence };
}

export function incorporateAiClassificationIntoMemory(
  articleId: string,
  classification: Partial<ArticleScore>,
): void {
  const topics = (classification.topics || [])
    .map((t) => normalizeToken(String(t)))
    .filter(Boolean)
    .slice(0, 5);
  const entities = (classification.entities || [])
    .map((e) => normalizeToken(String(e)))
    .filter(Boolean)
    .slice(0, 5);
  const contentType = normalizeToken(String(classification.contentType || ''));

  // Seed weak neutral-positive priors so future interactions have richer feature context.
  for (const topic of topics) {
    upsertPreference('topic', `topic:${topic}`, 'positive', 0.01);
  }
  for (const entity of entities) {
    upsertPreference('entity', `entity:${entity}`, 'positive', 0.005);
  }
  if (contentType) {
    upsertPreference(
      'content_type',
      `content_type:${contentType}`,
      'positive',
      0.01,
    );
  }

  // If AI identifies obituary-like content, pre-seed a weak negative filter.
  if (
    contentType === 'obituary' ||
    topics.includes('obituary') ||
    topics.includes('obituaries')
  ) {
    upsertPreference(
      'negative_filter',
      'negative_filter:obituary',
      'negative',
      0.02,
    );
  }

  // Keep article score aligned with new memory.
  applyPreferenceModelToArticle(articleId);
}

export function applyPreferenceModelToArticle(articleId: string): void {
  const db = getDb();
  const prefState = getPreferenceStateForArticle(articleId);
  const base = 50;
  const score = Math.max(0, Math.min(100, base + prefState.adjustment));
  db.prepare('UPDATE articles SET heuristic_score = ? WHERE id = ?').run(
    score,
    articleId,
  );

  const shouldAutoHide =
    prefState.adjustment <= -18 && prefState.totalNegativeEvidence >= 3;
  if (shouldAutoHide) {
    db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(articleId);
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      crypto.randomUUID(),
      articleId,
      'hide',
      Date.now(),
      '{"auto":true,"reason":"preference_model"}',
    );
  }
}
