import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import { getConfiguredAiClient } from '$lib/server/ai/runtime';
import {
  WEEKLY_DIGEST_SYSTEM_PROMPT,
  buildWeeklyDigestPrompt,
  type WeeklyDigestArticleContext,
} from '$lib/server/ai/digest-prompts';
import type { FeedArticleRow } from '$lib/server/feed/articles';
import { rankingOrderExpression } from '$lib/server/ranking';

export const WEEKLY_DIGEST_LIMIT = 60;
export const WEEKLY_DIGEST_WINDOW_DAYS = 7;
export const CALM_BRIEFING_MIN_DAYS = 1;
export const CALM_BRIEFING_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_DIGEST_CACHE_KEY = 'weekly_digest_cache';
const CALM_BRIEFING_HISTORY_KEY = 'calm_daily_briefing_history';
const CALM_BRIEFING_HISTORY_LIMIT = 12;

export type WeeklyDigestOptions = {
  now?: number;
  windowDays?: number;
  forceRefresh?: boolean;
};

export type DigestQuery = {
  windowDays: number;
  forceRefresh: boolean;
};

export function parseDigestQuery(url: URL): DigestQuery {
  const rawDays =
    url.searchParams.get('days') || url.searchParams.get('windowDays');
  const windowDays =
    rawDays === null || rawDays === ''
      ? WEEKLY_DIGEST_WINDOW_DAYS
      : Number(rawDays);
  if (
    !Number.isInteger(windowDays) ||
    windowDays < CALM_BRIEFING_MIN_DAYS ||
    windowDays > CALM_BRIEFING_MAX_DAYS
  ) {
    throw new Error(
      `days must be an integer from ${CALM_BRIEFING_MIN_DAYS} to ${CALM_BRIEFING_MAX_DAYS}`,
    );
  }

  const refresh = url.searchParams.get('refresh');
  return {
    windowDays,
    forceRefresh: refresh === '1' || refresh === 'true',
  };
}

type DigestArticleRow = FeedArticleRow & {
  rejected?: number;
};

export type DigestCluster = {
  id: string;
  representativeId: string;
  articleIds: string[];
  feedIds: string[];
};

export type DigestInclusionCounts = {
  windowArticles: number;
  eligibleArticles: number;
  excludedArticles: number;
  excludedThumbsDown: number;
  excludedRejected: number;
  excludedHiddenUnread: number;
  visibleUnread: number;
  hiddenRead: number;
  read: number;
  unread: number;
  saved: number;
  duplicateArticles: number;
  deduplicatedArticles: number;
};

type WeeklyDigestRawTheme = {
  name: string;
  summary: string;
  articleIds: string[];
};

type WeeklyDigestRawStory = {
  articleId: string;
  reason: string;
  status?: 'new' | 'ongoing';
  uncertainty?: string;
};

export type WeeklyDigestRaw = {
  headline: string;
  summary: string;
  takeaways: string[];
  themes: WeeklyDigestRawTheme[];
  topStories: WeeklyDigestRawStory[];
  missedStories: WeeklyDigestRawStory[];
  topSignal?: WeeklyDigestRawStory[];
  worthYourTime?: WeeklyDigestRawStory[];
  whatChanged?: WeeklyDigestRawStory[];
  uncertainty?: string[];
};

export type WeeklyDigestTheme = {
  name: string;
  summary: string;
  articles: FeedArticleRow[];
};

export type WeeklyDigestStory = {
  article: FeedArticleRow;
  reason: string;
  status: 'new' | 'ongoing';
  uncertainty?: string;
  sourceCount: number;
  relatedArticleIds: string[];
};

export type CalmDailyBriefing = {
  headline: string;
  summary: string;
  topSignal: WeeklyDigestStory[];
  worthYourTime: WeeklyDigestStory[];
  whatChanged: WeeklyDigestStory[];
  uncertainty: string[];
};

export type DigestHistoryEntry = {
  generatedAt: number;
  windowDays: number;
  headline: string;
  totalArticles: number;
  deduplicatedArticles: number;
  signature: string;
};

export type WeeklyDigestStats = {
  totalArticles: number;
  totalFeeds: number;
  unreadArticles: number;
  savedArticles: number;
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
  cacheHit: boolean;
  aiEnabled: boolean;
  windowDays: number;
};

export type WeeklyDigestResult = WeeklyDigestStats & {
  headline: string;
  summary: string;
  takeaways: string[];
  themes: WeeklyDigestTheme[];
  topStories: WeeklyDigestStory[];
  missedStories: WeeklyDigestStory[];
  activeFeeds: Array<{ title: string; count: number }>;
  allArticles: FeedArticleRow[];
  totalPages: number;
  limit: number;
  briefing: CalmDailyBriefing;
  inclusionCounts: DigestInclusionCounts;
  clusters: DigestCluster[];
  history: DigestHistoryEntry[];
  deduplicatedArticles: number;
};

type DigestCachePayload = {
  signature: string;
  generatedAt: number;
  windowDays: number;
  raw: WeeklyDigestRaw;
};

