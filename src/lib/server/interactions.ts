import { getDb } from '$lib/server/db';
import crypto from 'node:crypto';
import {
  getPreferenceStateForArticle,
  updatePreferenceMemoryFromInteraction,
} from '$lib/server/preferences';
import { dispatchWebhookEvent } from '$lib/server/webhooks';

export type InteractionType =
  | 'read'
  | 'hide'
  | 'save'
  | 'thumbs_up'
  | 'thumbs_down'
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
      db.prepare('UPDATE articles SET saved = 1 WHERE id = ?').run(articleId);
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
      db.prepare('UPDATE articles SET saved = 0 WHERE id = ?').run(articleId);
      break;
    case 'hide':
      db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(articleId);
      break;
    case 'unhide':
      db.prepare('UPDATE articles SET hidden = 0 WHERE id = ?').run(articleId);
      break;
    case 'thumbs_up': {
      db.prepare(
        'UPDATE articles SET thumbs_up = 1, thumbs_down = 0 WHERE id = ?',
      ).run(articleId);
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
        'UPDATE articles SET thumbs_up = 0, thumbs_down = 1 WHERE id = ?',
      ).run(articleId);
      break;
    case 'open':
      // Open implies read
      db.prepare('UPDATE articles SET read = 1 WHERE id = ?').run(articleId);

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
          db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(
            articleId,
          );
          // Also record a hide interaction but mark it as auto in metadata so we could potentially ignore it in scoring
          db.prepare(
            'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
          ).run(crypto.randomUUID(), articleId, 'hide', now, '{"auto":true}');
        }
        break;
      }
    case 'read': {
      db.prepare('UPDATE articles SET read = 1 WHERE id = ?').run(articleId);
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
  }

  updatePreferenceMemoryFromInteraction(articleId, type);

  // Update heuristic score
  recalculateScore(articleId);
}

function recalculateScore(articleId: string): void {
  const db = getDb();

  // Use stateful signals so repeated clicks don't compound score.
  // Penalties are only from explicit user-hide and thumbs-down.
  const article = db
    .prepare('SELECT read, thumbs_up, thumbs_down FROM articles WHERE id = ?')
    .get(articleId) as
    | {
        read: number;
        thumbs_up: number;
        thumbs_down: number;
      }
    | undefined;

  const explicitHideState = db
    .prepare(
      `
    SELECT
      SUM(
        CASE
          WHEN interaction_type = 'hide'
            AND (metadata IS NULL OR json_extract(metadata, '$.auto') IS NULL)
          THEN 1 ELSE 0
        END
      ) as explicit_hides,
      SUM(CASE WHEN interaction_type = 'unhide' THEN 1 ELSE 0 END) as unhides
    FROM user_interactions
    WHERE article_id = ?
  `,
    )
    .get(articleId) as
    | {
        explicit_hides: number;
        unhides: number;
      }
    | undefined;

  const opened = !!article?.read;
  const thumbsUp = !!article?.thumbs_up;
  const thumbsDown = !!article?.thumbs_down;
  const explicitHidden =
    (explicitHideState?.explicit_hides || 0) -
      (explicitHideState?.unhides || 0) >
    0;
  const preferenceState = getPreferenceStateForArticle(articleId);

  const score =
    50 + // Base score
    (opened ? 2 : 0) + // weak positive bias for opened articles
    (thumbsUp ? 25 : 0) - // significant positive bias for liked articles
    (thumbsDown ? 20 : 0) -
    (explicitHidden ? 10 : 0) +
    preferenceState.adjustment;

  const clamped = Math.max(0, Math.min(100, score));
  db.prepare('UPDATE articles SET heuristic_score = ? WHERE id = ?').run(
    clamped,
    articleId,
  );
}
