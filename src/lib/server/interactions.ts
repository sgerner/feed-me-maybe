import { getDb } from '$lib/server/db';
import crypto from 'node:crypto';

export type InteractionType = 'read' | 'hide' | 'save' | 'thumbs_up' | 'thumbs_down' | 'unhide' | 'unsave' | 'open';

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
    case 'open':
      // Open implies read
      db.prepare('UPDATE articles SET read = 1 WHERE id = ?').run(articleId);
      
      // Handle "Hide on Open" global setting
      const hideSetting = db.prepare("SELECT value FROM app_settings WHERE key = 'hide_on_open'").get() as { value: string } | undefined;
      if (hideSetting?.value === 'true') {
        db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(articleId);
        // Also record a hide interaction but mark it as auto in metadata so we could potentially ignore it in scoring
        db.prepare(
          'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)'
        ).run(crypto.randomUUID(), articleId, 'hide', now, '{"auto":true}');
      }
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
      SUM(CASE WHEN interaction_type = 'hide' AND (metadata IS NULL OR json_extract(metadata, '$.auto') IS NULL) THEN 1 ELSE 0 END) as hides,
      SUM(CASE WHEN interaction_type = 'thumbs_up' THEN 1 ELSE 0 END) as thumbs_up,
      SUM(CASE WHEN interaction_type = 'thumbs_down' THEN 1 ELSE 0 END) as thumbs_down,
      SUM(CASE WHEN interaction_type = 'open' THEN 1 ELSE 0 END) as opens
    FROM user_interactions WHERE article_id = ?
  `).get(articleId) as Record<string, number>;

  const score = 50 // Base score
    + (stats.reads || 0) * 2
    + (stats.opens || 0) * 15
    + (stats.saves || 0) * 8
    - (stats.hides || 0) * 10
    + (stats.thumbs_up || 0) * 5
    - (stats.thumbs_down || 0) * 8;

  const clamped = Math.max(0, Math.min(100, score));
  db.prepare('UPDATE articles SET heuristic_score = ? WHERE id = ?').run(clamped, articleId);
}