function buildFeedArticleSelect(): string {
  return `
    SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url, a.categories,
           a.published_at, a.fetched_at, a.read, a.saved, a.hidden, a.thumbs_up, a.thumbs_down,
           a.rejected,
           a.heuristic_score, a.combined_score,
           f.title as feed_title, f.url as feed_url, f.open_mode as feed_open_mode
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
  `;
}

function scoreArticle(article: FeedArticleRow): number {
  const combined =
    article.combined_score && article.combined_score > 0
      ? article.combined_score
      : (article.heuristic_score ?? 0);
  const published = article.published_at ?? article.fetched_at ?? 0;
  return combined * 1000 + published;
}

function getArticleTime(article: FeedArticleRow): number {
  return article.published_at ?? article.fetched_at ?? 0;
}

function normalizeWindowDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return WEEKLY_DIGEST_WINDOW_DAYS;
  return Math.min(
    CALM_BRIEFING_MAX_DAYS,
    Math.max(CALM_BRIEFING_MIN_DAYS, Math.round(value as number)),
  );
}

function getOptions(
  input: number | WeeklyDigestOptions | undefined,
): Required<WeeklyDigestOptions> {
  if (typeof input === 'number') {
    return {
      now: input,
      windowDays: WEEKLY_DIGEST_WINDOW_DAYS,
      forceRefresh: false,
    };
  }

  return {
    now: input?.now ?? Date.now(),
    windowDays: normalizeWindowDays(input?.windowDays),
    forceRefresh: input?.forceRefresh ?? false,
  };
}

function cacheKey(windowDays: number): string {
  return windowDays === WEEKLY_DIGEST_WINDOW_DAYS
    ? WEEKLY_DIGEST_CACHE_KEY
    : `${WEEKLY_DIGEST_CACHE_KEY}:${windowDays}`;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#038;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value).trim();
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'value', 'label', 'name', 'summary', 'reason']) {
    const nested = toText(record[key]);
    if (nested) return nested;
  }

  return '';
}

function clipText(value: unknown, limit: number): string {
  const text = stripHtml(toText(value));
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

const DEDUPE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'after',
  'how',
  'new',
  'says',
  'what',
  'why',
]);

function canonicalArticleUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|src$|fbclid$|gclid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/$/, '');
  }
}

function articleTitleTokens(title: string): Set<string> {
  return new Set(
    normalizeKeyword(title)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !DEDUPE_STOP_WORDS.has(token)),
  );
}

function relatedCoverage(
  article: FeedArticleRow,
  candidate: FeedArticleRow,
): boolean {
  if (canonicalArticleUrl(article.url) === canonicalArticleUrl(candidate.url))
    return true;

  const left = articleTitleTokens(article.title);
  const right = articleTitleTokens(candidate.title);
  if (left.size < 3 || right.size < 3) return false;

  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const shorter = Math.min(left.size, right.size);
  return (
    intersection >= 3 &&
    (intersection / union >= 0.62 || intersection / shorter >= 0.8)
  );
}

export function deduplicateDigestArticles(articles: FeedArticleRow[]): {
  representatives: FeedArticleRow[];
  clusters: DigestCluster[];
} {
  const ordered = [...articles].sort(
    (a, b) => scoreArticle(b) - scoreArticle(a),
  );
  const representatives: FeedArticleRow[] = [];
  const clusters: DigestCluster[] = [];

  for (const article of ordered) {
    const cluster = clusters.find((item) => {
      const representative = representatives.find(
        (candidate) => candidate.id === item.representativeId,
      );
      return representative ? relatedCoverage(representative, article) : false;
    });

    if (cluster) {
      cluster.articleIds.push(article.id);
      if (!cluster.feedIds.includes(article.feed_id))
        cluster.feedIds.push(article.feed_id);
      continue;
    }

    representatives.push(article);
    clusters.push({
      id: article.id,
      representativeId: article.id,
      articleIds: [article.id],
      feedIds: [article.feed_id],
    });
  }

  return { representatives, clusters };
}

function clusterLookup(clusters: DigestCluster[]): Map<string, DigestCluster> {
  const result = new Map<string, DigestCluster>();
  for (const cluster of clusters) {
    for (const articleId of cluster.articleIds) result.set(articleId, cluster);
  }
  return result;
}

function isValidThemeText(value: unknown): boolean {
  const text = clipText(value, 120);
  if (!text) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount >= 2 && wordCount <= 3 && !/^object object$/i.test(text);
}

function resolveTakeaways(
  takeaways: unknown,
  themes: WeeklyDigestRawTheme[],
): string[] {
  const validThemes = themes.filter((theme) => isValidThemeText(theme.name));
  const items = Array.isArray(takeaways)
    ? takeaways
        .map((item) => clipText(item, 180))
        .filter((item) => item.length > 0 && !/^object object$/i.test(item))
        .slice(0, 5)
    : [];

  if (items.length > 0 && validThemes.length === themes.length) return items;

  return validThemes
    .slice(0, 3)
    .map((theme) => `${theme.name}: ${theme.summary}`)
    .filter((item) => item.length > 0);
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => toText(item)).filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatWindowLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
}

