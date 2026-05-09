import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import { getConfiguredAiClient } from '$lib/server/ai/runtime';
import {
  WEEKLY_DIGEST_SYSTEM_PROMPT,
  buildWeeklyDigestPrompt,
  type WeeklyDigestArticleContext,
} from '$lib/server/ai/digest-prompts';
import type { FeedArticleRow } from '$lib/server/feed/articles';

export const WEEKLY_DIGEST_LIMIT = 60;
export const WEEKLY_DIGEST_WINDOW_DAYS = 7;
const WEEKLY_DIGEST_WINDOW_MS = WEEKLY_DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const WEEKLY_DIGEST_CACHE_KEY = 'weekly_digest_cache';

type WeeklyDigestRawTheme = {
  name: string;
  summary: string;
  articleIds: string[];
};

type WeeklyDigestRawStory = {
  articleId: string;
  reason: string;
};

export type WeeklyDigestRaw = {
  headline: string;
  summary: string;
  takeaways: string[];
  themes: WeeklyDigestRawTheme[];
  topStories: WeeklyDigestRawStory[];
  missedStories: WeeklyDigestRawStory[];
};

export type WeeklyDigestTheme = {
  name: string;
  summary: string;
  articles: FeedArticleRow[];
};

export type WeeklyDigestStory = {
  article: FeedArticleRow;
  reason: string;
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
};

type DigestCachePayload = {
  signature: string;
  generatedAt: number;
  raw: WeeklyDigestRaw;
};

function buildFeedArticleSelect(): string {
  return `
    SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url, a.categories,
           a.published_at, a.fetched_at, a.read, a.saved, a.hidden, a.thumbs_up, a.thumbs_down,
           a.heuristic_score, a.combined_score,
           f.title as feed_title, f.url as feed_url, f.open_mode as feed_open_mode
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
  `;
}

function scoreArticle(article: FeedArticleRow): number {
  const combined = article.combined_score ?? article.heuristic_score ?? 0;
  const published = article.published_at ?? article.fetched_at ?? 0;
  return combined * 1000 + published;
}

