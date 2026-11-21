import { getDb } from '#lib/server/db/index.ts';
import crypto from 'node:crypto';
import {
  updateHeuristicScore,
  updatePreferenceMemoryFromInteraction,
} from '#lib/server/preferences.ts';
import {
  refreshRankingAfterFeedback,
  refreshRankingAfterProfileMutation,
} from '#lib/server/ranking-freshness.ts';
import { dispatchWebhookEvent } from '#lib/server/webhooks.ts';

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
  options: { visibleArticleIds?: unknown } = {},
): void {
  const db = getDb();
  const now = Date.now();
  let firstOpen = true;

  // Repeated clicks on an already active reaction should not multiply
  // preference evidence. A different reaction still replaces the current
  // state through the normal path below.
  if (type === 'thumbs_up' || type === 'thumbs_down') {
    const current = db
      .prepare(
        'SELECT thumbs_up, thumbs_down, rejected, hidden FROM articles WHERE id = ?',
      )
      .get(articleId) as
      | {
          thumbs_up: number;
          thumbs_down: number;
          rejected: number;
          hidden: number;
        }
      | undefined;
    if (
      (type === 'thumbs_up' &&
        current?.thumbs_up === 1 &&
        current.thumbs_down === 0 &&
        current.rejected === 0) ||
      (type === 'thumbs_down' &&
        current?.thumbs_down === 1 &&
        current.thumbs_up === 0 &&
        current.rejected === 1 &&
        current.hidden === 1)
    ) {
      return;
    }
  }

  // An article can be loaded more than once by SSR, reloads, or client
  // navigation. Keep one implicit open signal per article so repeat visits do
  // not overwhelm explicit feedback in the preference model.
  const insertInteraction = db.prepare(
    'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
  );
  if (type === 'open') {
    const inserted = db
      .prepare(
        `INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata)
         SELECT ?, ?, 'open', ?, '{}'
         WHERE NOT EXISTS (
           SELECT 1 FROM user_interactions
           WHERE article_id = ? AND interaction_type = 'open'
         )`,
      )
      .run(crypto.randomUUID(), articleId, now, articleId);
    firstOpen = inserted.changes > 0;
  } else {
    insertInteraction.run(crypto.randomUUID(), articleId, type, now, '{}');
  }

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
        'UPDATE articles SET hidden = 0, hidden_at = NULL, cleared_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, articleId);
      break;
    case 'boost': {
      db.prepare(
        'UPDATE articles SET thumbs_up = 1, thumbs_down = 0, rejected = 0, rejected_at = NULL, hidden = 0, hidden_at = NULL, cleared_at = NULL, updated_at = ? WHERE id = ?',
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
        'UPDATE articles SET thumbs_up = 0, thumbs_down = 1, rejected = 1, rejected_at = COALESCE(rejected_at, ?), hidden = 1, hidden_at = COALESCE(hidden_at, ?), cleared_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, now, now, articleId);
      break;
    case 'open':
      // Open implies read
      db.prepare(
        'UPDATE articles SET read = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ?',
      ).run(now, now, articleId);

      // Trigger the read webhook only on the first open for this article.
      if (firstOpen) {
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
          const hidden = db
            .prepare(
              'UPDATE articles SET hidden = 1, hidden_at = COALESCE(hidden_at, ?), updated_at = ? WHERE id = ? AND hidden = 0',
            )
            .run(now, now, articleId);
          if (hidden.changes > 0) {
            // Automatic hides are state management, not negative feedback.
            insertInteraction.run(
              crypto.randomUUID(),
              articleId,
              'hide',
              now,
              '{"auto":true,"reason":"hide_on_open"}',
            );
          }
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

  if (
    type === 'thumbs_up' ||
    type === 'thumbs_down' ||
    type === 'boost' ||
    type === 'save' ||
    type === 'hide'
  ) {
    refreshRankingAfterFeedback({
      articleIds: [articleId],
      type,
      visibleArticleIds: options.visibleArticleIds,
      interactionAlreadyRecorded: true,
    });
    return;
  }

  if (type === 'open' && !firstOpen) {
    // A prior unread action may have changed the heuristic inputs since the
    // first open, even though this visit adds no new preference evidence.
    updateHeuristicScore(articleId);
    return;
  }

  updatePreferenceMemoryFromInteraction(articleId, type);
  if (type === 'open' || type === 'read') {
    refreshRankingAfterProfileMutation(articleId);
    return;
  }
  updateHeuristicScore(articleId);
}