function hashArticles(
  articles: FeedArticleRow[],
  windowStart: number,
  windowDays: number,
): string {
  const payload = articles
    .map((article) =>
      [
        article.id,
        article.feed_id,
        article.title,
        article.summary,
        article.read,
        article.saved,
        article.hidden,
        (article as DigestArticleRow).rejected ?? '',
        article.thumbs_up,
        article.thumbs_down,
        article.published_at ?? '',
        article.fetched_at ?? '',
        article.heuristic_score ?? '',
        article.combined_score ?? '',
      ].join('|'),
    )
    .join('||');

  return crypto
    .createHash('sha256')
    .update(`${windowStart}:${windowDays}::${payload}`)
    .digest('hex');
}

function loadCache(
  db: ReturnType<typeof getDb>,
  key: string,
): DigestCachePayload | null {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;

  if (!row?.value) return null;

  try {
    return JSON.parse(row.value) as DigestCachePayload;
  } catch {
    return null;
  }
}

function saveCache(
  db: ReturnType<typeof getDb>,
  key: string,
  cache: DigestCachePayload,
): void {
  db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(cache), Date.now());
}

function loadHistory(db: ReturnType<typeof getDb>): DigestHistoryEntry[] {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(CALM_BRIEFING_HISTORY_KEY) as { value: string } | undefined;
  if (!row?.value) return [];

  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is DigestHistoryEntry =>
        Boolean(item && typeof item === 'object'),
      )
      .map((item) => ({
        generatedAt: Number(item.generatedAt) || 0,
        windowDays: normalizeWindowDays(Number(item.windowDays)),
        headline: clipText(item.headline, 100) || 'Calm Daily Briefing',
        totalArticles: Math.max(0, Number(item.totalArticles) || 0),
        deduplicatedArticles: Math.max(
          0,
          Number(item.deduplicatedArticles) || 0,
        ),
        signature: typeof item.signature === 'string' ? item.signature : '',
      }))
      .filter((item) => item.generatedAt > 0)
      .slice(0, CALM_BRIEFING_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(
  db: ReturnType<typeof getDb>,
  entry: DigestHistoryEntry,
): DigestHistoryEntry[] {
  const history = [
    entry,
    ...loadHistory(db).filter((item) => item.signature !== entry.signature),
  ].slice(0, CALM_BRIEFING_HISTORY_LIMIT);
  db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(CALM_BRIEFING_HISTORY_KEY, JSON.stringify(history), Date.now());
  return history;
}

function normalizeStoryStatus(value: unknown): 'new' | 'ongoing' | undefined {
  const status = toText(value).toLowerCase();
  return status === 'new' || status === 'ongoing' ? status : undefined;
}

function normalizeStoryList(value: unknown): WeeklyDigestRawStory[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((story) => {
      if (!story || typeof story !== 'object') return null;
      const item = story as Record<string, unknown>;
      const articleId = toText(item.articleId);
      if (!articleId) return null;
      const status = normalizeStoryStatus(item.status);
      return {
        articleId,
        reason: clipText(item.reason, 220),
        ...(status ? { status } : {}),
        ...(clipText(item.uncertainty, 220)
          ? { uncertainty: clipText(item.uncertainty, 220) }
          : {}),
      } satisfies WeeklyDigestRawStory;
    })
    .filter((story): story is WeeklyDigestRawStory => Boolean(story))
    .slice(0, 5);
}

export function normalizeCalmBriefingResponse(
  raw: unknown,
): WeeklyDigestRaw | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const themes = Array.isArray(data.themes)
    ? data.themes
        .map((theme) => {
          if (!theme || typeof theme !== 'object') return null;
          const item = theme as Record<string, unknown>;
          const name = clipText(item.name, 80);
          if (!isValidThemeText(name)) return null;
          return {
            name,
            summary: clipText(item.summary, 220),
            articleIds: Array.isArray(item.articleIds)
              ? item.articleIds
                  .map((id) => toText(id))
                  .filter(Boolean)
                  .slice(0, 4)
              : [],
          };
        })
        .filter(Boolean)
    : [];

  const topSignal = normalizeStoryList(data.topSignal);
  const worthYourTime = normalizeStoryList(data.worthYourTime);
  const whatChanged = normalizeStoryList(data.whatChanged);
  const topStories =
    topSignal.length > 0 ? topSignal : normalizeStoryList(data.topStories);
  const missedStories =
    worthYourTime.length > 0
      ? worthYourTime.slice(0, 2)
      : normalizeStoryList(data.missedStories).slice(0, 2);
  const uncertainty = Array.isArray(data.uncertainty)
    ? data.uncertainty
        .map((item) => clipText(item, 220))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  return {
    headline:
      clipText(data.headline || 'Weekly Digest', 100) || 'Weekly Digest',
    summary: clipText(data.summary || '', 500),
    takeaways: resolveTakeaways(
      data.takeaways,
      themes as WeeklyDigestRawTheme[],
    ),
    themes: themes as WeeklyDigestRawTheme[],
    topStories: topStories as WeeklyDigestRawStory[],
    missedStories: missedStories as WeeklyDigestRawStory[],
    topSignal: topStories,
    worthYourTime: worthYourTime.length > 0 ? worthYourTime : missedStories,
    whatChanged,
    uncertainty,
  };
}