function getArticleTime(article: FeedArticleRow): number {
  return article.published_at ?? article.fetched_at ?? 0;
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
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
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
    return parsed
      .map((item) => toText(item))
      .filter((item) => item.length > 0);
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

function hashArticles(articles: FeedArticleRow[], windowStart: number): string {
  const payload = articles
    .map(
      (article) =>
        [
          article.id,
          article.feed_id,
          article.title,
          article.summary,
          article.read,
          article.saved,
          article.hidden,
          article.published_at ?? '',
          article.fetched_at ?? '',
          article.heuristic_score ?? '',
          article.combined_score ?? '',
        ].join('|'),
    )
    .join('||');

  return crypto
    .createHash('sha256')
    .update(`${windowStart}::${payload}`)
    .digest('hex');
}

function loadCache(db: ReturnType<typeof getDb>): DigestCachePayload | null {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(WEEKLY_DIGEST_CACHE_KEY) as { value: string } | undefined;

  if (!row?.value) return null;

  try {
    return JSON.parse(row.value) as DigestCachePayload;
  } catch {
    return null;
  }
}

function saveCache(db: ReturnType<typeof getDb>, cache: DigestCachePayload): void {
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(WEEKLY_DIGEST_CACHE_KEY, JSON.stringify(cache), Date.now());
}

function normalizeDigestResponse(raw: unknown): WeeklyDigestRaw | null {
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

  const topStories = Array.isArray(data.topStories)
    ? data.topStories
        .map((story) => {
          if (!story || typeof story !== 'object') return null;
          const item = story as Record<string, unknown>;
          const articleId = toText(item.articleId);
          if (!articleId) return null;
          return {
            articleId,
            reason: clipText(item.reason, 220),
          };
        })
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const missedStories = Array.isArray(data.missedStories)
    ? data.missedStories
        .map((story) => {
          if (!story || typeof story !== 'object') return null;
          const item = story as Record<string, unknown>;
          const articleId = toText(item.articleId);
          if (!articleId) return null;
          return {
            articleId,
            reason: clipText(item.reason, 220),
          };
        })
        .filter(Boolean)
        .slice(0, 2)
    : [];

  return {
    headline: clipText(data.headline || 'Weekly Digest', 100) || 'Weekly Digest',
    summary: clipText(data.summary || '', 500),
    takeaways: resolveTakeaways(data.takeaways, themes as WeeklyDigestRawTheme[]),
    themes: themes as WeeklyDigestRawTheme[],
    topStories: topStories as WeeklyDigestRawStory[],
    missedStories: missedStories as WeeklyDigestRawStory[],
  };
}

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

  const byScore = [...articles].sort((a, b) => scoreArticle(b) - scoreArticle(a));
  const byRecency = [...articles].sort((a, b) => getArticleTime(b) - getArticleTime(a));

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

function buildArticleContext(article: FeedArticleRow): WeeklyDigestArticleContext {
  return {
    id: article.id,
    title: clipText(article.title, 180),
    feedTitle: clipText(article.feed_title || 'Unknown Feed', 80),
    summary: clipText(article.summary || '', 240),
    categories: parseJsonArray(article.categories),
    read: Boolean(article.read),
    saved: Boolean(article.saved),
    publishedAtLabel: formatWindowLabel(getArticleTime(article) || Date.now()),
    score: scoreArticle(article),
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

function deriveHeuristicThemes(articles: FeedArticleRow[]): WeeklyDigestRawTheme[] {
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
        const fallbackPhrase = collectThemePhrases(tokenizeThemeText(article.title))
          .sort(
            (a, b) =>
              b.split(/\s+/).length - a.split(/\s+/).length || a.localeCompare(b),
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

function resolveStories(
  stories: WeeklyDigestRawStory[],
  articleMap: Map<string, FeedArticleRow>,
  fallback: FeedArticleRow[],
  minimumCount: number,
): WeeklyDigestStory[] {
  const resolved: WeeklyDigestStory[] = [];
  const used = new Set<string>();

  for (const story of stories) {
    const article = articleMap.get(toText(story.articleId));
    if (!article || used.has(article.id)) continue;
    used.add(article.id);
    resolved.push({ article, reason: clipText(story.reason, 220) });
  }

  for (const article of fallback) {
    if (resolved.length >= Math.max(stories.length, minimumCount)) break;
    if (used.has(article.id)) continue;
    used.add(article.id);
    resolved.push({ article, reason: '' });
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

function deriveActiveFeeds(articles: FeedArticleRow[]): Array<{ title: string; count: number }> {
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
  digestClient: Awaited<ReturnType<typeof getConfiguredAiClient>>,
): Promise<WeeklyDigestRaw> {
  const selection = pickDigestSelection(articles).map(buildArticleContext);
  const windowStartLabel = formatWindowLabel(now - WEEKLY_DIGEST_WINDOW_MS);
  const windowEndLabel = formatWindowLabel(now);

  if (digestClient) {
    const prompt = buildWeeklyDigestPrompt(windowStartLabel, windowEndLabel, selection);
    const response = await digestClient.completeChat(
      WEEKLY_DIGEST_SYSTEM_PROMPT,
      prompt,
      1200,
    );

    if (response) {
      const parsed = normalizeDigestResponse(extractJsonObject(response));
      if (parsed) return parsed;
    }
  }

  const heuristics = deriveHeuristicThemes(articles);
  const topStories = selectHeuristicTopStories(articles).map((article) => ({
    articleId: article.id,
    reason:
      article.summary?.trim()
        ? clipText(article.summary, 160)
        : `Representative article from ${article.feed_title || 'this feed'}.`,
  }));
  const missedStories = selectHeuristicMissedStories(articles).map((article) => ({
    articleId: article.id,
    reason:
      article.summary?.trim()
        ? `Unread but notable: ${clipText(article.summary, 140)}`
        : 'Unread article worth a look.',
  }));

  return {
    headline: 'Weekly Digest',
    summary: `Top stories from ${new Set(articles.map((article) => article.feed_id)).size} feeds over the last 7 days.`,
    takeaways: heuristics.slice(0, 3).map((theme) => `${theme.name}: ${theme.summary}`),
    themes: heuristics,
    topStories,
    missedStories,
  };
}

function extractJsonObject(value: string): unknown {
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

function selectHeuristicTopStories(articles: FeedArticleRow[]): FeedArticleRow[] {
  const sorted = [...articles].sort((a, b) => scoreArticle(b) - scoreArticle(a));
  const selected: FeedArticleRow[] = [];
  const feedCounts = new Map<string, number>();

  const add = (article: FeedArticleRow): void => {
    if (selected.some((item) => item.id === article.id)) return;
    selected.push(article);
    feedCounts.set(article.feed_id, (feedCounts.get(article.feed_id) || 0) + 1);
  };

  for (const article of sorted) {
    if (selected.length >= 5) break;
    if ((feedCounts.get(article.feed_id) || 0) >= 2) continue;
    add(article);
  }

  for (const article of sorted) {
    if (selected.length >= 5) break;
    add(article);
  }

  return selected.slice(0, 5);
}

function selectHeuristicMissedStories(
  articles: FeedArticleRow[],
): FeedArticleRow[] {
  const unread = [...articles]
    .filter((article) => !article.read)
    .sort((a, b) => scoreArticle(b) - scoreArticle(a));
  const read = [...articles]
    .filter((article) => article.read)
    .sort((a, b) => scoreArticle(b) - scoreArticle(a));

  const selected: FeedArticleRow[] = [];
  const feedCounts = new Map<string, number>();

  for (const article of unread) {
    if (selected.length >= 2) break;
    if ((feedCounts.get(article.feed_id) || 0) >= 1) continue;
    selected.push(article);
    feedCounts.set(article.feed_id, (feedCounts.get(article.feed_id) || 0) + 1);
  }

  for (const article of read) {
    if (selected.length >= 2) break;
    if (!selected.some((item) => item.id === article.id)) {
      selected.push(article);
    }
  }

  return selected.slice(0, 2);
}

export async function getWeeklyDigestArticles(
  now = Date.now(),
): Promise<WeeklyDigestResult> {
  const db = getDb();
  const windowStart = now - WEEKLY_DIGEST_WINDOW_MS;
  const windowEnd = now;

  const allArticles = db
    .prepare(
      `
      ${buildFeedArticleSelect()}
      WHERE a.hidden = 0
        AND COALESCE(a.published_at, a.fetched_at) >= ?
      ORDER BY COALESCE(a.combined_score, a.heuristic_score, 0) DESC,
               COALESCE(a.published_at, a.fetched_at) DESC
    `,
    )
    .all(windowStart) as FeedArticleRow[];

  const totalArticles = allArticles.length;
  const totalFeeds = new Set(allArticles.map((article) => article.feed_id)).size;
  const unreadArticles = allArticles.filter((article) => !article.read).length;
  const savedArticles = allArticles.filter((article) => article.saved).length;
  const signature = hashArticles(allArticles, windowStart);
  const cached = loadCache(db);
  const aiEnabled = Boolean(
    db.prepare('SELECT 1 FROM provider_configs WHERE enabled = 1 LIMIT 1').get(),
  );

  if (cached?.signature === signature) {
    const articleMap = new Map(allArticles.map((article) => [article.id, article]));
    const resolvedThemes = resolveThemes(cached.raw.themes, articleMap);
    const topStories = resolveStories(
      cached.raw.topStories,
      articleMap,
      selectHeuristicTopStories(allArticles),
      5,
    );
    const missedStories = resolveStories(
      cached.raw.missedStories,
      articleMap,
      selectHeuristicMissedStories(allArticles),
      2,
    );
    const fallbackThemes = resolveThemes(deriveHeuristicThemes(allArticles), articleMap);

    return {
      totalArticles,
      totalFeeds,
      unreadArticles,
      savedArticles,
      windowStart,
      windowEnd,
      generatedAt: cached.generatedAt,
      cacheHit: true,
      aiEnabled,
      headline: cached.raw.headline || 'Weekly Digest',
      summary: cached.raw.summary || '',
      takeaways: resolveTakeaways(cached.raw.takeaways, cached.raw.themes),
      themes: resolvedThemes.length ? resolvedThemes : fallbackThemes,
      topStories,
      missedStories,
      activeFeeds: deriveActiveFeeds(allArticles),
      allArticles,
      totalPages: 1,
      limit: WEEKLY_DIGEST_LIMIT,
    };
  }

  const digestClient = aiEnabled ? await getConfiguredAiClient() : null;
  const raw = await buildWeeklyDigestRaw(allArticles, now, digestClient);
  saveCache(db, {
    signature,
    generatedAt: now,
    raw,
  });

  const articleMap = new Map(allArticles.map((article) => [article.id, article]));
  const resolvedThemes = resolveThemes(raw.themes, articleMap);
  const topStories = resolveStories(
    raw.topStories,
    articleMap,
    selectHeuristicTopStories(allArticles),
    5,
  );
  const missedStories = resolveStories(
    raw.missedStories,
    articleMap,
    selectHeuristicMissedStories(allArticles),
    2,
  );
  const fallbackThemes = resolveThemes(deriveHeuristicThemes(allArticles), articleMap);

  return {
    totalArticles,
    totalFeeds,
    unreadArticles,
    savedArticles,
    windowStart,
    windowEnd,
    generatedAt: now,
    cacheHit: false,
    aiEnabled,
    headline: raw.headline || 'Weekly Digest',
    summary: raw.summary || '',
    takeaways: resolveTakeaways(raw.takeaways, raw.themes),
    themes: resolvedThemes.length ? resolvedThemes : fallbackThemes,
    topStories,
    missedStories,
    activeFeeds: deriveActiveFeeds(allArticles),
    allArticles,
    totalPages: 1,
    limit: WEEKLY_DIGEST_LIMIT,
  };
}

export function getWeeklyDigestSelectionPreview(
  articles: FeedArticleRow[],
): WeeklyDigestArticleContext[] {
  return pickDigestSelection(articles).map(buildArticleContext);
}
