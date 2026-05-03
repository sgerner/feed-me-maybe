import Database from 'better-sqlite3';

const dbPath = 'data/feed-me-maybe.db';
let db;
try {
  db = new Database(dbPath);
} catch (e) {
  console.log('No DB found or could not open it.', e);
  process.exit(0);
}

console.log('Feeds schema:', db.prepare("PRAGMA table_info('feeds')").all());

const feed = db
  .prepare('SELECT id, title, custom_title FROM feeds LIMIT 1')
  .get();
console.log('Feed before update:', feed);

if (feed) {
  const updates = ['title = ?', 'custom_title = 1'];
  const values = ['My Custom Title', feed.id];
  db.prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  const feedAfter = db
    .prepare('SELECT id, title, custom_title FROM feeds WHERE id = ?')
    .get(feed.id);
  console.log('Feed after update:', feedAfter);
}
