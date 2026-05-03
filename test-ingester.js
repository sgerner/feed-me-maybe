import Database from 'better-sqlite3';

const dbPath = 'data/feed-me-maybe.db';
const db = new Database(dbPath);

const feedId = '991c45c9-c34d-4325-8839-b2eee7ec0e4f'; // the one we just updated
const feedRecord = db
  .prepare(
    'SELECT etag, last_modified_header, fetch_count_since_change, custom_title FROM feeds WHERE id = ?',
  )
  .get(feedId);

console.log('feedRecord:', feedRecord);

const fetchResult = { title: 'Original Feed Title' };

const updates = [];
const values = [];
if (fetchResult.title && !feedRecord?.custom_title) {
  updates.push('title = ?');
  values.push(fetchResult.title);
}

console.log('Updates:', updates);
console.log('Values:', values);
