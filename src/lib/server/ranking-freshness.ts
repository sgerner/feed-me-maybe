import crypto from 'node:crypto';
import { getDb } from '#lib/server/db/index.ts';
import {
  getPreferenceFeatureKeysForArticles,
  updateHeuristicScore,
  updatePreferenceMemoryFromInteraction,
  type PreferenceMemoryDelta,
} from '#lib/server/preferences.ts';
import type { InteractionType } from '#lib/server/interactions.ts';
import { wakePoller } from '#lib/server/poller.ts';

const FEEDBACK_REVISION_SETTING = 'ranking_feedback_revision';
const VISIBLE_ARTICLE_LIMIT = 30;
const RECENT_UNSCORED_LIMIT = 20;
const RECENT_AFFECTED_SCAN_LIMIT = 300;
const RECENT_AFFECTED_LIMIT = 20;
const MAX_RELATED_REFRESH_TARGETS = 60;
const MAX_FEEDBACK_ARTICLES = 500;
const RECENT_ARTICLE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
export const RANKING_REFRESH_RATE_LIMIT_MS = 10_000;

type FeedbackType = Extract<
  InteractionType,
  'thumbs_up' | 'thumbs_down' | 'boost' | 'save' | 'hide'
>;

function parseRevision(value: string | null | undefined): number {
  const revision = Number(value || 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function getRankingFeedbackRevision(): number {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(FEEDBACK_REVISION_SETTING) as { value: string | null } | undefined;
  return parseRevision(row?.value);
}

function advanceRankingFeedbackRevision(now: number): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CAST(COALESCE(value, '0') AS INTEGER) + 1,
       updated_at = excluded.updated_at`,
  ).run(FEEDBACK_REVISION_SETTING, now);
  return getRankingFeedbackRevision();
}

function normalizeIds(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!id || id.length > 200) continue;
    unique.add(id);
    if (unique.size >= limit) break;
  }
  return [...unique];
}

function getExistingIds(ids: string[], enabledOnly = false): string[] {
  if (!ids.length) return [];
  const db = getDb();
  const rows = db
    .prepare(
      enabledOnly
        ? `SELECT a.id FROM articles a
           JOIN feeds f ON f.id = a.feed_id
           WHERE f.enabled = 1 AND a.id IN (${ids.map(() => '?').join(', ')})`
        : `SELECT id FROM articles WHERE id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as Array<{ id: string }>;
  const found = new Set(rows.map((row) => row.id));
  return ids.filter((id) => found.has(id));
}

function getFeedbackTargets(
  articleIds: string[],
  visibleArticleIds: string[],
  changedFeatureKeys: string[],
  type: FeedbackType,
  now: number,
): string[] {
  const db = getDb();
  const interactedIds = getExistingIds(articleIds);
  const visibleIds = getExistingIds(
    normalizeIds(visibleArticleIds, VISIBLE_ARTICLE_LIMIT),
    true,
  );
  const processingRows = db
    .prepare(
      `SELECT json_extract(j.payload, '$.articleId') AS article_id
       FROM jobs j
       JOIN articles a ON a.id = json_extract(j.payload, '$.articleId')
       JOIN feeds f ON f.id = a.feed_id
       WHERE j.type = 'jev_process' AND j.status = 'processing'
         AND j.started_at IS NOT NULL
         AND json_valid(j.payload) = 1
         AND json_type(j.payload, '$.articleId') = 'text'
         AND f.enabled = 1
       ORDER BY j.started_at ASC LIMIT 4`,
    )
    .all() as Array<{ article_id: string }>;
  const processingIds = processingRows.map((row) => row.article_id);

  const recentCutoff = now - RECENT_ARTICLE_WINDOW_MS;
  const unscoredRows = db
    .prepare(
      `SELECT a.id FROM articles a
       JOIN feeds f ON f.id = a.feed_id
       WHERE f.enabled = 1
         AND a.jev_score IS NULL
         AND COALESCE(a.hidden, 0) = 0
         AND COALESCE(a.rejected, 0) = 0
         AND COALESCE(a.thumbs_down, 0) = 0
         AND a.fetched_at >= ?
       ORDER BY a.fetched_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(recentCutoff, RECENT_UNSCORED_LIMIT) as Array<{ id: string }>;

  const affectedRows = db
    .prepare(
      `SELECT a.id, a.feed_id FROM articles a
       JOIN feeds f ON f.id = a.feed_id
       WHERE f.enabled = 1
         AND a.jev_score IS NOT NULL
         AND COALESCE(a.hidden, 0) = 0
         AND COALESCE(a.rejected, 0) = 0
         AND COALESCE(a.thumbs_down, 0) = 0
         AND a.fetched_at >= ?
       ORDER BY a.fetched_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(recentCutoff, RECENT_AFFECTED_SCAN_LIMIT) as Array<{
    id: string;
    feed_id: string;
  }>;
  const featureKeys = new Set(changedFeatureKeys);
  const articleFeatures = featureKeys.size
    ? getPreferenceFeatureKeysForArticles(affectedRows.map((row) => row.id))
    : new Map<string, Set<string>>();
  const feedIds =
    (type === 'thumbs_down' || type === 'hide') && interactedIds.length
      ? new Set(
          (
            db
              .prepare(
                `SELECT DISTINCT feed_id FROM articles
                 WHERE id IN (${interactedIds.map(() => '?').join(', ')})`,
              )
              .all(...interactedIds) as Array<{ feed_id: string }>
          ).map((row) => row.feed_id),
        )
      : new Set<string>();
  const affectedIds = affectedRows
    .filter(
      (row) =>
        feedIds.has(row.feed_id) ||
        [...(articleFeatures.get(row.id) || [])].some((key) =>
          featureKeys.has(key),
        ),
    )
    .slice(0, RECENT_AFFECTED_LIMIT)
    .map((row) => row.id);

  const interactedSet = new Set(interactedIds);
  const relatedIds = [
    ...visibleIds,
    ...processingIds,
    ...unscoredRows.map((row) => row.id),
    ...affectedIds,
  ];
  const additionalIds = [...new Set(relatedIds)]
    .filter((id) => !interactedSet.has(id))
    .slice(0, MAX_RELATED_REFRESH_TARGETS);
  // State actions may contain a bounded bulk of explicitly changed articles.
  // Keep all of those fresh while independently capping the wider cohort.
  return [...interactedIds, ...additionalIds];
}

/** Persist one article's pending refresh; callers can safely repeat this. */
export function markArticleForRankingRefresh(
  articleId: string,
  requestedRevision = getRankingFeedbackRevision(),
  now = Date.now(),
): void {
  const db = getDb();
  const article = db
    .prepare('SELECT ranking_refreshed_at FROM articles WHERE id = ?')
    .get(articleId) as { ranking_refreshed_at: number | null } | undefined;
  if (!article) return;

  const lastRefresh = Number(article.ranking_refreshed_at || 0);
  const notBefore = Math.max(now, lastRefresh + RANKING_REFRESH_RATE_LIMIT_MS);
  db.prepare(
    `INSERT INTO ranking_refresh_queue
       (article_id, requested_revision, heuristic_revision, not_before, created_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET
       requested_revision = MAX(ranking_refresh_queue.requested_revision, excluded.requested_revision),
       not_before = MAX(ranking_refresh_queue.not_before, excluded.not_before)`,
  ).run(articleId, requestedRevision, notBefore, now);
}

function refreshTargetImmediately(articleId: string, revision: number): void {
  const db = getDb();
  const exists = db
    .prepare('SELECT 1 FROM articles WHERE id = ?')
    .get(articleId);
  if (!exists) {
    db.prepare('DELETE FROM ranking_refresh_queue WHERE article_id = ?').run(
      articleId,
    );
    return;
  }
  // An old Jev score is personalized with an earlier reader profile. Remove
  // it before recomputing the local score so list reads stop using it now.
  db.prepare(
    `UPDATE articles
     SET jev_score = NULL, jev_processed_at = NULL, jev_error = ''
     WHERE id = ?`,
  ).run(articleId);
  updateHeuristicScore(articleId);
  db.prepare(
    'UPDATE ranking_refresh_queue SET heuristic_revision = ? WHERE article_id = ? AND requested_revision = ?',
  ).run(revision, articleId, revision);
}

/** Keep Jev's reader-profile snapshot guard honest for other profile inputs. */
export function refreshRankingAfterProfileMutation(articleId: string): void {
  const existingIds = getExistingIds([articleId]);
  if (!existingIds.length) return;
  const now = Date.now();
  const db = getDb();
  const transaction = db.transaction(() => {
    const revision = advanceRankingFeedbackRevision(now);
    markArticleForRankingRefresh(existingIds[0], revision, now);
    refreshTargetImmediately(existingIds[0], revision);
  });
  transaction.immediate();
  wakePoller();
}

/**
 * Learn explicit feedback and refresh a bounded ranking cohort. The only
 * expensive Jev work is durably queued for the background worker.
 */
export function refreshRankingAfterFeedback(input: {
  articleIds: string[];
  type: FeedbackType;
  visibleArticleIds?: unknown;
  interactionAlreadyRecorded?: boolean;
  operationId?: string;
  idempotencyKey?: string;
}): { revision: number; refreshedArticleIds: string[] } {
  const db = getDb();
  const now = Date.now();
  const articleIds = getExistingIds(
    normalizeIds(input.articleIds, MAX_FEEDBACK_ARTICLES),
  );
  if (!articleIds.length) {
    return { revision: getRankingFeedbackRevision(), refreshedArticleIds: [] };
  }

  const learnedFeatures = new Set<string>();
  const updateMemory = db.transaction(() => {
    for (const articleId of articleIds) {
      const preferenceDeltas: PreferenceMemoryDelta[] = [];
      for (const featureKey of updatePreferenceMemoryFromInteraction(
        articleId,
        input.type,
        preferenceDeltas,
      )) {
        learnedFeatures.add(featureKey);
      }
      if (!input.interactionAlreadyRecorded) {
        db.prepare(
          'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
        ).run(
          crypto.randomUUID(),
          articleId,
          input.type,
          now,
          JSON.stringify({
            ...(input.operationId ? { operation_id: input.operationId } : {}),
            ...(input.idempotencyKey
              ? { idempotency_key: input.idempotencyKey }
              : {}),
            preference_deltas: preferenceDeltas,
          }),
        );
      }
    }
    return learnedFeatures.size
      ? advanceRankingFeedbackRevision(now)
      : getRankingFeedbackRevision();
  });
  const revision = updateMemory.immediate();

  if (!learnedFeatures.size) {
    for (const articleId of articleIds) updateHeuristicScore(articleId);
    return { revision, refreshedArticleIds: articleIds };
  }

  const targetIds = getFeedbackTargets(
    articleIds,
    normalizeIds(input.visibleArticleIds, VISIBLE_ARTICLE_LIMIT),
    [...learnedFeatures],
    input.type,
    now,
  );
  const enabledTargetIds = getExistingIds(targetIds, true);
  const refreshTargets = db.transaction(() => {
    if (enabledTargetIds.length) {
      db.prepare(
        `INSERT INTO ranking_refresh_queue
           (article_id, requested_revision, heuristic_revision, not_before, created_at)
         SELECT id, ?, NULL, MAX(?, COALESCE(ranking_refreshed_at, 0) + ?), ?
         FROM articles WHERE id IN (SELECT value FROM json_each(?))
         ON CONFLICT(article_id) DO UPDATE SET
           requested_revision = MAX(ranking_refresh_queue.requested_revision, excluded.requested_revision),
           not_before = MAX(ranking_refresh_queue.not_before, excluded.not_before)`,
      ).run(
        revision,
        now,
        RANKING_REFRESH_RATE_LIMIT_MS,
        now,
        JSON.stringify(enabledTargetIds),
      );
      db.prepare(
        `UPDATE articles SET jev_score = NULL, jev_processed_at = NULL, jev_error = '', combined_score = NULL
         WHERE id IN (SELECT value FROM json_each(?))`,
      ).run(JSON.stringify(enabledTargetIds));
    }
    for (const articleId of targetIds) updateHeuristicScore(articleId);
    if (enabledTargetIds.length) {
      db.prepare(
        `UPDATE ranking_refresh_queue SET heuristic_revision = ?
         WHERE requested_revision = ? AND article_id IN (SELECT value FROM json_each(?))`,
      ).run(revision, revision, JSON.stringify(enabledTargetIds));
    }
  });
  refreshTargets.immediate();
  if (enabledTargetIds.length) wakePoller();

  return { revision, refreshedArticleIds: targetIds };
}

/** Drain a small batch of durable refresh requests before ordinary backfill. */
export async function flushRankingRefreshQueue(
  now = Date.now(),
  limit = 8,
): Promise<number> {
  const db = getDb();
  const { isRankingProviderConfigured } = await import('#lib/server/ai/jev.ts');
  const rankingProviderConfigured = isRankingProviderConfigured();
  // Normally the foreign key removes these with their articles. Clean up
  // leftovers from databases where foreign-key enforcement was disabled so
  // they cannot keep the poller waking on work that can never be processed.
  db.prepare(
    `DELETE FROM ranking_refresh_queue
     WHERE NOT EXISTS (
       SELECT 1 FROM articles a WHERE a.id = ranking_refresh_queue.article_id
     )`,
  ).run();
  const rows = db
    .prepare(
      `SELECT q.article_id, q.requested_revision, q.heuristic_revision,
              q.not_before, a.feed_id
       FROM ranking_refresh_queue q
       JOIN articles a ON a.id = q.article_id
       JOIN feeds f ON f.id = a.feed_id
       WHERE (? = 0 OR f.enabled = 0 OR q.not_before <= ?)
       ORDER BY q.created_at ASC, q.article_id ASC
       LIMIT ?`,
    )
    .all(
      rankingProviderConfigured ? 1 : 0,
      now,
      Math.max(1, Math.floor(limit)),
    ) as Array<{
    article_id: string;
    requested_revision: number;
    heuristic_revision: number | null;
    not_before: number;
    feed_id: string;
  }>;
  if (!rows.length) return 0;

  const { enqueueJevProcess } = await import('#lib/server/feed/job-queue.ts');

  let queued = 0;
  for (const row of rows) {
    const revision = Number(row.requested_revision || 0);
    const activeArticle = db
      .prepare(
        `SELECT 1 FROM articles a
         JOIN feeds f ON f.id = a.feed_id
         WHERE a.id = ?
           AND f.enabled = 1
           AND COALESCE(a.hidden, 0) = 0
           AND COALESCE(a.rejected, 0) = 0
           AND COALESCE(a.thumbs_down, 0) = 0`,
      )
      .get(row.article_id);
    if (!activeArticle) {
      db.prepare(
        'DELETE FROM ranking_refresh_queue WHERE article_id = ? AND requested_revision = ?',
      ).run(row.article_id, revision);
      continue;
    }

    if (
      row.heuristic_revision === null ||
      Number(row.heuristic_revision) !== revision
    ) {
      const transaction = db.transaction(() => {
        const current = db
          .prepare(
            'SELECT requested_revision FROM ranking_refresh_queue WHERE article_id = ?',
          )
          .get(row.article_id) as { requested_revision: number } | undefined;
        if (!current || Number(current.requested_revision) !== revision)
          return false;
        db.prepare(
          `UPDATE articles
           SET jev_score = NULL, jev_processed_at = NULL, jev_error = ''
           WHERE id = ?`,
        ).run(row.article_id);
        updateHeuristicScore(row.article_id);
        db.prepare(
          'UPDATE ranking_refresh_queue SET heuristic_revision = ? WHERE article_id = ? AND requested_revision = ?',
        ).run(revision, row.article_id, revision);
        return true;
      });
      transaction.immediate();
    }

    const current = db
      .prepare(
        'SELECT requested_revision, heuristic_revision FROM ranking_refresh_queue WHERE article_id = ?',
      )
      .get(row.article_id) as
      | { requested_revision: number; heuristic_revision: number | null }
      | undefined;
    if (
      !current ||
      Number(current.requested_revision) !== revision ||
      current.heuristic_revision === null ||
      Number(current.heuristic_revision) !== revision
    ) {
      continue;
    }
    if (!rankingProviderConfigured) {
      db.prepare(
        'DELETE FROM ranking_refresh_queue WHERE article_id = ? AND requested_revision = ? AND heuristic_revision = ?',
      ).run(row.article_id, revision, revision);
      continue;
    }

    const job = enqueueJevProcess(row.article_id, {
      feedId: row.feed_id,
      now,
      feedback: true,
    });
    if (!job) continue;

    const deleted = db
      .prepare(
        'DELETE FROM ranking_refresh_queue WHERE article_id = ? AND requested_revision = ? AND heuristic_revision = ?',
      )
      .run(row.article_id, revision, revision);
    if (deleted.changes === 1) queued += 1;
  }
  return queued;
}

/** Invalidate every cached score after the reader-wide preference profile changes. */
export function refreshRankingAfterGlobalProfileMutation(): {
  revision: number;
  articleCount: number;
} {
  const db = getDb();
  const now = Date.now();
  const activeCutoff = now - RECENT_ARTICLE_WINDOW_MS;
  const result = db
    .transaction(() => {
      const revision = advanceRankingFeedbackRevision(now);

      // Clear personalized snapshots everywhere, then leave archives on a
      // single-statement, non-personalized local fallback. Only the bounded
      // recent visible cohort gets per-article heuristic work and Jev jobs.
      db.prepare(
        `UPDATE articles
         SET jev_score = NULL, jev_processed_at = NULL, jev_error = ''`,
      ).run();
      db.prepare(
        `UPDATE articles AS a
         SET heuristic_score = MAX(0, MIN(100,
           50 + (a.read * 2) + (a.saved * 10) + (a.thumbs_up * 25) -
           (a.thumbs_down * 20) - CASE WHEN (
             SELECT
               ui.interaction_type
             FROM user_interactions ui
             WHERE ui.article_id = a.id
               AND ui.interaction_type IN ('hide', 'unhide', 'restore')
               AND (ui.interaction_type != 'hide' OR json_extract(
                 CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
                 '$.auto'
               ) IS NULL)
               AND COALESCE(json_extract(
                 CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
                 '$.undone_at'
               ), 0) = 0
             ORDER BY ui.timestamp DESC, ui.rowid DESC
             LIMIT 1
           ) = 'hide' THEN 10 ELSE 0 END
         ))`,
      ).run();
      db.prepare(
        `UPDATE articles AS a
         SET combined_score = CASE
           WHEN EXISTS (
             SELECT 1 FROM article_ai_metadata am
             WHERE am.article_id = a.id AND am.analysis_status = 'ready'
           ) THEN ROUND(MAX(0, MIN(100,
             COALESCE(a.heuristic_score, 50) * 0.6 +
             (
               COALESCE((SELECT ai_relevance_score FROM article_ai_metadata WHERE article_id = a.id), 0) * 0.7 +
               COALESCE((SELECT quality_score FROM article_ai_metadata WHERE article_id = a.id), 0) * 0.2 +
               COALESCE((SELECT novelty_score FROM article_ai_metadata WHERE article_id = a.id), 0) * 0.1
             ) * 40
           )))
           ELSE NULL
         END`,
      ).run();
      db.prepare('DELETE FROM ranking_refresh_queue').run();
      db.prepare(
        "DELETE FROM jobs WHERE type = 'jev_process' AND status != 'processing'",
      ).run();

      const articles = db
        .prepare(
          `SELECT a.id FROM articles a
           JOIN feeds f ON f.id = a.feed_id
           WHERE a.fetched_at >= ? AND f.enabled = 1 AND a.hidden = 0 AND a.thumbs_down = 0 AND a.rejected = 0
           ORDER BY a.fetched_at DESC, a.id DESC
           LIMIT ?`,
        )
        .all(activeCutoff, RECENT_AFFECTED_SCAN_LIMIT) as Array<{ id: string }>;

      const recentSet = new Set(articles.map((row) => row.id));
      const savedArticles = db
        .prepare(
          `SELECT id FROM articles
           WHERE saved = 1 AND hidden = 0 AND thumbs_down = 0 AND rejected = 0`,
        )
        .all() as Array<{ id: string }>;
      for (const { id } of savedArticles) {
        if (!recentSet.has(id)) {
          updateHeuristicScore(id);
        }
      }

      for (const { id } of articles) {
        updateHeuristicScore(id);
        markArticleForRankingRefresh(id, revision, now);
        db.prepare(
          `UPDATE ranking_refresh_queue
           SET heuristic_revision = ?
           WHERE article_id = ? AND requested_revision = ?`,
        ).run(revision, id, revision);
      }

      return { revision, articleCount: articles.length };
    })
    .immediate();
  if (result.articleCount > 0) wakePoller();
  return result;
}
