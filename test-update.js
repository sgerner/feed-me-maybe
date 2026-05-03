import Database from 'better-sqlite3';
const dbPath = 'data/feed-me-maybe.db';
const db = new Database(dbPath);

console.log(
  'Feed before:',
  db
    .prepare(
      "SELECT title, custom_title FROM feeds WHERE id = '991c45c9-c34d-4325-8839-b2eee7ec0e4f'",
    )
    .get(),
);

db.prepare(
  'UPDATE feeds SET title = ?, custom_title = 1, category = ? WHERE id = ?',
).run('New Title', 'News', '991c45c9-c34d-4325-8839-b2eee7ec0e4f');

console.log(
  'Feed after:',
  db
    .prepare(
      "SELECT title, custom_title FROM feeds WHERE id = '991c45c9-c34d-4325-8839-b2eee7ec0e4f'",
    )
    .get(),
);
