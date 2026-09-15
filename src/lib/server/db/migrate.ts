import { getDb } from './index';

type Database = ReturnType<typeof getDb>;

type Migration = {
  version: number;
  name: string;
  apply: (db: Database) => void;
};

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return columns.some((candidate) => candidate.name === column);
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!hasColumn(db, table, column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'article_state_search_foundation',
    apply: (db) => {
      // Additive fields preserve the existing read/hidden/saved/reaction flags.
      ensureColumn(db, 'articles', 'read_at', 'INTEGER');
      ensureColumn(db, 'articles', 'saved_at', 'INTEGER');
      ensureColumn(db, 'articles', 'hidden_at', 'INTEGER');
      ensureColumn(db, 'articles', 'rejected', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'articles', 'rejected_at', 'INTEGER');
      ensureColumn(
        db,
        'articles',
        'state_version',
        'INTEGER NOT NULL DEFAULT 0',
      );

      // Backfill explicit timestamps from the existing interaction history.
      db.prepare(
        `
        UPDATE articles
        SET read_at = CASE
              WHEN read = 1 THEN COALESCE(
                (SELECT MAX(timestamp) FROM user_interactions
                 WHERE article_id = articles.id AND interaction_type IN ('read', 'open')),
                COALESCE(updated_at, created_at, fetched_at)
              )
              ELSE NULL
            END,
            saved_at = CASE
              WHEN saved = 1 THEN COALESCE(
                (SELECT MAX(timestamp) FROM user_interactions
                 WHERE article_id = articles.id AND interaction_type = 'save'),
                COALESCE(updated_at, created_at, fetched_at)
              )
              ELSE NULL
            END,
            hidden_at = CASE
              WHEN hidden = 1 THEN COALESCE(
                (SELECT MAX(timestamp) FROM user_interactions
                 WHERE article_id = articles.id AND interaction_type = 'hide'),
                COALESCE(updated_at, created_at, fetched_at)
              )
              ELSE NULL
            END,
            rejected = CASE WHEN thumbs_down = 1 THEN 1 ELSE 0 END,
            rejected_at = CASE
              WHEN thumbs_down = 1 THEN COALESCE(
                (SELECT MAX(timestamp) FROM user_interactions
                 WHERE article_id = articles.id AND interaction_type = 'thumbs_down'),
                COALESCE(updated_at, created_at, fetched_at)
              )
              ELSE NULL
            END
      `,
      ).run();

      db.prepare(
        `
        CREATE TABLE IF NOT EXISTS article_state_history (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          action TEXT NOT NULL,
          before_state TEXT NOT NULL DEFAULT '{}',
          after_state TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          undone_at INTEGER
        )
      `,
      ).run();
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_article_state_history_operation ON article_state_history(operation_id)',
      ).run();
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_article_state_history_article ON article_state_history(article_id, created_at)',
      ).run();
      db.prepare(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_article_state_history_idempotency ON article_state_history(idempotency_key, article_id)',
      ).run();

      db.prepare(
        `
        CREATE TABLE IF NOT EXISTS saved_searches (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          query TEXT NOT NULL DEFAULT '',
          description TEXT DEFAULT '',
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
      ).run();
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_saved_searches_updated ON saved_searches(updated_at)',
      ).run();

      db.prepare(
        `
        CREATE VIRTUAL TABLE IF NOT EXISTS article_search USING fts5(
          article_id UNINDEXED,
          title,
          author,
          summary,
          content,
          feed_title,
          category,
          tokenize = 'unicode61 remove_diacritics 2'
        )
      `,
      ).run();

      // Rebuild once during migration, then let SQLite keep the index current.
      db.prepare('DELETE FROM article_search').run();
      db.prepare(
        `
        INSERT INTO article_search(article_id, title, author, summary, content, feed_title, category)
        SELECT a.id, COALESCE(a.title, ''), COALESCE(a.author, ''),
               COALESCE(a.summary, ''), COALESCE(a.content, ''),
               COALESCE(f.title, ''), COALESCE(f.category, '')
        FROM articles a JOIN feeds f ON f.id = a.feed_id
      `,
      ).run();

      db.prepare(
        `
        CREATE TRIGGER IF NOT EXISTS articles_search_after_insert
        AFTER INSERT ON articles
        BEGIN
          INSERT INTO article_search(article_id, title, author, summary, content, feed_title, category)
          SELECT NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.author, ''),
                 COALESCE(NEW.summary, ''), COALESCE(NEW.content, ''),
                 COALESCE(f.title, ''), COALESCE(f.category, '')
          FROM feeds f WHERE f.id = NEW.feed_id;
        END
      `,
      ).run();
      db.prepare(
        `
        CREATE TRIGGER IF NOT EXISTS articles_search_after_update
        AFTER UPDATE OF feed_id, title, author, summary, content, categories ON articles
        BEGIN
          DELETE FROM article_search WHERE article_id = OLD.id;
          INSERT INTO article_search(article_id, title, author, summary, content, feed_title, category)
          SELECT NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.author, ''),
                 COALESCE(NEW.summary, ''), COALESCE(NEW.content, ''),
                 COALESCE(f.title, ''), COALESCE(f.category, '')
          FROM feeds f WHERE f.id = NEW.feed_id;
        END
      `,
      ).run();
      db.prepare(
        `
        CREATE TRIGGER IF NOT EXISTS articles_search_after_delete
        AFTER DELETE ON articles
        BEGIN
          DELETE FROM article_search WHERE article_id = OLD.id;
        END
      `,
      ).run();
      db.prepare(
        `
        CREATE TRIGGER IF NOT EXISTS feeds_search_after_update
        AFTER UPDATE OF title, category ON feeds
        BEGIN
          DELETE FROM article_search
          WHERE article_id IN (SELECT id FROM articles WHERE feed_id = OLD.id);
          INSERT INTO article_search(article_id, title, author, summary, content, feed_title, category)
          SELECT a.id, COALESCE(a.title, ''), COALESCE(a.author, ''),
                 COALESCE(a.summary, ''), COALESCE(a.content, ''),
                 COALESCE(NEW.title, ''), COALESCE(NEW.category, '')
          FROM articles a WHERE a.feed_id = NEW.id;
        END
      `,
      ).run();

      // Legacy interaction writes receive explicit timestamps and rejection
      // compatibility. Article-state API writes manage state_version itself;
      // the trigger only writes derived fields and cannot recurse.
      db.prepare(
        `
        CREATE TRIGGER IF NOT EXISTS articles_state_after_update
        AFTER UPDATE OF read, saved, hidden, thumbs_down ON articles
        WHEN OLD.read IS NOT NEW.read
          OR OLD.saved IS NOT NEW.saved
          OR OLD.hidden IS NOT NEW.hidden
          OR OLD.thumbs_down IS NOT NEW.thumbs_down
        BEGIN
          UPDATE articles
          SET read_at = CASE
                WHEN NEW.read = 1 THEN COALESCE(NEW.read_at, strftime('%s', 'now') * 1000)
                ELSE NULL
              END,
              saved_at = CASE
                WHEN NEW.saved = 1 THEN COALESCE(NEW.saved_at, strftime('%s', 'now') * 1000)
                ELSE NULL
              END,
              hidden_at = CASE
                WHEN NEW.hidden = 1 THEN COALESCE(NEW.hidden_at, strftime('%s', 'now') * 1000)
                ELSE NULL
              END,
              rejected = NEW.thumbs_down,
              rejected_at = CASE
                WHEN NEW.thumbs_down = 1 THEN COALESCE(NEW.rejected_at, strftime('%s', 'now') * 1000)
                ELSE NULL
              END
          WHERE id = NEW.id;
        END
      `,
      ).run();
    },
  },
];

function runVersionedMigrations(): void {
  const db = getDb();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  ).run();

  for (const migration of migrations) {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(migration.version);
    if (applied) continue;

    const applyMigration = db.transaction(() => {
      migration.apply(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, Date.now());
    });
    applyMigration();
  }
}

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
    db.prepare(
      "ALTER TABLE feeds ADD COLUMN source_metadata TEXT DEFAULT '{}'",
    ).run();
  } catch {
    /* Existing databases already have this column. */
  }
  try {
    db.prepare(
      "ALTER TABLE articles ADD COLUMN external_url TEXT DEFAULT ''",
    ).run();
  } catch {
    /* Existing databases already have this column. */
  }
  try {
    db.prepare(
      'ALTER TABLE articles ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0',
    ).run();
  } catch {
    /* Existing databases already have this column. */
  }
  try {
    db.prepare(
      'ALTER TABLE feeds ADD COLUMN custom_title INTEGER NOT NULL DEFAULT 0',
    ).run();
  } catch {
    /* Existing databases already have this column. */
  }
  try {
    db.prepare(
      "ALTER TABLE feeds ADD COLUMN source_type TEXT DEFAULT 'rss'",
    ).run();
  } catch {
    /* Existing databases already have this column. */
  }
  try {
    db.prepare(
      'ALTER TABLE feeds ADD COLUMN use_proxy INTEGER NOT NULL DEFAULT 0',
    ).run();
  } catch {
    /* Existing databases already have this column. */
  }

  db.prepare(
    "CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, guid TEXT DEFAULT '', url TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Untitled', author TEXT DEFAULT '', summary TEXT DEFAULT '', content TEXT DEFAULT '', image_url TEXT DEFAULT '', categories TEXT DEFAULT '', published_at INTEGER, fetched_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, thumbs_up INTEGER NOT NULL DEFAULT 0, thumbs_down INTEGER NOT NULL DEFAULT 0, heuristic_score REAL DEFAULT 0, combined_score REAL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS article_ai_metadata (id TEXT PRIMARY KEY, article_id TEXT NOT NULL UNIQUE REFERENCES articles(id) ON DELETE CASCADE, summary TEXT DEFAULT '', topics TEXT DEFAULT '[]', entities TEXT DEFAULT '[]', content_type TEXT DEFAULT '', ai_relevance_score REAL DEFAULT 0, novelty_score REAL DEFAULT 0, quality_score REAL DEFAULT 0, likely_user_interest TEXT DEFAULT '', signals TEXT DEFAULT '[]', explanation TEXT DEFAULT '', processed_at INTEGER, created_at INTEGER NOT NULL)",
  ).run();
  try {
    db.prepare(
      'ALTER TABLE article_ai_metadata DROP COLUMN positive_signals',
    ).run();
  } catch {
    /* Legacy databases may not have this column. */
  }
  try {
    db.prepare(
      'ALTER TABLE article_ai_metadata DROP COLUMN negative_signals',
    ).run();
  } catch {
    /* Legacy databases may not have this column. */
  }
  try {
    db.prepare(
      "ALTER TABLE article_ai_metadata ADD COLUMN signals TEXT DEFAULT '[]'",
    ).run();
  } catch {
    /* Existing databases already have this column. */
  }
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
  db.prepare(
    "CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, secret TEXT, events TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  ).run();
  db.prepare(
    "CREATE TABLE IF NOT EXISTS app_error_logs (id TEXT PRIMARY KEY, source TEXT NOT NULL, message TEXT NOT NULL, details TEXT DEFAULT '{}', path TEXT DEFAULT '', method TEXT DEFAULT '', stack TEXT DEFAULT '', created_at INTEGER NOT NULL)",
  ).run();

  runVersionedMigrations();

  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_articles_feed_id ON articles(feed_id)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_articles_visible_rank ON articles(COALESCE(combined_score, heuristic_score, 0) DESC, published_at DESC) WHERE hidden = 0',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_articles_feed_visible_rank ON articles(feed_id, COALESCE(combined_score, heuristic_score, 0) DESC, published_at DESC) WHERE hidden = 0',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_articles_saved_published ON articles(published_at DESC) WHERE saved = 1',
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
