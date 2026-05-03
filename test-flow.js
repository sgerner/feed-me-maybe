import Database from 'better-sqlite3';
import { getDb } from './src/lib/server/db/index.js';
import crypto from 'node:crypto';

const dbPath = 'data/feed-me-maybe.db';
const db = new Database(dbPath);

console.log('Testing feed insertion and update:');

// 1. Insert a new feed
const id = crypto.randomUUID();
const url = 'https://news.ycombinator.com/rss';
const title = 'Custom HN';
const category = 'News';
const now = Date.now();

db.prepare(
  'INSERT INTO feeds (id, url, title, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
).run(id, url, title, category, now, now);

console.log('After insert:', db.prepare('SELECT id, title, custom_title FROM feeds WHERE id = ?').get(id));

// 2. Fetcher overwrites it because custom_title is 0
const updates = [];
const values = [];
const fetchResultTitle = 'Hacker News';
const feedRecord1 = db.prepare('SELECT custom_title FROM feeds WHERE id = ?').get(id);

if (fetchResultTitle && !feedRecord1.custom_title) {
  updates.push('title = ?');
  values.push(fetchResultTitle);
}

if (updates.length > 0) {
  updates.push('updated_at = ?');
  values.push(Date.now(), id);
  db.prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

console.log('After ingest 1:', db.prepare('SELECT id, title, custom_title FROM feeds WHERE id = ?').get(id));

// 3. User updates title to "My Awesome HN"
const userTitle = 'My Awesome HN';
const patchUpdates = ['title = ?', 'custom_title = 1', 'updated_at = ?'];
const patchValues = [userTitle, Date.now(), id];
db.prepare(`UPDATE feeds SET ${patchUpdates.join(', ')} WHERE id = ?`).run(...patchValues);

console.log('After user patch:', db.prepare('SELECT id, title, custom_title FROM feeds WHERE id = ?').get(id));

// 4. Ingester runs again
const updates2 = [];
const values2 = [];
const feedRecord2 = db.prepare('SELECT custom_title FROM feeds WHERE id = ?').get(id);

if (fetchResultTitle && !feedRecord2.custom_title) {
  updates2.push('title = ?');
  values2.push(fetchResultTitle);
}

if (updates2.length > 0) {
  updates2.push('updated_at = ?');
  values2.push(Date.now(), id);
  db.prepare(`UPDATE feeds SET ${updates2.join(', ')} WHERE id = ?`).run(...values2);
}

console.log('After ingest 2:', db.prepare('SELECT id, title, custom_title FROM feeds WHERE id = ?').get(id));

