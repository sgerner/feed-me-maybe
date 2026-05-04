import { getDb } from './index';

export function initializeDatabase(): void {
  const db = getDb();

  db.prepare(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT DEFAULT '', custom_title INTEGER NOT NULL DEFAULT 0, description TEXT DEFAULT '', site_url TEXT DEFAULT '', category TEXT DEFAULT '', icon_url TEXT DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, error_count INTEGER NOT NULL DEFAULT 0, last_fetch_status TEXT DEFAULT 'never', last_fetch_at INTEGER, last_error TEXT DEFAULT '', etag TEXT, last_modified_header TEXT, poll_interval_mins INTEGER DEFAULT 15, open_mode TEXT, last_changed_at INTEGER, fetch_count_since_change INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  ).run();

  try {
    db.prepare("ALTER TABLE feeds ADD COLUMN source_metadata TEXT DEFAULT '{}'").run();
  } catch {
    /* ignore */
  }

  try {
    db.prepare("ALTER TABLE articles ADD COLUMN external_url TEXT DEFAULT ''").run();
  } catch {
    /* ignore */
  }

  try {
    db.prepare(
      'ALTER TABLE feeds ADD COLUMN custom_title INTEGER NOT NULL DEFAULT 0',
    ).run();
  } catch {
    /* ignore */
  }

  try {
    db.prepare(
      "ALTER TABLE feeds ADD COLUMN source_type TEXT DEFAULT 'rss'",
    ).run();
  } catch {
    /* ignore */
  }

  try {
    db.prepare(
      "ALTER TABLE feeds ADD COLUMN source_metadata TEXT DEFAULT '{}'",
    ).run();
  } catch {
    /* ignore */
  }
  db.prepare(
    "CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, guid TEXT DEFAULT '', url TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Untitled', author TEXT DEFAULT '', summary TEXT DEFAULT '', content TEXT DEFAULT '', image_url TEXT DEFAULT '', categories TEXT DEFAULT '', published_at INTEGER, fetched_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, thumbs_up INTEGER NOT NULL DEFAULT 0, thumbs_down INTEGER NOT NULL DEFAULT 0, heuristic_score REAL DEFAULT 0, combined_score REAL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS article_ai_metadata (id TEXT PRIMARY KEY, article_id TEXT NOT NULL UNIQUE REFERENCES articles(id) ON DELETE CASCADE, summary TEXT DEFAULT '', topics TEXT DEFAULT '[]', entities TEXT DEFAULT '[]', content_type TEXT DEFAULT '', ai_relevance_score REAL DEFAULT 0, novelty_score REAL DEFAULT 0, quality_score REAL DEFAULT 0, likely_user_interest TEXT DEFAULT '', positive_signals TEXT DEFAULT '[]', negative_signals TEXT DEFAULT '[]', explanation TEXT DEFAULT '', processed_at INTEGER, created_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS feed_fetch_logs (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', articles_found INTEGER DEFAULT 0, articles_new INTEGER DEFAULT 0, error_message TEXT DEFAULT '', started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload TEXT DEFAULT '{}', result TEXT DEFAULT '{}', error_message TEXT DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, scheduled_at INTEGER, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS user_interactions (id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE, interaction_type TEXT NOT NULL, timestamp INTEGER NOT NULL, metadata TEXT DEFAULT '{}')",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS user_preference_memory (id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL, polarity TEXT NOT NULL DEFAULT 'positive', strength REAL NOT NULL DEFAULT 0.5, evidence_count INTEGER NOT NULL DEFAULT 1, last_reinforced INTEGER NOT NULL, explanation TEXT DEFAULT '', created_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, api_key_encrypted TEXT DEFAULT '', api_key_nonce TEXT DEFAULT '', custom_base_url TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  ).run();

  // Create indexes for common queries
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_articles_feed_id ON articles(feed_id)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC)',
  ).run();
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_feed_url ON articles(feed_id, url)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_fetch_logs_feed_id ON feed_fetch_logs(feed_id)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_fetch_logs_status ON feed_fetch_logs(status)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, scheduled_at)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_interactions_article ON user_interactions(article_id)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_pref_type_label ON user_preference_memory(type, label)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_pref_last_reinforced ON user_preference_memory(last_reinforced)',
  ).run();

  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = 'setup_complete'")
    .get() as { value: string } | undefined;

  // Ensure default settings
  db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('poll_interval_mins', '15', ?)",
  ).run(Date.now());
  db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('article_open_mode', 'app', ?)",
  ).run(Date.now());
  db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('hide_on_open', 'true', ?)",
  ).run(Date.now());

  console.log('[db] Database initialized. First run:', !row);
}
