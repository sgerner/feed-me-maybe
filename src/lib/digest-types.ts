export type DigestArticle = {
  id: string;
  feed_id: string;
  url: string;
  title: string;
  author: string | null;
  summary: string | null;
  image_url: string | null;
  categories: string | null;
  published_at: number | null;
  fetched_at: number | null;
  read: number;
  saved: number;
  hidden: number;
  thumbs_up: number;
  thumbs_down: number;
  heuristic_score: number | null;
  combined_score: number | null;
  feed_title: string | null;
  feed_url: string | null;
  feed_open_mode: string | null;
  rejected?: number;
  rank_score?: number;
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

export type WeeklyDigestTheme<TArticle = DigestArticle> = {
  name: string;
  summary: string;
  articles: TArticle[];
};

export type WeeklyDigestStory<TArticle = DigestArticle> = {
  article: TArticle;
  reason: string;
  status: 'new' | 'ongoing';
  uncertainty?: string;
  sourceCount: number;
  relatedArticleIds: string[];
};

export type CalmDailyBriefing<TArticle = DigestArticle> = {
  headline: string;
  summary: string;
  topSignal: Array<WeeklyDigestStory<TArticle>>;
  worthYourTime: Array<WeeklyDigestStory<TArticle>>;
  whatChanged: Array<WeeklyDigestStory<TArticle>>;
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
  aiGenerated: boolean;
  windowDays: number;
};

export type WeeklyDigestResult<TArticle = DigestArticle> = WeeklyDigestStats & {
  headline: string;
  summary: string;
  takeaways: string[];
  themes: Array<WeeklyDigestTheme<TArticle>>;
  topStories: Array<WeeklyDigestStory<TArticle>>;
  missedStories: Array<WeeklyDigestStory<TArticle>>;
  activeFeeds: Array<{ title: string; count: number }>;
  allArticles: TArticle[];
  totalPages: number;
  limit: number;
  briefing: CalmDailyBriefing<TArticle>;
  inclusionCounts: DigestInclusionCounts;
  clusters: DigestCluster[];
  history: DigestHistoryEntry[];
  deduplicatedArticles: number;
};

export const EMPTY_DIGEST_INCLUSION_COUNTS: DigestInclusionCounts = {
  windowArticles: 0,
  eligibleArticles: 0,
  excludedArticles: 0,
  excludedThumbsDown: 0,
  excludedRejected: 0,
  excludedHiddenUnread: 0,
  visibleUnread: 0,
  hiddenRead: 0,
  read: 0,
  unread: 0,
  saved: 0,
  duplicateArticles: 0,
  deduplicatedArticles: 0,
};

export function createEmptyDigest(now = Date.now()): WeeklyDigestResult {
  return {
    headline: 'Calm Daily Briefing',
    summary: '',
    takeaways: [],
    themes: [],
    topStories: [],
    missedStories: [],
    activeFeeds: [],
    totalArticles: 0,
    totalFeeds: 0,
    unreadArticles: 0,
    savedArticles: 0,
    windowStart: now,
    windowEnd: now,
    generatedAt: now,
    cacheHit: false,
    aiEnabled: false,
    aiGenerated: false,
    windowDays: 7,
    totalPages: 1,
    limit: 60,
    briefing: {
      headline: 'Calm Daily Briefing',
      summary: '',
      topSignal: [],
      worthYourTime: [],
      whatChanged: [],
      uncertainty: [],
    },
    inclusionCounts: { ...EMPTY_DIGEST_INCLUSION_COUNTS },
    clusters: [],
    deduplicatedArticles: 0,
    history: [],
    allArticles: [],
  };
}

export const EMPTY_DIGEST: WeeklyDigestResult = createEmptyDigest();
