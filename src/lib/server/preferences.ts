import { getDb } from '#lib/server/db/index.ts';
import type { InteractionType } from '#lib/server/interactions.ts';
import crypto from 'node:crypto';
import { parseJsonTextArray } from '#lib/server/normalization.ts';
import { refreshCombinedScore } from '#lib/server/scoring.ts';

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

export type PreferenceMemoryDelta = {
  preferenceId: string;
  type: string;
  label: string;
  polarity: 'positive' | 'negative';
  delta: number;
};

type PreferenceUpsertResult = {
  preferenceId: string;
  delta: number;
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
const POSITIVE_QUALITY_SIGNALS = new Set([
  'official_announcement',
  'primary_source',
  'specific_details',
  'technical_depth',
  'data_driven',
  'actionable',
  'hands_on',
  'concrete_update',
  'cited_sources',
]);
const NEGATIVE_QUALITY_SIGNALS = new Set([
  'speculation',
  'rumor',
  'leak',
  'hype',
  'clickbait',
  'seo_filler',
  'opinion_only',
  'future_guessing',
  'thin_rewrite',
  'ad_copy',
]);
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
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<![\p{L}\p{N}])c\+\+(?![\p{L}\p{N}])/gu, 'c_plus_plus')
    .replace(/(?<![\p{L}\p{N}])c#(?![\p{L}\p{N}])/gu, 'c_sharp')
    .replace(/(?<![\p{L}\p{N}])f#(?![\p{L}\p{N}])/gu, 'f_sharp')
    .replace(/(?<![\p{L}\p{N}])\.net(?![\p{L}\p{N}])/gu, 'dotnet')
    .replace(/(?<![\p{L}\p{N}])node\.js(?![\p{L}\p{N}])/gu, 'nodejs')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
}

function normalizeLabel(text: string): string {
  return normalizeToken(text);
}

function parseAuthors(rawAuthor: string): string[] {
  const cleaned = rawAuthor
    .replace(/<[^>]*@[^>]*>/g, ' ')
    .replace(/\([^)]*@[^)]*\)/g, ' ')
    .replace(/^\s*by\s+/i, '')
    .trim();
  if (!cleaned) return [];

  const authors: string[] = [];
  const seen = new Set<string>();
  for (const part of cleaned.split(/\s*(?:,|;)\s*|\s+(?:&|and)\s+/i)) {
    const normalized = normalizeLabel(part);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    authors.push(normalized);
    if (authors.length >= 4) break;
  }
  return authors;
}

function isSignalAllowedForPolarity(
  label: string,
  polarity: 'positive' | 'negative',
): boolean {
  const signal = label.startsWith('signal:')
    ? label.slice('signal:'.length)
    : label;
  if (polarity === 'negative' && POSITIVE_QUALITY_SIGNALS.has(signal)) {
    return false;
  }
  if (polarity === 'positive' && NEGATIVE_QUALITY_SIGNALS.has(signal)) {
    return false;
  }
  return true;
}

