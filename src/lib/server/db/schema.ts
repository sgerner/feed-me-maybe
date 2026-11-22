import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ── Auth ──
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('admin'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
});

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: integer('applied_at', { mode: 'timestamp' }).notNull(),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ── Feeds ──
export const feeds = sqliteTable('feeds', {
  id: text('id').primaryKey(),
  url: text('url').notNull().unique(),
  title: text('title').default(''),
  customTitle: integer('custom_title', { mode: 'boolean' })
    .notNull()
    .default(false),
  description: text('description').default(''),
  siteUrl: text('site_url').default(''),
  category: text('category').default(''),
  iconUrl: text('icon_url').default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  useProxy: integer('use_proxy', { mode: 'boolean' }).notNull().default(false),
  fetchFullText: integer('fetch_full_text', { mode: 'boolean' })
    .notNull()
    .default(false),
  cssSelector: text('css_selector').default(''),
  errorCount: integer('error_count').notNull().default(0),
  lastFetchStatus: text('last_fetch_status').default('never'),
  lastFetchAt: integer('last_fetch_at', { mode: 'timestamp' }),
  lastError: text('last_error').default(''),
  etag: text('etag'),
  lastModifiedHeader: text('last_modified_header'),
  pollIntervalMins: integer('poll_interval_mins').default(15),
  openMode: text('open_mode'), // null = use global, 'app', 'iframe', 'tab'
  sourceType: text('source_type').default('rss'),
  sourceMetadata: text('source_metadata').default('{}'),
  lastChangedAt: integer('last_changed_at', { mode: 'timestamp' }),
  fetchCountSinceChange: integer('fetch_count_since_change').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ── Articles ──
export const articles = sqliteTable(
  'articles',
  {
    id: text('id').primaryKey(),
    feedId: text('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    guid: text('guid').default(''),
    url: text('url').notNull(),
    title: text('title').notNull().default('Untitled'),
    author: text('author').default(''),
    summary: text('summary').default(''),
    content: text('content').default(''),
    imageUrl: text('image_url').default(''),
    externalUrl: text('external_url').default(''),
    categories: text('categories').default(''), // JSON array of category strings
    publishedAt: integer('published_at', { mode: 'timestamp' }),
    fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    readAt: integer('read_at', { mode: 'timestamp' }),
    saved: integer('saved', { mode: 'boolean' }).notNull().default(false),
    savedAt: integer('saved_at', { mode: 'timestamp' }),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    hiddenAt: integer('hidden_at', { mode: 'timestamp' }),
    clearedAt: integer('cleared_at', { mode: 'timestamp' }),
    thumbsUp: integer('thumbs_up', { mode: 'boolean' })
      .notNull()
      .default(false),
    thumbsDown: integer('thumbs_down', { mode: 'boolean' })
      .notNull()
      .default(false),
    rejected: integer('rejected', { mode: 'boolean' }).notNull().default(false),
    rejectedAt: integer('rejected_at', { mode: 'timestamp' }),
    stateVersion: integer('state_version').notNull().default(0),
    heuristicScore: real('heuristic_score').default(0),
    jevScore: real('jev_score'),
    jevProcessedAt: integer('jev_processed_at', { mode: 'timestamp' }),
    jevError: text('jev_error').notNull().default(''),
    combinedScore: real('combined_score').default(0),
    rankingRefreshedAt: integer('ranking_refreshed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => {
    const visibleRankExpr = sql`CASE WHEN ${table.combinedScore} IS NOT NULL AND ${table.combinedScore} != 0 THEN ${table.combinedScore} WHEN ${table.heuristicScore} IS NOT NULL THEN ${table.heuristicScore} ELSE 0 END DESC`;
    const savedOrderExpr = sql`CASE WHEN ${table.savedAt} IS NOT NULL THEN ${table.savedAt} WHEN ${table.updatedAt} IS NOT NULL THEN ${table.updatedAt} ELSE ${table.fetchedAt} END DESC`;
    const recoveryOrderExpr = sql`CASE WHEN ${table.hiddenAt} IS NOT NULL THEN ${table.hiddenAt} WHEN ${table.rejectedAt} IS NOT NULL THEN ${table.rejectedAt} ELSE ${table.fetchedAt} END DESC`;
    return [
      index('idx_articles_feed_id').on(table.feedId),
      index('idx_articles_published_at').on(sql`${table.publishedAt} DESC`),
      index('idx_articles_visible_rank')
        .on(visibleRankExpr, sql`${table.publishedAt} DESC`)
        .where(sql`${table.hidden} = 0`),
      index('idx_articles_feed_visible_rank')
        .on(table.feedId, visibleRankExpr, sql`${table.publishedAt} DESC`)
        .where(sql`${table.hidden} = 0`),
      index('idx_articles_saved_published')
        .on(sql`${table.publishedAt} DESC`)
        .where(sql`${table.saved} = 1`),
      index('idx_articles_saved_order')
        .on(savedOrderExpr, sql`${table.id} DESC`)
        .where(sql`${table.saved} = 1`),
      index('idx_articles_effective_publication').on(
        sql`CASE WHEN ${table.publishedAt} IS NOT NULL THEN ${table.publishedAt} ELSE ${table.fetchedAt} END`,
      ),
      uniqueIndex('idx_articles_feed_url_noguid')
        .on(table.feedId, table.url)
        .where(sql`${table.guid} IS NULL OR ${table.guid} = ''`),
      index('idx_articles_feed_url_lookup').on(table.feedId, table.url),
      index('idx_articles_jev_backfill')
        .on(table.fetchedAt, table.id)
        .where(sql`${table.jevScore} IS NULL`),
      index('idx_articles_jev_recent_scored')
        .on(table.fetchedAt, table.id)
        .where(sql`${table.jevScore} IS NOT NULL`),
      index('idx_articles_recovery_order')
        .on(recoveryOrderExpr, sql`${table.id} DESC`)
        .where(
          sql`${table.hidden} = 1 OR ${table.rejected} = 1 OR ${table.thumbsDown} = 1`,
        ),
      index('idx_articles_feed_recovery_order')
        .on(table.feedId, recoveryOrderExpr, sql`${table.id} DESC`)
        .where(
          sql`${table.hidden} = 1 OR ${table.rejected} = 1 OR ${table.thumbsDown} = 1`,
        ),
    ];
  },
);

// ── Article AI Metadata ──
export const articleAiMetadata = sqliteTable('article_ai_metadata', {
  id: text('id').primaryKey(),
  articleId: text('article_id')
    .notNull()
    .unique()
    .references(() => articles.id, { onDelete: 'cascade' }),
  summary: text('summary').default(''),
  topics: text('topics').default('[]'), // JSON array
  entities: text('entities').default('[]'), // JSON array
  contentType: text('content_type').default(''),
  aiRelevanceScore: real('ai_relevance_score').default(0),
  noveltyScore: real('novelty_score').default(0),
  qualityScore: real('quality_score').default(0),
  likelyUserInterest: text('likely_user_interest').default(''),
  signals: text('signals').default('[]'),
  explanation: text('explanation').default(''),
  analysisStatus: text('analysis_status').notNull().default('pending'),
  analysisError: text('analysis_error').notNull().default(''),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const articleStateHistory = sqliteTable(
  'article_state_history',
  {
    id: text('id').primaryKey(),
    operationId: text('operation_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    beforeState: text('before_state').notNull().default('{}'),
    afterState: text('after_state').notNull().default('{}'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    undoneAt: integer('undone_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_article_state_history_operation').on(table.operationId),
    index('idx_article_state_history_article').on(
      table.articleId,
      table.createdAt,
    ),
    uniqueIndex('idx_article_state_history_idempotency').on(
      table.idempotencyKey,
      table.articleId,
    ),
  ],
);

export const savedSearches = sqliteTable(
  'saved_searches',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    query: text('query').notNull().default(''),
    description: text('description').default(''),
    sort: text('sort').notNull().default('relevance'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('idx_saved_searches_updated').on(table.updatedAt)],
);

// ── Feed Fetch Logs ──
export const feedFetchLogs = sqliteTable(
  'feed_fetch_logs',
  {
    id: text('id').primaryKey(),
    feedId: text('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'), // pending, fetching, success, error
    articlesFound: integer('articles_found').default(0),
    articlesNew: integer('articles_new').default(0),
    errorMessage: text('error_message').default(''),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('idx_fetch_logs_feed_id').on(table.feedId),
    index('idx_fetch_logs_feed_created').on(
      table.feedId,
      sql`${table.createdAt} DESC`,
    ),
    index('idx_fetch_logs_status').on(table.status),
  ],
);

// ── Jobs ──
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // feed_fetch, article_crawl, ai_process, jev_process, memory_summarize
    status: text('status').notNull().default('queued'), // queued, processing, completed, failed
    payload: text('payload').default('{}'), // JSON
    result: text('result').default('{}'), // JSON
    errorMessage: text('error_message').default(''),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp' }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => {
    const jobArticleIdExpr = sql`CASE WHEN json_valid(${table.payload}) = 1 THEN ${table.payload} ->> '$.articleId' END`;
    const jobFeedIdExpr = sql`CASE WHEN json_valid(${table.payload}) = 1 THEN ${table.payload} ->> '$.feedId' END`;
    return [
      index('idx_jobs_status').on(table.status, table.scheduledAt),
      index('idx_jobs_jev_article_id')
        .on(jobArticleIdExpr)
        .where(sql`${table.type} = 'jev_process'`),
      index('idx_jobs_active_type_status')
        .on(table.type, table.status)
        .where(sql`${table.status} IN ('queued', 'processing')`),
      index('idx_jobs_active_article_lookup')
        .on(table.type, jobArticleIdExpr, table.status, table.createdAt)
        .where(sql`${table.status} IN ('queued', 'processing')`),
      index('idx_jobs_active_feed_lookup')
        .on(table.type, jobFeedIdExpr, table.status, table.createdAt)
        .where(sql`${table.status} IN ('queued', 'processing')`),
      index('idx_jobs_queue_claim')
        .on(table.status, table.scheduledAt, table.createdAt)
        .where(sql`${table.status} = 'queued'`),
      index('idx_jobs_queued_next_due')
        .on(
          sql`CASE WHEN ${table.scheduledAt} IS NOT NULL THEN ${table.scheduledAt} ELSE ${table.createdAt} END`,
        )
        .where(sql`${table.status} = 'queued'`),
      index('idx_jobs_processing_lease')
        .on(table.startedAt)
        .where(
          sql`${table.status} = 'processing' AND ${table.startedAt} IS NOT NULL`,
        ),
      index('idx_jobs_feed_latest').on(
        table.type,
        jobFeedIdExpr,
        sql`${table.createdAt} DESC`,
      ),
      index('idx_jobs_prunable_completed')
        .on(table.completedAt)
        .where(
          sql`${table.type} IN ('feed_fetch', 'article_crawl', 'ai_process') AND ${table.status} IN ('completed', 'failed')`,
        ),
    ];
  },
);

// ── User Interactions ──
export const userInteractions = sqliteTable(
  'user_interactions',
  {
    id: text('id').primaryKey(),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    interactionType: text('interaction_type').notNull(), // read, hide, save, thumbs_up, thumbs_down, boost
    timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
    metadata: text('metadata').default('{}'), // JSON for extra data
  },
  (table) => [
    index('idx_interactions_article').on(table.articleId),
    index('idx_user_interactions_type_article').on(
      table.interactionType,
      table.articleId,
    ),
  ],
);

// ── User Preference Memory ──
export const userPreferenceMemory = sqliteTable(
  'user_preference_memory',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    type: text('type').notNull(), // topic, entity, signal, author, content_type, negative_filter
    polarity: text('polarity').notNull().default('positive'), // positive, negative
    strength: real('strength').notNull().default(0.5),
    evidenceCount: integer('evidence_count').notNull().default(1),
    lastReinforced: integer('last_reinforced', { mode: 'timestamp' }).notNull(),
    explanation: text('explanation').default(''),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('idx_pref_type_label').on(table.type, table.label),
    index('idx_pref_last_reinforced').on(table.lastReinforced),
  ],
);

export const userPreferenceMemoryArchive = sqliteTable(
  'user_preference_memory_archive',
  {
    originalId: text('original_id').primaryKey(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    polarity: text('polarity').notNull(),
    strength: real('strength').notNull(),
    evidenceCount: integer('evidence_count').notNull(),
    lastReinforced: integer('last_reinforced', { mode: 'timestamp' }).notNull(),
    explanation: text('explanation').default(''),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    archiveReason: text('archive_reason').notNull(),
    archivedAt: integer('archived_at', { mode: 'timestamp' }).notNull(),
  },
);

export const providerConfigs = sqliteTable('provider_configs', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  modelId: text('model_id').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').default(''),
  apiKeyNonce: text('api_key_nonce').default(''),
  customBaseUrl: text('custom_base_url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const rankingRefreshQueue = sqliteTable(
  'ranking_refresh_queue',
  {
    articleId: text('article_id')
      .primaryKey()
      .references(() => articles.id, { onDelete: 'cascade' }),
    requestedRevision: integer('requested_revision').notNull(),
    heuristicRevision: integer('heuristic_revision'),
    notBefore: integer('not_before', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('idx_ranking_refresh_due').on(table.notBefore, table.createdAt),
  ],
);

// ── Webhooks ──
export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  name: text('name').notNull(),
  secret: text('secret'), // signing secret
  events: text('events').notNull().default('[]'), // JSON array of event types
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const appErrorLogs = sqliteTable(
  'app_error_logs',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    message: text('message').notNull(),
    details: text('details').default('{}'),
    path: text('path').default(''),
    method: text('method').default(''),
    stack: text('stack').default(''),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('idx_app_error_logs_created').on(table.createdAt)],
);
