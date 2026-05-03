import { getDb } from './src/lib/server/db/index.js';
import { ingestFeed } from './src/lib/server/feed/ingester.js';
import Database from 'better-sqlite3';

const dbPath = 'data/feed-me-maybe.db';
const db = new Database(dbPath);

async function test() {
  const feedId = '991c45c9-c34d-4325-8839-b2eee7ec0e4f'; // from previous run
  console.log("Feed before ingest:", db.prepare("SELECT title, custom_title FROM feeds WHERE id = ?").get(feedId));

  const url = db.prepare("SELECT url FROM feeds WHERE id = ?").get(feedId).url;
  
  await ingestFeed({ feedId, url });
  
  console.log("Feed after ingest:", db.prepare("SELECT title, custom_title FROM feeds WHERE id = ?").get(feedId));
}

test().catch(console.error);
