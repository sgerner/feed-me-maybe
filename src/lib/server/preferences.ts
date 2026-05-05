import { getDb } from '$lib/server/db';
import type { InteractionType } from '$lib/server/interactions';
import crypto from 'node:crypto';

type ArticleContext = {
  id: string;
  title: string;
  summary: string;
  content: string;
  author: string;
  categories: string;
  ai_topics: string;
  ai_entities: string;
  ai_content_type: string;
  ai_signals: string;
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

const TITLE_PHRASE_LIMIT = 8;
const DECAY_HALF_LIFE_DAYS = 45;
const SIGNAL_WEIGHTS: Record<string, number> = {
  official_announcement: 1.25,
  primary_source: 1.25,
  specific_details: 1.1,
  technical_depth: 1.25,
  data_driven: 1.2,
  actionable: 1.05,
  hands_on: 1.1,
  concrete_update: 1.1,
  cited_sources: 1.15,
  speculation: 1.35,
  rumor: 1.45,
  leak: 1.4,
  hype: 1.2,
  clickbait: 1.3,
  seo_filler: 1.1,
  opinion_only: 1.2,
  future_guessing: 1.3,
  thin_rewrite: 1.1,
  ad_copy: 1.1,
};
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
  'also',
  'just',
  'more',
  'than',
  'some',
  'very',
]);

function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
}

function parseJsonStringArray(
  value: string | null | undefined,
  normalizer: (value: string) => string,
  limit: number,
): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const normalized = normalizer(String(item || ''));
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function extractNGrams(tokens: string[], n: number): string[] {
  const ngrams: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n);
    // Sort tokens to allow order-independent matching (e.g. "open source" == "source open")
    gram.sort();
    ngrams.push(gram.join(':'));
  }
  return ngrams;
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
  if (/\bpodcast\b|\bepisode\b|\baudio\b/.test(blob)) {
    return 'podcast';
  }
  if (/\bvideo\b|\bwatch\b|\bstream\b/.test(blob)) {
    return 'video';
  }
  if (/\btutorial\b|\bguide\b|\bhow to\b|\bwalkthrough\b|\bexplainer\b/.test(blob)) {
    return 'tutorial';
  }
  if (/\brelease notes?\b|\bchangelog\b|\bwhat'?s new\b|\bversion \d+/.test(blob)) {
    return 'release_note';
  }
  if (/\breview\b|\bhands[- ]on\b|\bfirst look\b|\bpreview\b/.test(blob)) {
    return 'review';
  }
  if (/\binterview\b|\bq&a\b|\bquestions and answers\b/.test(blob)) {
    return 'interview';
  }
  if (/\bannouncement\b|\bannounces?\b|\blaunches?\b|\bintroduces?\b|\bdebuts?\b/.test(blob)) {
    return 'announcement';
  }
  if (/\banalysis\b|\bdeep dive\b|\bexplainer\b/.test(blob)) {
    return 'analysis';
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

  const author = normalizeLabel(ctx.author || '');
  if (author) {
    features.push({
      type: 'author',
      label: `author:${author}`,
      weight: 0.65,
    });
  }

  for (const category of parseJsonStringArray(ctx.categories || '[]', normalizeToken, 5)) {
    features.push({
      type: 'topic',
      label: `topic:${category}`,
      weight: 1.1,
    });
  }

  for (const topic of parseJsonStringArray(ctx.ai_topics || '[]', normalizeToken, 8)) {
    features.push({
      type: 'topic',
      label: `topic:${topic}`,
      weight: 1.5,
    });
  }

  for (const entity of parseJsonStringArray(ctx.ai_entities || '[]', normalizeToken, 8)) {
    features.push({
      type: 'entity',
      label: `entity:${entity}`,
      weight: 1.2,
    });
  }

  for (const signal of parseJsonStringArray(ctx.ai_signals || '[]', normalizeLabel, 8)) {
    features.push({
      type: 'signal',
      label: `signal:${signal}`,
      weight: SIGNAL_WEIGHTS[signal] || 1.05,
    });
  }

  const contentType =
    normalizeToken(ctx.ai_content_type || '') ||
    detectContentType(title, summary, content);
  features.push({
    type: 'content_type',
    label: `content_type:${contentType}`,
    weight: 1.8,
  });
  if (contentType === 'obituary') {
    features.push({
      type: 'negative_filter',
      label: 'negative_filter:obituary',
      weight: 2.5,
    });
  }

  // Phrase extraction with N-grams
  const tokens = tokenize(title);

  // Single tokens
  for (const token of tokens.slice(0, TITLE_PHRASE_LIMIT)) {
    features.push({ type: 'phrase', label: `phrase:${token}`, weight: 0.6 });
  }

  // Bigrams (2-word phrases)
  const bigrams = extractNGrams(tokens, 2);
  for (const gram of bigrams.slice(0, 5)) {
    features.push({ type: 'phrase', label: `phrase:${gram}`, weight: 1.3 });
  }

  // Trigrams (3-word phrases)
  const trigrams = extractNGrams(tokens, 3);
  for (const gram of trigrams.slice(0, 3)) {
    features.push({ type: 'phrase', label: `phrase:${gram}`, weight: 1.6 });
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
    SELECT a.id, a.title, a.summary, a.content, a.author, a.categories,
           COALESCE(am.topics, '[]') as ai_topics,
           COALESCE(am.entities, '[]') as ai_entities,
           COALESCE(am.content_type, '') as ai_content_type,
           COALESCE(am.signals, '[]') as ai_signals
    FROM articles a
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
    Math.max(0.02, Math.min(1, delta)),
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
        ? 0.03
        : type === 'read'
          ? 0.02
          : 0;
  const negativeDelta =
    type === 'thumbs_down' ? 0.2 : type === 'hide' ? 0.08 : 0;
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
