import { getDb } from '#lib/server/db/index.ts';
import crypto from 'node:crypto';
import {
  reversePreferenceMemoryDeltas,
  updateHeuristicScore,
  updatePreferenceMemoryFromInteraction,
  type PreferenceMemoryDelta,
} from '#lib/server/preferences.ts';
import {
  refreshRankingAfterFeedback,
  refreshRankingAfterProfileMutation,
  refreshRankingAfterReversal,
} from '#lib/server/ranking-freshness.ts';
import { dispatchWebhookEvent } from '#lib/server/webhooks.ts';

export type InteractionType =
  | 'read'
  | 'unread'
  | 'hide'
  | 'save'
  | 'thumbs_up'
  | 'unthumbs_up'
  | 'thumbs_down'
  | 'boost'
  | 'unhide'
  | 'unsave'
  | 'open';

function parseInteractionMetadata(
  value: string | null,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function retractActiveInteractions(
  articleId: string,
  interactionTypes: string[],
  now: number,
): string[] {
  if (!interactionTypes.length) return [];
  const db = getDb();
  const placeholders = interactionTypes.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, timestamp, metadata FROM user_interactions
       WHERE article_id = ?
         AND interaction_type IN (${placeholders})
         AND COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.auto'), 0) = 0
         AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.undone_at') IS NULL`,
    )
    .all(articleId, ...interactionTypes) as Array<{
    id: string;
    timestamp: number;
    metadata: string | null;
  }>;
  if (!rows.length) return [];

  const reversedKeys = new Set<string>();
  const markUndone = db.prepare(
    `UPDATE user_interactions
     SET metadata = json_set(
       CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
       '$.undone_at', ?
     ) WHERE id = ?`,
  );
  for (const row of rows) {
    const metadata = parseInteractionMetadata(row.metadata);
    for (const key of reversePreferenceMemoryDeltas(
      metadata.preference_deltas,
      Number(row.timestamp),
    )) {
      reversedKeys.add(key);
    }
    markUndone.run(now, row.id);
  }
  return [...reversedKeys];
}

