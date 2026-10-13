import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import {
  getPreferenceFeatureKeysForArticles,
  updateHeuristicScore,
  updatePreferenceMemoryFromInteraction,
} from '$lib/server/preferences';
import type { InteractionType } from '$lib/server/interactions';

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
  'thumbs_up' | 'thumbs_down' | 'boost'
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

function getExistingIds(ids: string[]): string[] {
  if (!ids.length) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id FROM articles WHERE id IN (${ids.map(() => '?').join(', ')})`,
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
  );
  const processingRows = db
    .prepare(
      `SELECT json_extract(payload, '$.articleId') AS article_id
       FROM jobs
       WHERE type = 'jev_process' AND status = 'processing'
         AND json_valid(payload) = 1
         AND json_type(payload, '$.articleId') = 'text'
       ORDER BY started_at ASC LIMIT 4`,
    )
    .all() as Array<{ article_id: string }>;
  const processingIds = processingRows.map((row) => row.article_id);

  const recentCutoff = now - RECENT_ARTICLE_WINDOW_MS;
  const unscoredRows = db
    .prepare(
      `SELECT id FROM articles
       WHERE jev_score IS NULL
         AND fetched_at >= ?
       ORDER BY fetched_at DESC, id DESC
       LIMIT ?`,
    )
    .all(recentCutoff, RECENT_UNSCORED_LIMIT) as Array<{ id: string }>;

  const affectedRows = db
    .prepare(
      `SELECT id, feed_id FROM articles
       WHERE jev_score IS NOT NULL
         AND fetched_at >= ?
       ORDER BY fetched_at DESC, id DESC
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
    type === 'thumbs_down' && interactedIds.length
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
      if (!input.interactionAlreadyRecorded) {
        db.prepare(
          'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
        ).run(crypto.randomUUID(), articleId, input.type, now, '{}');
      }
      for (const featureKey of updatePreferenceMemoryFromInteraction(
        articleId,
        input.type,
      )) {
        learnedFeatures.add(featureKey);
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
  const refreshTargets = db.transaction(() => {
    for (const articleId of targetIds) {
      markArticleForRankingRefresh(articleId, revision, now);
      refreshTargetImmediately(articleId, revision);
    }
  });
  refreshTargets.immediate();

  return { revision, refreshedArticleIds: targetIds };
}

/** Drain a small batch of durable refresh requests before ordinary backfill. */
export async function flushRankingRefreshQueue(
  now = Date.now(),
  limit = 8,
): Promise<number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT q.article_id, q.requested_revision, q.heuristic_revision,
              q.not_before, a.feed_id
       FROM ranking_refresh_queue q
       JOIN articles a ON a.id = q.article_id
       WHERE q.not_before <= ?
       ORDER BY q.created_at ASC, q.article_id ASC
       LIMIT ?`,
    )
    .all(now, Math.max(1, Math.floor(limit))) as Array<{
    article_id: string;
    requested_revision: number;
    heuristic_revision: number | null;
    not_before: number;
    feed_id: string;
  }>;
  if (!rows.length) return 0;

  const { isRankingProviderConfigured } = await import('$lib/server/ai/jev');
  const rankingProviderConfigured = isRankingProviderConfigured();
  const { enqueueJevProcess } = await import('$lib/server/feed/job-queue');

  let queued = 0;
  for (const row of rows) {
    const revision = Number(row.requested_revision || 0);
    if (Number(row.heuristic_revision) !== revision) {
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
      Number(current.heuristic_revision) !== revision
    ) {
      continue;
    }
    if (!rankingProviderConfigured) continue;

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