export const normalizeDigestResponse = normalizeCalmBriefingResponse;

function pickDigestSelection(articles: FeedArticleRow[]): FeedArticleRow[] {
  const selected: FeedArticleRow[] = [];
  const selectedIds = new Set<string>();
  const feedCounts = new Map<string, number>();

  const add = (article: FeedArticleRow): void => {
    if (selectedIds.has(article.id)) return;
    selectedIds.add(article.id);
    selected.push(article);
    feedCounts.set(article.feed_id, (feedCounts.get(article.feed_id) || 0) + 1);
  };

  const byScore = [...articles].sort(
    (a, b) => scoreArticle(b) - scoreArticle(a),
  );
  const byRecency = [...articles].sort(
    (a, b) => getArticleTime(b) - getArticleTime(a),
  );

  for (const article of byScore) {
    if (selected.length >= 30) break;
    add(article);
  }

  for (const article of byScore) {
    if (selected.length >= 45) break;
    if (selectedIds.has(article.id) || article.read) continue;
    add(article);
  }

  for (const article of byRecency) {
    if (selected.length >= 60) break;
    if (selectedIds.has(article.id)) continue;
    const feedCount = feedCounts.get(article.feed_id) || 0;
    if (feedCount >= 3) continue;
    add(article);
  }

  for (const article of byScore) {
    if (selected.length >= WEEKLY_DIGEST_LIMIT) break;
    add(article);
  }

  return selected.slice(0, WEEKLY_DIGEST_LIMIT);
}

function buildArticleContext(
  article: FeedArticleRow,
  clusters: Map<string, DigestCluster>,
): WeeklyDigestArticleContext {
  const cluster = clusters.get(article.id);
  return {
    id: article.id,
    title: clipText(article.title, 180),
    feedTitle: clipText(article.feed_title || 'Unknown Feed', 80),
    sourceUrl: clipText(article.url, 240),
    summary: clipText(article.summary || '', 240),
    categories: parseJsonArray(article.categories),
    read: Boolean(article.read),
    saved: Boolean(article.saved),
    publishedAtLabel: formatWindowLabel(getArticleTime(article) || Date.now()),
    score: scoreArticle(article),
    clusterId: cluster?.id || article.id,
    clusterSize: cluster?.articleIds.length || 1,
    relatedArticleIds: cluster?.articleIds || [article.id],
  };
}

function normalizeKeyword(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const THEME_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'all',
  'also',
  'any',
  'are',
  'been',
  'being',
  'between',
  'both',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'down',
  'each',
  'even',
  'from',
  'have',
  'here',
  'into',
  'just',
  'made',
  'more',
  'most',
  'much',
  'must',
  'need',
  'news',
  'not',
  'now',
  'only',
  'over',
  'people',
  'should',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'things',
  'this',
  'those',
  'through',
  'too',
  'under',
  'very',
  'want',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'your',
]);

function tokenizeThemeText(value: string): string[] {
  return normalizeKeyword(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !THEME_STOP_WORDS.has(token));
}

function collectThemePhrases(tokens: string[]): string[] {
  const phrases = new Set<string>();

  for (let start = 0; start < tokens.length; start += 1) {
    for (const length of [2, 3]) {
      if (start + length > tokens.length) continue;
      const phrase = tokens.slice(start, start + length).join(' ');
      if (phrase.split(/\s+/).length >= 2) {
        phrases.add(phrase);
      }
    }
  }

  return [...phrases];
}

function buildThemePhrasesForArticle(article: FeedArticleRow): string[] {
  const phrases = new Set<string>();

  for (const phrase of collectThemePhrases(tokenizeThemeText(article.title))) {
    phrases.add(phrase);
  }

  const categoryTokens = parseJsonArray(article.categories).flatMap((item) =>
    tokenizeThemeText(item),
  );
  if (categoryTokens.length >= 2) {
    for (const phrase of collectThemePhrases(categoryTokens)) {
      phrases.add(phrase);
    }
  }

  return [...phrases];
}

