import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATABASE_URL } from '$app/env/private';
import { stripHtml } from '#lib/server/normalization.ts';

let db: Database.Database | null = null;

export function registerDbFunctions(database: Database.Database): void {
  if (typeof database.function !== 'function') return;
  database.function('strip_html', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? stripHtml(value) : '',
  );
}

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath =
    process.env.DATABASE_URL || DATABASE_URL || './data/feed-me-maybe.db';
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Keep feed refreshes responsive without forcing a full fsync for every
  // small interaction. WAL still protects readers while a refresh is writing.
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');
  registerDbFunctions(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