export function recordInteraction(
  articleId: string,
  type: InteractionType,
  options: { visibleArticleIds?: unknown } = {},
): void {
  const db = getDb();
  const now = Date.now();
  let pendingWebhook:
    'article.saved' | 'article.thumbs_up' | 'article.read' | null = null;

  const outcome = db
    .transaction(() => {
      let firstOpen = true;

      // Repeated clicks on an already active reaction should not multiply
      // preference evidence. A different reaction still replaces the current
      // state through the normal path below.
      if (type === 'thumbs_up' || type === 'thumbs_down' || type === 'boost') {
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
          return { skipped: true as const };
        }
        if (
          type === 'boost' &&
          current?.thumbs_up === 1 &&
          current.thumbs_down === 0 &&
          current.rejected === 0 &&
          current.hidden === 0
        ) {
          const activeBoost = db
            .prepare(
              `SELECT 1 FROM user_interactions
               WHERE article_id = ? AND interaction_type = 'boost'
                 AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.undone_at') IS NULL
               LIMIT 1`,
            )
            .get(articleId);
          if (activeBoost) return { skipped: true as const };
        }
      }

      const supersededTypes =
        type === 'unsave'
          ? ['save']
          : type === 'unread'
            ? ['read']
            : type === 'unhide'
              ? ['hide', 'thumbs_down']
              : type === 'unthumbs_up'
                ? ['thumbs_up', 'boost']
                : type === 'thumbs_up'
                  ? ['thumbs_down']
                  : type === 'boost'
                    ? ['thumbs_down', 'hide', 'thumbs_up']
                    : type === 'thumbs_down'
                      ? ['thumbs_up', 'boost']
                      : [];
      const reversedFeatures = retractActiveInteractions(
        articleId,
        supersededTypes,
        now,
      );

      // An article can be loaded more than once by SSR, reloads, or client
      // navigation. Keep one implicit open signal per article so repeat visits do
      // not overwhelm explicit feedback in the preference model.
      const insertInteraction = db.prepare(
        'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
      );
      let recordedOpenId: string | null = null;
      if (type === 'open') {
        const openId = crypto.randomUUID();
        const inserted = db
          .prepare(
            `INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata)
             SELECT ?, ?, 'open', ?, '{}'
             WHERE NOT EXISTS (
               SELECT 1 FROM user_interactions
               WHERE article_id = ? AND interaction_type = 'open'
             )`,
          )
          .run(openId, articleId, now, articleId);
        firstOpen = inserted.changes > 0;
        if (firstOpen) recordedOpenId = openId;
      }

      // Apply side effects to article
      switch (type) {
        case 'save': {
          const updated = db
            .prepare(
              'UPDATE articles SET saved = 1, saved_at = COALESCE(saved_at, ?), state_version = state_version + 1, updated_at = ? WHERE id = ? AND saved = 0',
            )
            .run(now, now, articleId);
          if (updated.changes > 0) pendingWebhook = 'article.saved';
          break;
        }
        case 'unsave':
          db.prepare(
            'UPDATE articles SET saved = 0, saved_at = NULL, state_version = state_version + 1, updated_at = ? WHERE id = ? AND saved = 1',
          ).run(now, articleId);
          break;
        case 'hide':
          db.prepare(
            'UPDATE articles SET hidden = 1, hidden_at = COALESCE(hidden_at, ?), state_version = state_version + 1, updated_at = ? WHERE id = ? AND hidden = 0',
          ).run(now, now, articleId);
          break;
        case 'unhide':
          db.prepare(
            'UPDATE articles SET hidden = 0, hidden_at = NULL, thumbs_down = 0, rejected = 0, rejected_at = NULL, cleared_at = NULL, state_version = state_version + 1, updated_at = ? WHERE id = ? AND (hidden = 1 OR thumbs_down = 1 OR rejected = 1)',
          ).run(now, articleId);
          break;
        case 'boost': {
          const unhid = db
            .prepare(
              'UPDATE articles SET thumbs_up = 1, thumbs_down = 0, rejected = 0, rejected_at = NULL, hidden = 0, hidden_at = NULL, cleared_at = NULL, state_version = state_version + 1, updated_at = ? WHERE id = ?',
            )
            .run(now, articleId);
          if (unhid.changes > 0) {
            insertInteraction.run(
              crypto.randomUUID(),
              articleId,
              'unhide',
              now - 1,
              '{"boost":true}',
            );
          }
          pendingWebhook = 'article.thumbs_up';
          break;
        }
        case 'thumbs_up': {
          db.prepare(
            'UPDATE articles SET thumbs_up = 1, thumbs_down = 0, rejected = 0, rejected_at = NULL, state_version = state_version + 1, updated_at = ? WHERE id = ?',
          ).run(now, articleId);
          pendingWebhook = 'article.thumbs_up';
          break;
        }
        case 'unthumbs_up':
          db.prepare(
            'UPDATE articles SET thumbs_up = 0, state_version = state_version + 1, updated_at = ? WHERE id = ? AND thumbs_up = 1',
          ).run(now, articleId);
          break;
        case 'thumbs_down':
          db.prepare(
            'UPDATE articles SET thumbs_up = 0, thumbs_down = 1, rejected = 1, rejected_at = COALESCE(rejected_at, ?), hidden = 1, hidden_at = COALESCE(hidden_at, ?), cleared_at = NULL, state_version = state_version + 1, updated_at = ? WHERE id = ?',
          ).run(now, now, now, articleId);
          break;
        case 'open': {
          // Open implies read
          db.prepare(
            'UPDATE articles SET read = 1, read_at = COALESCE(read_at, ?), state_version = state_version + 1, updated_at = ? WHERE id = ? AND read = 0',
          ).run(now, now, articleId);

          if (firstOpen) pendingWebhook = 'article.read';

          // Handle "Hide on Open" global setting
          const hideSetting = db
            .prepare(
              "SELECT value FROM app_settings WHERE key = 'hide_on_open'",
            )
            .get() as { value: string } | undefined;
          if (hideSetting?.value === 'true') {
            const hidden = db
              .prepare(
                'UPDATE articles SET hidden = 1, hidden_at = COALESCE(hidden_at, ?), state_version = state_version + 1, updated_at = ? WHERE id = ? AND hidden = 0',
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
          const updated = db
            .prepare(
              'UPDATE articles SET read = 1, read_at = COALESCE(read_at, ?), state_version = state_version + 1, updated_at = ? WHERE id = ? AND read = 0',
            )
            .run(now, now, articleId);
          if (updated.changes > 0) pendingWebhook = 'article.read';
          break;
        }
        case 'unread':
          db.prepare(
            'UPDATE articles SET read = 0, read_at = NULL, state_version = state_version + 1, updated_at = ? WHERE id = ? AND read = 1',
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
          extraFeatureKeys: reversedFeatures,
          includeFeedSiblings:
            supersededTypes.includes('thumbs_down') ||
            supersededTypes.includes('hide'),
        });
        return { skipped: false as const };
      }

      if (type === 'open' && !firstOpen) {
        // A prior unread action may have changed the heuristic inputs since the
        // first open, even though this visit adds no new preference evidence.
        updateHeuristicScore(articleId);
        return { skipped: false as const };
      }

      const preferenceDeltas: PreferenceMemoryDelta[] = [];
      updatePreferenceMemoryFromInteraction(articleId, type, preferenceDeltas);
      if (type === 'open' && recordedOpenId) {
        db.prepare(
          'UPDATE user_interactions SET metadata = ? WHERE id = ?',
        ).run(
          JSON.stringify({ preference_deltas: preferenceDeltas }),
          recordedOpenId,
        );
      } else if (type !== 'open') {
        insertInteraction.run(
          crypto.randomUUID(),
          articleId,
          type,
          now,
          JSON.stringify({ preference_deltas: preferenceDeltas }),
        );
      }

      if (type === 'open' || type === 'read') {
        refreshRankingAfterProfileMutation(articleId);
      } else if (reversedFeatures.length > 0) {
        refreshRankingAfterReversal({
          articleIds: [articleId],
          changedFeatureKeys: reversedFeatures,
          visibleArticleIds: options.visibleArticleIds,
          includeFeedSiblings:
            supersededTypes.includes('thumbs_down') ||
            supersededTypes.includes('hide'),
        });
      } else {
        updateHeuristicScore(articleId);
      }
      return { skipped: false as const };
    })
    .immediate();

  if (outcome.skipped || !pendingWebhook) return;
  const article = db
    .prepare('SELECT * FROM articles WHERE id = ?')
    .get(articleId) as Record<string, unknown> | undefined;
  if (article) {
    dispatchWebhookEvent({
      type: pendingWebhook,
      timestamp: now,
      payload: { article },
    });
  }
}
