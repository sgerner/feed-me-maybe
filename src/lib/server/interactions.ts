import { getDb } from '$lib/server/db';
import crypto from 'node:crypto';

export type InteractionType = 'read' | 'hide' | 'save' | 'thumbs_up' | 'thumbs_down' | 'unhide' | 'unsave';

export function recordInteraction(articleId: string, type: InteractionType): void {
  const db = getDb();
  const now = Date.now();

  // Record the interaction
  db.prepare(
    'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), articleId, type, now, '{}');

  // Apply side effects to article
  switch (type) {
    case 'save':
      db.prepare('UPDATE articles SET saved = 1 WHERE id = ?').run(articleId);
      break;
    case 'unsave':
      db.prepare('UPDATE articles SET saved = 0 WHERE id = ?').run(articleId);
      break;
    case 'hide':
      db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(articleId);
      break;
    case 'unhide':
      db.prepare('UPDATE articles SET hidden = 0 WHERE id = ?').run(articleId);
      break;
    case 'thumbs_up':
      db.prepare('UPDATE articles SET thumbs_up = 1, thumbs_down = 0 WHERE id = ?').run(articleId);
      break;
    case 'thumbs_down':
      db.prepare('UPDATE articles SET thumbs_up = 0, thumbs_down = 1 WHERE id = ?').run(articleId);
      break;
    case 'read':
      db.prepare('UPDATE articles SET read = 1 WHERE id = ?').run(articleId);
      break;
  }

  // Update heuristic score
  recalculateScore(articleId);
}

function recalculateScore(articleId: string): void {
  const db = getDb();

  // Get interaction stats for this article
  const stats = db.prepare(`
    SELECT 
      SUM(CASE WHEN interaction_type = 'read' THEN 1 ELSE 0 END) as reads,
      SUM(CASE WHEN interaction_type = 'save' THEN 1 ELSE 0 END) as saves,
      SUM(CASE WHEN interaction_type = 'hide' THEN 1 ELSE 0 END) as hides,
      SUM(CASE WHEN interaction_type = 'thumbs_up' THEN 1 ELSE 0 END) as thumbs_up,
      SUM(CASE WHEN interaction_type = 'thumbs_down' THEN 1 ELSE 0 END) as thumbs_down
    FROM user_interactions WHERE article_id = ?
  `).get(articleId) as Record<string, number>;

  const score = 50 // Base score
    + (stats.reads || 0) * 2
    + (stats.saves || 0) * 8
    - (stats.hides || 0) * 10
    + (stats.thumbs_up || 0) * 5
    - (stats.thumbs_down || 0) * 8;

  const clamped = Math.max(0, Math.min(100, score));
  db.prepare('UPDATE articles SET heuristic_score = ? WHERE id = ?').run(clamped, articleId);
}