function parseJsonStringArray(
  value: string | null | undefined,
  normalizer: (value: string) => string,
  limit: number,
): string[] {
  return parseJsonTextArray(value, limit)
    .map((item) => normalizer(item))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
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
  if (
    /\btutorial\b|\bguide\b|\bhow to\b|\bwalkthrough\b|\bexplainer\b/.test(blob)
  ) {
    return 'tutorial';
  }
  if (
    /\brelease notes?\b|\bchangelog\b|\bwhat'?s new\b|\bversion \d+/.test(blob)
  ) {
    return 'release_note';
  }
  if (/\breview\b|\bhands[- ]on\b|\bfirst look\b|\bpreview\b/.test(blob)) {
    return 'review';
  }
  if (/\binterview\b|\bq&a\b|\bquestions and answers\b/.test(blob)) {
    return 'interview';
  }
  if (
    /\bannouncement\b|\bannounces?\b|\blaunches?\b|\bintroduces?\b|\bdebuts?\b/.test(
      blob,
    )
  ) {
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

  for (const author of parseAuthors(ctx.author || '')) {
    features.push({
      type: 'author',
      label: `author:${author}`,
      weight: 0.65,
    });
  }

  for (const category of parseJsonStringArray(
    ctx.categories || '[]',
    normalizeToken,
    5,
  )) {
    features.push({
      type: 'topic',
      label: `topic:${category}`,
      weight: 1.1,
    });
  }

  for (const topic of parseJsonStringArray(
    ctx.ai_topics || '[]',
    normalizeToken,
    8,
  )) {
    features.push({
      type: 'topic',
      label: `topic:${topic}`,
      weight: 1.5,
    });
  }

  for (const entity of parseJsonStringArray(
    ctx.ai_entities || '[]',
    normalizeToken,
    8,
  )) {
    features.push({
      type: 'entity',
      label: `entity:${entity}`,
      weight: 1.2,
    });
  }

  for (const signal of parseJsonStringArray(
    ctx.ai_signals || '[]',
    normalizeLabel,
    8,
  )) {
    features.push({
      type: 'signal',
      label: `signal:${signal}`,
      weight: SIGNAL_WEIGHTS[signal] || 1.05,
    });
  }

  const contentType =
    normalizeToken(ctx.ai_content_type || '') ||
    detectContentType(title, summary, content);
  if (contentType && contentType !== 'news' && contentType !== 'other') {
    features.push({
      type: 'content_type',
      label: `content_type:${contentType}`,
      weight: 1.8,
    });
  }
  if (contentType === 'obituary') {
    features.push({
      type: 'negative_filter',
      label: 'negative_filter:obituary',
      weight: 2.5,
    });
  }

  // Title phrases are useful for explicit feedback, but implicit reads/open
  // events are intentionally excluded from phrase learning below. This keeps
  // recurring feed boilerplate (for example, "Breakfast links") from
  // dominating the model.
  const tokens = tokenize(title);

  // Single tokens
  for (const token of tokens.slice(0, TITLE_PHRASE_LIMIT)) {
    features.push({ type: 'phrase', label: `phrase:${token}`, weight: 0.35 });
  }

  // Bigrams (2-word phrases)
  const bigrams = extractNGrams(tokens, 2);
  for (const gram of bigrams.slice(0, 5)) {
    features.push({ type: 'phrase', label: `phrase:${gram}`, weight: 0.75 });
  }

  // Trigrams (3-word phrases)
  const trigrams = extractNGrams(tokens, 3);
  for (const gram of trigrams.slice(0, 3)) {
    features.push({ type: 'phrase', label: `phrase:${gram}`, weight: 1.0 });
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
    SELECT a.id, a.title, a.summary, substr(a.content, 1, 8000) AS content,
           a.author, a.categories,
           COALESCE(am.topics, '[]') as ai_topics,
           COALESCE(am.entities, '[]') as ai_entities,
           COALESCE(am.content_type, '') as ai_content_type,
           COALESCE(am.signals, '[]') as ai_signals
    FROM articles a
    LEFT JOIN article_ai_metadata am ON am.article_id = a.id AND am.analysis_status = 'ready'
    WHERE a.id = ?
  `,
    )
    .get(articleId) as ArticleContext | undefined;
}

/** Return normalized preference feature keys for a bounded set of articles. */
export function getPreferenceFeatureKeysForArticles(
  articleIds: string[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const uniqueIds = [...new Set(articleIds)].filter(Boolean);
  const db = getDb();
  // SQLite builds commonly cap bound parameters at 999. Keep each query below
  // that limit even when this helper is reused by a larger maintenance task.
  for (let offset = 0; offset < uniqueIds.length; offset += 400) {
    const ids = uniqueIds.slice(offset, offset + 400);
    if (!ids.length) continue;
    const rows = db
      .prepare(
        `
        SELECT a.id, a.title, a.summary, substr(a.content, 1, 8000) AS content,
               a.author, a.categories,
               COALESCE(am.topics, '[]') AS ai_topics,
               COALESCE(am.entities, '[]') AS ai_entities,
               COALESCE(am.content_type, '') AS ai_content_type,
               COALESCE(am.signals, '[]') AS ai_signals
        FROM articles a
        LEFT JOIN article_ai_metadata am ON am.article_id = a.id AND am.analysis_status = 'ready'
        WHERE a.id IN (${ids.map(() => '?').join(', ')})
      `,
      )
      .all(...ids) as ArticleContext[];

    for (const row of rows) {
      result.set(
        row.id,
        new Set(
          extractFeatures(row).map(
            (feature) => `${feature.type}|${feature.label}`,
          ),
        ),
      );
    }
  }
  return result;
}

function getDecayMultiplier(lastReinforced: number, now = Date.now()): number {
  if (!lastReinforced || !Number.isFinite(lastReinforced)) return 1;
  const ageDays = Math.max(0, (now - lastReinforced) / (24 * 60 * 60 * 1000));
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

export function getDecayedStrength(
  strength: number,
  lastReinforced: number,
): number {
  if (!lastReinforced || !Number.isFinite(lastReinforced)) return strength;
  return Math.max(
    0,
    Math.min(1, strength * getDecayMultiplier(lastReinforced)),
  );
}

function upsertPreference(
  type: string,
  label: string,
  polarity: 'positive' | 'negative',
  delta: number,
): PreferenceUpsertResult {
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
    return { preferenceId: existing.id, delta: strength - decayed };
  }

  const strength = Math.max(0.02, Math.min(1, delta));
  const preferenceId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(preferenceId, label, type, polarity, strength, 1, now, '', now);
  return { preferenceId, delta: strength };
}

export function updatePreferenceMemoryFromInteraction(
  articleId: string,
  type: InteractionType,
  capturedDeltas?: PreferenceMemoryDelta[],
): string[] {
  const positiveDelta =
    type === 'boost'
      ? 0.45
      : type === 'thumbs_up'
        ? 0.24
        : type === 'save'
          ? 0.28
          : type === 'open'
            ? 0.03
            : type === 'read'
              ? 0.01
              : 0;
  const negativeDelta =
    type === 'thumbs_down' ? 0.3 : type === 'hide' ? 0.04 : 0;
  if (!positiveDelta && !negativeDelta) return [];

  const ctx = getArticleContext(articleId);
  if (!ctx) return [];
  const features = extractFeatures(ctx);
  const isImplicitFeedback = type === 'open' || type === 'read';
  const changedFeatureKeys: string[] = [];

  for (const feature of features) {
    if (isImplicitFeedback && feature.type === 'phrase') continue;
    if (feature.type === 'signal') {
      if (
        negativeDelta > 0 &&
        positiveDelta === 0 &&
        !isSignalAllowedForPolarity(feature.label, 'negative')
      ) {
        continue;
      }
      if (
        positiveDelta > 0 &&
        negativeDelta === 0 &&
        !isSignalAllowedForPolarity(feature.label, 'positive')
      ) {
        continue;
      }
    }
    changedFeatureKeys.push(`${feature.type}|${feature.label}`);
    if (negativeDelta) {
      const update = upsertPreference(
        feature.type,
        feature.label,
        'negative',
        negativeDelta * feature.weight,
      );
      capturedDeltas?.push({
        preferenceId: update.preferenceId,
        type: feature.type,
        label: feature.label,
        polarity: 'negative',
        delta: update.delta,
      });
    }
    if (positiveDelta) {
      const update = upsertPreference(
        feature.type,
        feature.label,
        'positive',
        positiveDelta * feature.weight,
      );
      capturedDeltas?.push({
        preferenceId: update.preferenceId,
        type: feature.type,
        label: feature.label,
        polarity: 'positive',
        delta: update.delta,
      });
    }
  }
  return changedFeatureKeys;
}

/** Remove the preference contribution captured on one operation's interaction. */
export function reversePreferenceMemoryDeltas(
  value: unknown,
  interactionTimestamp: number,
): void {
  if (!Array.isArray(value)) return;

  const db = getDb();
  const now = Date.now();
  const ageDays = Math.max(
    0,
    (now - interactionTimestamp) / (24 * 60 * 60 * 1000),
  );
  const decayFactor = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
  const find = db.prepare(
    `SELECT id, strength, evidence_count, last_reinforced
     FROM user_preference_memory
     WHERE id = ? AND type = ? AND label = ? AND polarity = ?`,
  );
  const remove = db.prepare('DELETE FROM user_preference_memory WHERE id = ?');
  const update = db.prepare(
    `UPDATE user_preference_memory
     SET strength = ?, evidence_count = ?, last_reinforced = ? WHERE id = ?`,
  );

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const delta = item as Partial<PreferenceMemoryDelta>;
    if (
      typeof delta.preferenceId !== 'string' ||
      typeof delta.type !== 'string' ||
      typeof delta.label !== 'string' ||
      (delta.polarity !== 'positive' && delta.polarity !== 'negative') ||
      typeof delta.delta !== 'number' ||
      !Number.isFinite(delta.delta) ||
      delta.delta < 0
    ) {
      continue;
    }

    const existing = find.get(
      delta.preferenceId,
      delta.type,
      delta.label,
      delta.polarity,
    ) as
      | {
          id: string;
          strength: number;
          evidence_count: number;
          last_reinforced: number;
        }
      | undefined;
    if (!existing) continue;

    const remainingEvidence = Math.max(0, existing.evidence_count - 1);
    const currentStrength = getDecayedStrength(
      existing.strength || 0,
      existing.last_reinforced,
    );
    const remainingStrength = Math.max(
      0,
      currentStrength - delta.delta * decayFactor,
    );
    if (remainingEvidence === 0 || remainingStrength === 0) {
      remove.run(existing.id);
    } else {
      update.run(remainingStrength, remainingEvidence, now, existing.id);
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

  const now = Date.now();
  const byFeature = new Map<
    string,
    {
      posContribution: number;
      negContribution: number;
      posDecayedEvidence: number;
      negDecayedEvidence: number;
    }
  >();

  for (const row of rows) {
    const key = `${row.type}|${row.label}`;
    const weight = featureWeightMap.get(key) || 0;
    if (!weight) continue;
    const decayMultiplier = getDecayMultiplier(row.last_reinforced || 0, now);
    const decayedStrength = Math.max(
      0,
      Math.min(1, Number(row.strength || 0) * decayMultiplier),
    );
    const decayedEvidence =
      Math.max(0, Number(row.evidence_count || 0)) * decayMultiplier;
    const contribution = weight * decayedStrength;
    const current = byFeature.get(key) || {
      posContribution: 0,
      negContribution: 0,
      posDecayedEvidence: 0,
      negDecayedEvidence: 0,
    };
    if (row.polarity === 'negative') {
      current.negContribution += contribution;
      current.negDecayedEvidence += decayedEvidence;
    } else if (row.polarity === 'positive') {
      current.posContribution += contribution;
      current.posDecayedEvidence += decayedEvidence;
    }
    byFeature.set(key, current);
  }

  let signal = 0;
  let totalNegativeEvidence = 0;
  for (const item of byFeature.values()) {
    signal += item.posContribution - item.negContribution;
    if (item.negContribution > item.posContribution) {
      const effectiveNegativeEvidence = Math.max(
        0,
        item.negDecayedEvidence - item.posDecayedEvidence,
      );
      totalNegativeEvidence = Math.max(
        totalNegativeEvidence,
        effectiveNegativeEvidence,
      );
    }
  }

  const adjustment = Math.max(-25, Math.min(25, Math.round(signal * 8)));
  return { adjustment, totalNegativeEvidence };
}

const AUTO_HIDE_MIN_NEGATIVE_EVIDENCE = 2.5;

function shouldAutoHideFromPreferenceState(
  prefState: PreferenceState,
): boolean {
  return (
    prefState.adjustment <= -18 &&
    prefState.totalNegativeEvidence >= AUTO_HIDE_MIN_NEGATIVE_EVIDENCE
  );
}

export function applyPreferenceModelToArticle(articleId: string): void {
  const db = getDb();
  updateHeuristicScore(articleId);
  const prefState = getPreferenceStateForArticle(articleId);

  if (shouldAutoHideFromPreferenceState(prefState)) {
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

export function reconcileAutoHiddenArticles(): number {
  const db = getDb();
  const candidates = db
    .prepare(
      `
      SELECT a.id
      FROM articles a
      WHERE a.hidden = 1
        AND COALESCE(a.rejected, 0) = 0
        AND COALESCE(a.thumbs_down, 0) = 0
        AND EXISTS (
          SELECT 1 FROM user_interactions ui
          WHERE ui.article_id = a.id
            AND ui.interaction_type = 'hide'
            AND COALESCE(
              json_extract(
                CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
                '$.auto'
              ),
              0
            ) = 1
            AND json_extract(
              CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
              '$.reason'
            ) = 'preference_model'
            AND COALESCE(
              json_extract(
                CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
                '$.undone_at'
              ),
              0
            ) = 0
        )
    `,
    )
    .all() as Array<{ id: string }>;

  if (!candidates.length) return 0;

  const now = Date.now();
  const unhideArticle = db.prepare(
    'UPDATE articles SET hidden = 0 WHERE id = ?',
  );
  const markAutoHideUndone = db.prepare(
    `UPDATE user_interactions
     SET metadata = json_set(
       CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
       '$.undone_at',
       ?
     )
     WHERE article_id = ?
       AND interaction_type = 'hide'
       AND COALESCE(
         json_extract(
           CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
           '$.auto'
         ),
         0
       ) = 1
       AND json_extract(
         CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
         '$.reason'
       ) = 'preference_model'
       AND COALESCE(
         json_extract(
           CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
           '$.undone_at'
         ),
         0
       ) = 0`,
  );

  let unhidden = 0;
  for (const { id } of candidates) {
    if (hasExplicitHide(id)) continue;
    const prefState = getPreferenceStateForArticle(id);
    if (shouldAutoHideFromPreferenceState(prefState)) continue;
    unhideArticle.run(id);
    markAutoHideUndone.run(now, id);
    unhidden += 1;
  }
  return unhidden;
}

export function hasExplicitHide(articleId: string): boolean {
  const db = getDb();
  const state = db
    .prepare(
      `
      SELECT interaction_type
      FROM user_interactions
      WHERE article_id = ?
        AND interaction_type IN ('hide', 'unhide', 'restore')
        AND (interaction_type != 'hide' OR json_extract(
          CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
          '$.auto'
        ) IS NULL)
        AND COALESCE(json_extract(
          CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
          '$.undone_at'
        ), 0) = 0
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `,
    )
    .get(articleId) as { interaction_type: string } | undefined;

  return state?.interaction_type === 'hide';
}

export function calculateHeuristicScore(articleId: string): number {
  const db = getDb();
  const article = db
    .prepare(
      'SELECT read, saved, thumbs_up, thumbs_down FROM articles WHERE id = ?',
    )
    .get(articleId) as
    | {
        read: number;
        saved: number;
        thumbs_up: number;
        thumbs_down: number;
      }
    | undefined;

  if (!article) return 50;

  const preferenceState = getPreferenceStateForArticle(articleId);
  const score =
    50 +
    (article.read ? 2 : 0) +
    (article.saved ? 10 : 0) +
    (article.thumbs_up ? 25 : 0) -
    (article.thumbs_down ? 20 : 0) -
    (hasExplicitHide(articleId) ? 10 : 0) +
    preferenceState.adjustment;

  return Math.max(0, Math.min(100, score));
}

export function updateHeuristicScore(articleId: string): void {
  const db = getDb();
  const score = calculateHeuristicScore(articleId);
  db.prepare('UPDATE articles SET heuristic_score = ? WHERE id = ?').run(
    score,
    articleId,
  );
  refreshCombinedScore(articleId);
}

export function rebuildArticleHeuristicScores(): number {
  const db = getDb();
  const articleIds = db.prepare('SELECT id FROM articles').all() as Array<{
    id: string;
  }>;
  const rebuild = db.transaction(() => {
    for (const article of articleIds) updateHeuristicScore(article.id);
  });
  rebuild();
  return articleIds.length;
}