function deriveHeuristicThemes(
  articles: FeedArticleRow[],
): WeeklyDigestRawTheme[] {
  const phraseStats = new Map<
    string,
    { count: number; score: number; articleIds: Set<string> }
  >();

  for (const article of articles) {
    const score = scoreArticle(article);
    const phrases = new Set(buildThemePhrasesForArticle(article));

    for (const phrase of phrases) {
      const wordCount = phrase.split(/\s+/).filter(Boolean).length;
      if (wordCount < 2 || wordCount > 3) continue;

      const current = phraseStats.get(phrase) || {
        count: 0,
        score: 0,
        articleIds: new Set<string>(),
      };

      if (current.articleIds.has(article.id)) continue;
      current.articleIds.add(article.id);
      current.count += 1;
      current.score = Math.max(current.score, score);
      phraseStats.set(phrase, current);
    }
  }

  const orderedThemes = [...phraseStats.entries()]
    .map(([phrase, stats]) => ({
      phrase,
      count: stats.count,
      score: stats.score,
      articleIds: [...stats.articleIds],
      words: phrase.split(/\s+/).filter(Boolean).length,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.words - a.words ||
        b.score - a.score ||
        a.phrase.localeCompare(b.phrase),
    )
    .slice(0, 4);

  const themes: WeeklyDigestRawTheme[] = orderedThemes.map((theme) => {
    const matchingArticles = articles
      .filter((article) => theme.articleIds.includes(article.id))
      .sort((a, b) => scoreArticle(b) - scoreArticle(a))
      .slice(0, 4);
    const title = toTitleCase(theme.phrase);

    return {
      name: title,
      summary:
        matchingArticles.length > 0
          ? `${matchingArticles.length} articles centered on ${title}.`
          : `Coverage around ${title}.`,
      articleIds: matchingArticles.map((article) => article.id),
    };
  });

  if (themes.length === 0) {
    return [...articles]
      .sort((a, b) => scoreArticle(b) - scoreArticle(a))
      .map((article) => {
        const fallbackPhrase = collectThemePhrases(
          tokenizeThemeText(article.title),
        )
          .sort(
            (a, b) =>
              b.split(/\s+/).length - a.split(/\s+/).length ||
              a.localeCompare(b),
          )
          .at(0);

        if (!fallbackPhrase) return null;

        const title = toTitleCase(fallbackPhrase);
        return {
          name: title,
          summary: `A representative story about ${title}.`,
          articleIds: [article.id],
        } satisfies WeeklyDigestRawTheme;
      })
      .filter((theme): theme is WeeklyDigestRawTheme => Boolean(theme))
      .slice(0, 3);
  }

  return themes;
}

function getStoryStatus(
  article: FeedArticleRow,
  cluster?: DigestCluster,
  now = Date.now(),
): 'new' | 'ongoing' {
  const age = now - getArticleTime(article);
  return (cluster && cluster.articleIds.length > 1) || age > 2 * DAY_MS
    ? 'ongoing'
    : 'new';
}

function resolveStories(
  stories: WeeklyDigestRawStory[],
  articleMap: Map<string, FeedArticleRow>,
  fallback: FeedArticleRow[],
  minimumCount: number,
  clusters: Map<string, DigestCluster>,
  now = Date.now(),
): WeeklyDigestStory[] {
  const resolved: WeeklyDigestStory[] = [];
  const usedClusters = new Set<string>();

  for (const story of stories) {
    const article = articleMap.get(toText(story.articleId));
    if (!article) continue;
    const cluster = clusters.get(article.id);
    const clusterId = cluster?.id || article.id;
    if (usedClusters.has(clusterId)) continue;
    usedClusters.add(clusterId);
    resolved.push({
      article,
      reason: clipText(story.reason, 220),
      status: story.status || getStoryStatus(article, cluster, now),
      uncertainty: clipText(story.uncertainty, 220) || undefined,
      sourceCount: cluster?.feedIds.length || 1,
      relatedArticleIds: cluster?.articleIds || [article.id],
    });
  }

  for (const article of fallback) {
    if (resolved.length >= Math.max(stories.length, minimumCount)) break;
    const cluster = clusters.get(article.id);
    const clusterId = cluster?.id || article.id;
    if (usedClusters.has(clusterId)) continue;
    usedClusters.add(clusterId);
    resolved.push({
      article,
      reason: '',
      status: getStoryStatus(article, cluster, now),
      sourceCount: cluster?.feedIds.length || 1,
      relatedArticleIds: cluster?.articleIds || [article.id],
    });
  }

  return resolved.slice(0, Math.max(stories.length, minimumCount));
}

function resolveThemes(
  themes: WeeklyDigestRawTheme[],
  articleMap: Map<string, FeedArticleRow>,
): WeeklyDigestTheme[] {
  const resolved: WeeklyDigestTheme[] = [];

  for (const theme of themes) {
    const articles = theme.articleIds
      .map((id) => articleMap.get(toText(id)))
      .filter((article): article is FeedArticleRow => Boolean(article));

    if (articles.length === 0) continue;

    const name = clipText(theme.name, 80);
    if (!isValidThemeText(name)) continue;

    resolved.push({
      name,
      summary: clipText(theme.summary, 220),
      articles,
    });
  }

  return resolved;
}

function deriveActiveFeeds(
  articles: FeedArticleRow[],
): Array<{ title: string; count: number }> {
  const counts = new Map<string, { title: string; count: number }>();

  for (const article of articles) {
    const current = counts.get(article.feed_id) || {
      title: article.feed_title || 'Unknown Feed',
      count: 0,
    };
    current.count += 1;
    counts.set(article.feed_id, current);
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 3);
}

async function buildWeeklyDigestRaw(
  articles: FeedArticleRow[],
  now: number,
  windowDays: number,
  clusters: DigestCluster[],
  digestClient: Awaited<ReturnType<typeof getConfiguredAiClient>>,
): Promise<WeeklyDigestRaw> {
  const clusterMap = clusterLookup(clusters);
  // The full eligible corpus is intentionally sent to the briefing prompt. The
  // UI may be ranked, but an article being read or hidden must not silently
  // remove it from the daily briefing's reasoning context.
  const corpus = articles.map((article) =>
    buildArticleContext(article, clusterMap),
  );
  const windowStartLabel = formatWindowLabel(now - windowDays * DAY_MS);
  const windowEndLabel = formatWindowLabel(now);

  if (digestClient) {
    try {
      const prompt = buildWeeklyDigestPrompt(
        windowStartLabel,
        windowEndLabel,
        corpus,
      );
      const response = await digestClient.completeChat(
        WEEKLY_DIGEST_SYSTEM_PROMPT,
        prompt,
        1400,
      );

      if (response) {
        const parsed = normalizeCalmBriefingResponse(
          extractDigestJson(response),
        );
        if (parsed) return parsed;
      }
    } catch (error) {
      console.warn(
        '[digest] AI briefing failed; using deterministic fallback',
        error,
      );
    }
  }

  return buildDeterministicBriefing(articles, now, clusters, windowDays);
}

export function buildDeterministicBriefing(
  articles: FeedArticleRow[],
  now = Date.now(),
  clusters: DigestCluster[] = deduplicateDigestArticles(articles).clusters,
  windowDays = WEEKLY_DIGEST_WINDOW_DAYS,
): WeeklyDigestRaw {
  const clusterMap = clusterLookup(clusters);
  const representatives = articles.filter((article) => {
    const cluster = clusterMap.get(article.id);
    return !cluster || cluster.representativeId === article.id;
  });
  const heuristics = deriveHeuristicThemes(representatives);
  const topSignal = selectHeuristicTopStories(representatives).map(
    (article) => ({
      articleId: article.id,
      status: getStoryStatus(article, clusterMap.get(article.id), now),
      reason: article.summary?.trim()
        ? clipText(article.summary, 160)
        : `Representative article from ${article.feed_title || 'this feed'}.`,
    }),
  );
  const worthYourTime = selectHeuristicWorthStories(representatives).map(
    (article) => ({
      articleId: article.id,
      status: getStoryStatus(article, clusterMap.get(article.id), now),
      reason: article.summary?.trim()
        ? `${article.read ? 'Worth revisiting' : 'Unread and worth a look'}: ${clipText(article.summary, 130)}`
        : article.read
          ? 'A useful story to revisit.'
          : 'Unread article worth a look.',
    }),
  );
  const whatChanged = selectHeuristicWhatChanged(representatives, now).map(
    (article) => ({
      articleId: article.id,
      status: getStoryStatus(article, clusterMap.get(article.id), now),
      reason: `Published ${formatWindowLabel(getArticleTime(article))}; ${clipText(article.summary || article.title, 140)}.`,
    }),
  );
  const uncertainty = clusters.some((cluster) => cluster.feedIds.length > 1)
    ? [
        'Some storylines are covered by multiple feeds; open the source links to compare the details.',
      ]
    : [];
  const missedStories = selectHeuristicMissedStories(representatives).map(
    (article) => ({
      articleId: article.id,
      status: getStoryStatus(article, clusterMap.get(article.id), now),
      reason: article.summary?.trim()
        ? `Unread but notable: ${clipText(article.summary, 140)}`
        : 'Unread article worth a look.',
    }),
  );

  return {
    headline: 'A calm look at your reading',
    summary:
      articles.length === 0
        ? `No eligible articles arrived in the last ${windowDays} day${windowDays === 1 ? '' : 's'}.`
        : `${articles.length} eligible ${articles.length === 1 ? 'story' : 'stories'} from ${new Set(articles.map((article) => article.feed_id)).size} feeds over the last ${windowDays} day${windowDays === 1 ? '' : 's'}. This briefing groups related coverage and keeps the full reading set available below.`,
    takeaways: heuristics
      .slice(0, 3)
      .map((theme) => `${theme.name}: ${theme.summary}`),
    themes: heuristics,
    topStories: topSignal,
    missedStories,
    topSignal,
    worthYourTime,
    whatChanged,
    uncertainty,
  };
}

export function extractDigestJson(value: string): unknown {
  const trimmed = value.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

const selectUniqueByFeed = (
  articles: FeedArticleRow[],
  limit: number,
): FeedArticleRow[] => {
  const sorted = [...articles].sort(
    (a, b) => scoreArticle(b) - scoreArticle(a),
  );
  const selected: FeedArticleRow[] = [];
  const feedCounts = new Map<string, number>();

  for (const article of sorted) {
    if (selected.length >= limit) break;
    if ((feedCounts.get(article.feed_id) || 0) >= 2) continue;
    selected.push(article);
    feedCounts.set(article.feed_id, (feedCounts.get(article.feed_id) || 0) + 1);
  }

  if (selected.length < limit) {
    for (const article of sorted) {
      if (
        selected.length >= limit ||
        selected.some((item) => item.id === article.id)
      )
        continue;
      selected.push(article);
    }
  }

  return selected
    .sort(
      (a, b) =>
        scoreArticle(b) - scoreArticle(a) ||
        getArticleTime(b) - getArticleTime(a),
    )
    .slice(0, limit);
};

function selectHeuristicTopStories(
  articles: FeedArticleRow[],
): FeedArticleRow[] {
  return selectUniqueByFeed(articles, 5);
}

function selectHeuristicWorthStories(
  articles: FeedArticleRow[],
): FeedArticleRow[] {
  return selectUniqueByFeed(
    [...articles].sort(
      (a, b) =>
        Number(b.read === 0 || b.saved) - Number(a.read === 0 || a.saved) ||
        scoreArticle(b) - scoreArticle(a),
    ),
    5,
  );
}

function selectHeuristicWhatChanged(
  articles: FeedArticleRow[],
  now = Date.now(),
): FeedArticleRow[] {
  return [...articles]
    .sort(
      (a, b) =>
        getArticleTime(b) - getArticleTime(a) ||
        scoreArticle(b) - scoreArticle(a),
    )
    .filter((article) => getArticleTime(article) >= now - 3 * DAY_MS)
    .slice(0, 5);
}

function selectHeuristicMissedStories(
  articles: FeedArticleRow[],
): FeedArticleRow[] {
  const unread = [...articles]
    .filter((article) => !article.read)
    .sort((a, b) => scoreArticle(b) - scoreArticle(a));
  const read = [...articles]
    .filter((article) => Boolean(article.read))
    .sort((a, b) => scoreArticle(b) - scoreArticle(a));
  return [...unread, ...read].slice(0, 2);
}

function getInclusionCounts(
  windowArticles: DigestArticleRow[],
  eligibleArticles: DigestArticleRow[],
  representativeCount: number,
): DigestInclusionCounts {
  const excludedArticles = windowArticles.length - eligibleArticles.length;
  let excludedThumbsDown = 0;
  let excludedRejected = 0;
  let excludedHiddenUnread = 0;

  for (const article of windowArticles) {
    if (article.thumbs_down) excludedThumbsDown += 1;
    else if (article.rejected) excludedRejected += 1;
    else if (article.hidden && !article.read) excludedHiddenUnread += 1;
  }

  return {
    windowArticles: windowArticles.length,
    eligibleArticles: eligibleArticles.length,
    excludedArticles,
    excludedThumbsDown,
    excludedRejected,
    excludedHiddenUnread,
    visibleUnread: eligibleArticles.filter(
      (article) => !article.read && !article.hidden,
    ).length,
    hiddenRead: eligibleArticles.filter((article) =>
      Boolean(article.read && article.hidden),
    ).length,
    read: eligibleArticles.filter((article) => Boolean(article.read)).length,
    unread: eligibleArticles.filter((article) => !article.read).length,
    saved: eligibleArticles.filter((article) => Boolean(article.saved)).length,
    duplicateArticles: Math.max(
      0,
      eligibleArticles.length - representativeCount,
    ),
    deduplicatedArticles: representativeCount,
  };
}

function resolveBriefing(
  raw: WeeklyDigestRaw,
  articleMap: Map<string, FeedArticleRow>,
  representatives: FeedArticleRow[],
  clusters: DigestCluster[],
  now: number,
): CalmDailyBriefing {
  const clusterMap = clusterLookup(clusters);
  const topSignal = resolveStories(
    raw.topSignal?.length ? raw.topSignal : raw.topStories,
    articleMap,
    selectHeuristicTopStories(representatives),
    1,
    clusterMap,
    now,
  ).slice(0, 3);
  const worthYourTime = resolveStories(
    raw.worthYourTime?.length ? raw.worthYourTime : raw.missedStories,
    articleMap,
    selectHeuristicWorthStories(representatives),
    2,
    clusterMap,
    now,
  ).slice(0, 5);
  const whatChanged = resolveStories(
    raw.whatChanged || [],
    articleMap,
    selectHeuristicWhatChanged(representatives, now),
    1,
    clusterMap,
    now,
  ).slice(0, 5);

  return {
    headline: raw.headline || 'A calm look at your reading',
    summary: raw.summary || '',
    topSignal,
    worthYourTime,
    whatChanged,
    uncertainty: (raw.uncertainty || [])
      .map((item) => clipText(item, 220))
      .filter(Boolean)
      .slice(0, 3),
  };
}

function buildDigestResult(
  raw: WeeklyDigestRaw,
  allArticles: DigestArticleRow[],
  windowStart: number,
  windowEnd: number,
  now: number,
  windowDays: number,
  cacheHit: boolean,
  generatedAt: number,
  aiEnabled: boolean,
  inclusionCounts: DigestInclusionCounts,
  clusters: DigestCluster[],
  history: DigestHistoryEntry[],
): WeeklyDigestResult {
  const articleMap = new Map(
    allArticles.map((article) => [article.id, article]),
  );
  const representatives = clusters
    .map((cluster) => articleMap.get(cluster.representativeId))
    .filter((article): article is DigestArticleRow => Boolean(article));
  const resolvedThemes = resolveThemes(raw.themes, articleMap);
  const fallbackThemes = resolveThemes(
    deriveHeuristicThemes(representatives),
    articleMap,
  );
  const briefing = resolveBriefing(
    raw,
    articleMap,
    representatives,
    clusters,
    now,
  );
  const topStories = resolveStories(
    raw.topStories,
    articleMap,
    selectHeuristicTopStories(representatives),
    1,
    clusterLookup(clusters),
    now,
  );
  const missedStories = resolveStories(
    raw.missedStories,
    articleMap,
    selectHeuristicMissedStories(representatives),
    2,
    clusterLookup(clusters),
    now,
  );

  return {
    totalArticles: allArticles.length,
    totalFeeds: new Set(allArticles.map((article) => article.feed_id)).size,
    unreadArticles: allArticles.filter((article) => !article.read).length,
    savedArticles: allArticles.filter((article) => Boolean(article.saved))
      .length,
    windowStart,
    windowEnd,
    generatedAt,
    cacheHit,
    aiEnabled,
    windowDays,
    headline: raw.headline || briefing.headline,
    summary: raw.summary || briefing.summary,
    takeaways: resolveTakeaways(raw.takeaways, raw.themes),
    themes: resolvedThemes.length ? resolvedThemes : fallbackThemes,
    topStories,
    missedStories,
    activeFeeds: deriveActiveFeeds(allArticles),
    allArticles,
    totalPages: Math.max(
      1,
      Math.ceil(allArticles.length / WEEKLY_DIGEST_LIMIT),
    ),
    limit: WEEKLY_DIGEST_LIMIT,
    briefing,
    inclusionCounts,
    clusters,
    history,
    deduplicatedArticles: representatives.length,
  };
}

export async function getWeeklyDigestArticles(
  input: number | WeeklyDigestOptions = {},
): Promise<WeeklyDigestResult> {
  const { now, windowDays, forceRefresh } = getOptions(input);
  const db = getDb();
  const windowStart = now - windowDays * DAY_MS;
  const windowEnd = now;
  const select = `${buildFeedArticleSelect()} WHERE COALESCE(a.published_at, a.fetched_at) >= ? AND COALESCE(a.published_at, a.fetched_at) <= ? ORDER BY ${rankingOrderExpression('a')} DESC, COALESCE(a.published_at, a.fetched_at) DESC`;
  const windowArticles = db
    .prepare(select)
    .all(windowStart, windowEnd) as DigestArticleRow[];
  const allArticles = windowArticles.filter(
    (article) =>
      !article.thumbs_down &&
      !article.rejected &&
      (!article.hidden || Boolean(article.read)),
  );
  const { representatives, clusters } = deduplicateDigestArticles(allArticles);
  const inclusionCounts = getInclusionCounts(
    windowArticles,
    allArticles,
    representatives.length,
  );
  const signature = hashArticles(allArticles, windowStart, windowDays);
  const cached = forceRefresh ? null : loadCache(db, cacheKey(windowDays));
  const aiEnabled = Boolean(
    db
      .prepare('SELECT 1 FROM provider_configs WHERE enabled = 1 LIMIT 1')
      .get(),
  );
  const history = loadHistory(db);

  if (cached?.signature === signature) {
    return buildDigestResult(
      cached.raw,
      allArticles,
      windowStart,
      windowEnd,
      now,
      windowDays,
      true,
      cached.generatedAt,
      aiEnabled,
      inclusionCounts,
      clusters,
      history,
    );
  }

  const digestClient = aiEnabled ? await getConfiguredAiClient() : null;
  const raw = await buildWeeklyDigestRaw(
    allArticles,
    now,
    windowDays,
    clusters,
    digestClient,
  );
  saveCache(db, cacheKey(windowDays), {
    signature,
    generatedAt: now,
    windowDays,
    raw,
  });
  const nextHistory = saveHistory(db, {
    generatedAt: now,
    windowDays,
    headline: raw.headline || 'A calm look at your reading',
    totalArticles: allArticles.length,
    deduplicatedArticles: representatives.length,
    signature,
  });

  return buildDigestResult(
    raw,
    allArticles,
    windowStart,
    windowEnd,
    now,
    windowDays,
    false,
    now,
    aiEnabled,
    inclusionCounts,
    clusters,
    nextHistory,
  );
}

export function getWeeklyDigestSelectionPreview(
  articles: FeedArticleRow[],
): WeeklyDigestArticleContext[] {
  const { clusters } = deduplicateDigestArticles(articles);
  const clusterMap = clusterLookup(clusters);
  return pickDigestSelection(articles).map((article) =>
    buildArticleContext(article, clusterMap),
  );
}
