import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── Auth ──
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('admin'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull()
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

// ── Feeds ──
export const feeds = sqliteTable('feeds', {
  id: text('id').primaryKey(),
  url: text('url').notNull().unique(),
  title: text('title').default(''),
  description: text('description').default(''),
  siteUrl: text('site_url').default(''),
  category: text('category').default(''),
  iconUrl: text('icon_url').default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  errorCount: integer('error_count').notNull().default(0),
  lastFetchStatus: text('last_fetch_status').default('never'),
  lastFetchAt: integer('last_fetch_at', { mode: 'timestamp' }),
  lastError: text('last_error').default(''),
  etag: text('etag'),
  lastModifiedHeader: text('last_modified_header'),
  pollIntervalMins: integer('poll_interval_mins').default(15),
  lastChangedAt: integer('last_changed_at', { mode: 'timestamp' }),
  fetchCountSinceChange: integer('fetch_count_since_change').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

// ── Articles ──
export const articles = sqliteTable('articles', {
  id: text('id').primaryKey(),
  feedId: text('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
  guid: text('guid').default(''),
  url: text('url').notNull(),
  title: text('title').notNull().default('Untitled'),
  author: text('author').default(''),
  summary: text('summary').default(''),
  content: text('content').default(''),
  imageUrl: text('image_url').default(''),
  categories: text('categories').default(''), // JSON array of category strings
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  saved: integer('saved', { mode: 'boolean' }).notNull().default(false),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  thumbsUp: integer('thumbs_up', { mode: 'boolean' }).notNull().default(false),
  thumbsDown: integer('thumbs_down', { mode: 'boolean' }).notNull().default(false),
  heuristicScore: real('heuristic_score').default(0),
  combinedScore: real('combined_score').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
}, (table) => ({
  feedIdIdx: index('idx_articles_feed_id').on(table.feedId),
  publishedAtIdx: index('idx_articles_published_at').on(table.publishedAt),
  feedUrlUnique: uniqueIndex('idx_articles_feed_url').on(table.feedId, table.url)
}));

// ── Article AI Metadata ──
export const articleAiMetadata = sqliteTable('article_ai_metadata', {
  id: text('id').primaryKey(),
  articleId: text('article_id').notNull().unique().references(() => articles.id, { onDelete: 'cascade' }),
  summary: text('summary').default(''),
  topics: text('topics').default('[]'), // JSON array
  entities: text('entities').default('[]'), // JSON array
  contentType: text('content_type').default(''),
  aiRelevanceScore: real('ai_relevance_score').default(0),
  noveltyScore: real('novelty_score').default(0),
  qualityScore: real('quality_score').default(0),
  likelyUserInterest: text('likely_user_interest').default(''),
  positiveSignals: text('positive_signals').default('[]'),
  negativeSignals: text('negative_signals').default('[]'),
  explanation: text('explanation').default(''),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
});

// ── Feed Fetch Logs ──
export const feedFetchLogs = sqliteTable('feed_fetch_logs', {
  id: text('id').primaryKey(),
  feedId: text('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), // pending, fetching, success, error
  articlesFound: integer('articles_found').default(0),
  articlesNew: integer('articles_new').default(0),
  errorMessage: text('error_message').default(''),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
});

// ── Jobs ──
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // feed_fetch, ai_process, memory_summarize
  status: text('status').notNull().default('queued'), // queued, processing, completed, failed
  payload: text('payload').default('{}'), // JSON
  result: text('result').default('{}'), // JSON
  errorMessage: text('error_message').default(''),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  scheduledAt: integer('scheduled_at', { mode: 'timestamp' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
});

// ── User Interactions ──
export const userInteractions = sqliteTable('user_interactions', {
  id: text('id').primaryKey(),
  articleId: text('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  interactionType: text('interaction_type').notNull(), // read, hide, save, thumbs_up, thumbs_down
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  metadata: text('metadata').default('{}') // JSON for extra data
});

// ── User Preference Memory ──
export const userPreferenceMemory = sqliteTable('user_preference_memory', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  type: text('type').notNull(), // topic, source, style, entity, content_type, negative_filter
  polarity: text('polarity').notNull().default('positive'), // positive, negative
  strength: real('strength').notNull().default(0.5),
  evidenceCount: integer('evidence_count').notNull().default(1),
  lastReinforced: integer('last_reinforced', { mode: 'timestamp' }).notNull(),
  explanation: text('explanation').default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
});