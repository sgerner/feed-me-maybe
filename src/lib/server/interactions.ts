import { getDb } from '$lib/server/db';
import crypto from 'node:crypto';
import {
  updateHeuristicScore,
  updatePreferenceMemoryFromInteraction,
} from '$lib/server/preferences';
import { dispatchWebhookEvent } from '$lib/server/webhooks';

export type InteractionType =
  | 'read'
  | 'unread'
  | 'hide'
  | 'save'
  | 'thumbs_up'
  | 'thumbs_down'
  | 'boost'
  | 'unhide'
  | 'unsave'
  | 'open';

export function recordInteraction(
  articleId: string,
  type: InteractionType,
): void {
  const db = getDb();
  const now = Date.now();

  // Record the interaction
  db.prepare(
    'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), articleId, type, now, '{}');

  // Apply side effects to article
  switch (type) {
    case 'save': {
      db.prepare(
        'UPDATE articles SET saved = 1, saved_at = COALESCE(saved_at, ?), updated_at = ? WHERE id = ?',
      ).run(now, now, articleId);
      // Trigger webhook
      const article = db
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(articleId) as any;
      if (article) {
        dispatchWebhookEvent({
          type: 'article.saved',
          timestamp: now,
          payload: { article },
        });
      }
      break;
    }
    case 'unsave':
      db.prepare(
        'UPDATE articles SET saved = 0, saved_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, articleId);
      break;
    case 'hide':
      db.prepare(
        'UPDATE articles SET hidden = 1, hidden_at = COALESCE(hidden_at, ?), updated_at = ? WHERE id = ?',
      ).run(now, now, articleId);
      break;
    case 'unhide':
      db.prepare(
        'UPDATE articles SET hidden = 0, hidden_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, articleId);
      break;
    case 'boost': {
      db.prepare(
        'UPDATE articles SET thumbs_up = 1, thumbs_down = 0, rejected = 0, rejected_at = NULL, hidden = 0, hidden_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, articleId);
      db.prepare(
        'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
      ).run(crypto.randomUUID(), articleId, 'unhide', now, '{"boost":true}');
      const article = db
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(articleId) as any;
      if (article) {
        dispatchWebhookEvent({
          type: 'article.thumbs_up',
          timestamp: now,
          payload: { article },
        });
      }
      break;
    }
    case 'thumbs_up': {
      db.prepare(
        'UPDATE articles SET thumbs_up = 1, thumbs_down = 0, rejected = 0, rejected_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, articleId);
      // Trigger webhook
      const article = db
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(articleId) as any;
      if (article) {
        dispatchWebhookEvent({
          type: 'article.thumbs_up',
          timestamp: now,
          payload: { article },
        });
      }
      break;
    }
    case 'thumbs_down':
      db.prepare(
        'UPDATE articles SET thumbs_up = 0, thumbs_down = 1, rejected = 1, rejected_at = COALESCE(rejected_at, ?), hidden = 1, hidden_at = COALESCE(hidden_at, ?), updated_at = ? WHERE id = ?',
      ).run(now, now, now, articleId);
      break;
    case 'open':
      // Open implies read
      db.prepare(
        'UPDATE articles SET read = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ?',
      ).run(now, now, articleId);

      // Trigger webhook for read (via open)
      {
        const article = db
          .prepare('SELECT * FROM articles WHERE id = ?')
          .get(articleId) as any;
        if (article) {
          dispatchWebhookEvent({
            type: 'article.read',
            timestamp: now,
            payload: { article },
          });
        }
      }

      // Handle "Hide on Open" global setting
      {
        const hideSetting = db
          .prepare("SELECT value FROM app_settings WHERE key = 'hide_on_open'")
          .get() as { value: string } | undefined;
        if (hideSetting?.value === 'true') {
          db.prepare(
            'UPDATE articles SET hidden = 1, hidden_at = COALESCE(hidden_at, ?), updated_at = ? WHERE id = ?',
          ).run(now, now, articleId);
          // Also record a hide interaction but mark it as auto in metadata so we could potentially ignore it in scoring
          db.prepare(
            'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
          ).run(crypto.randomUUID(), articleId, 'hide', now, '{"auto":true}');
        }
        break;
      }
    case 'read': {
      db.prepare(
        'UPDATE articles SET read = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ?',
      ).run(now, now, articleId);
      // Trigger webhook
      const article = db
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(articleId) as any;
      if (article) {
        dispatchWebhookEvent({
          type: 'article.read',
          timestamp: now,
          payload: { article },
        });
      }
      break;
    }
    case 'unread':
      db.prepare(
        'UPDATE articles SET read = 0, read_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, articleId);
      break;
  }

  updatePreferenceMemoryFromInteraction(articleId, type);

  // Update heuristic score
  updateHeuristicScore(articleId);
}
