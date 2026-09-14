import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath =
    process.env.DATABASE_URL || env.DATABASE_URL || './data/feed-me-maybe.db';
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
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
