/**
 * Versioned client-side storage contract for the authenticated offline reader.
 *
 * The scope is an opaque, stable account identifier supplied by the caller. It
 * must never be a session cookie or another short-lived credential.
 */
export const OFFLINE_DB_NAME = 'feed-me-maybe-offline';
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_CACHE_VERSION = 'v1';

export const DEFAULT_OFFLINE_LIMITS = {
  articles: 150,
  savedArticles: 100,
  digests: 8,
} as const;

export type OfflineMutationType =
  | 'read'
  | 'unread'
  | 'save'
  | 'unsave'
  | 'hide'
  | 'unhide'
  | 'thumbs_up'
  | 'unthumbs_up'
  | 'thumbs_down'
  | 'boost'
  | 'restore';

export type OfflineMutationState =
  'pending' | 'processing' | 'blocked' | 'conflict';

export type OfflineJsonPrimitive = string | number | boolean | null;
export type OfflineJsonValue =
  | OfflineJsonPrimitive
  | OfflineJsonValue[]
  | { [key: string]: OfflineJsonValue };

export interface OfflineArticle {
  id: string;
  url: string;
  title: string;
  author?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  published_at?: number | null;
  fetched_at?: number | null;
  feed_id?: string | null;
  feed_title?: string | null;
  feed_url?: string | null;
  feed_site_url?: string | null;
  feed_open_mode?: string | null;
  feed_enabled?: boolean | number | null;
  cleared_at?: number | null;
  read?: boolean | null;
  saved?: boolean | null;
  hidden?: boolean | null;
  thumbs_up?: boolean | null;
  thumbs_down?: boolean | null;
  heuristic_score?: number | null;
  combined_score?: number | null;
  offline_rank_score?: number | null;
}

export interface CachedArticle extends OfflineArticle {
  cacheVersion: typeof OFFLINE_CACHE_VERSION;
  scope: string;
  key: string;
  cachedAt: number;
  updatedAt: number;
}

export interface OfflineDigest {
  id: string;
  generatedAt?: number | null;
  payload: OfflineJsonValue;
}

export interface CachedDigest extends OfflineDigest {
  cacheVersion: typeof OFFLINE_CACHE_VERSION;
  scope: string;
  key: string;
  cachedAt: number;
  updatedAt: number;
}

export interface OfflineMutation {
  id: string;
  idempotencyKey: string;
  scope: string;
  articleId: string;
  type: OfflineMutationType;
  visibleArticleIds?: string[];
  dedupeKey: string;
  sequence: number;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  state: OfflineMutationState;
  blockedStatus?: number;
  processingAt?: number;
  lastError?: string;
}

export interface OfflineStorageLimits {
  articles?: number;
  savedArticles?: number;
  digests?: number;
}

export interface OfflineLibrarySnapshot {
  articles?: OfflineArticle[];
  savedArticles?: OfflineArticle[];
  digests?: OfflineDigest[];
}

export interface OfflineSyncStatus {
  needsSignIn: boolean;
  state: 'idle' | 'syncing' | 'offline' | 'retrying' | 'blocked';
  pendingCount: number;
  lastSyncedAt: number | null;
  nextAttemptAt: number | null;
  lastError: string | null;
}

export interface OfflineReplayResult {
  state: OfflineSyncStatus['state'];
  synced: number;
  retried: number;
  blocked: number;
  conflicts: number;
  remaining: number;
  nextAttemptAt: number | null;
  lastError: string | null;
}

export const OUTBOX_PROCESSING_LEASE_MS = 2 * 60 * 1000;
export const OUTBOX_RETRY_BASE_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 5 * 60 * 1_000;
