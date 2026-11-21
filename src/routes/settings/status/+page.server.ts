import type { PageServerLoad } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import {
  isJevConfigured,
  isRankingProviderConfigured,
  isSubqConfigured,
} from '$lib/server/ai/jev';
import { getRankingProvider } from '$lib/server/ranking-provider';
import {
  AI_PROCESS_JOB_TYPE,
  getProviderCooldown,
  JEV_PROCESS_JOB_TYPE,
} from '$lib/server/feed/job-queue';

function parseDetails(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};
  const db = getDb();

  const feedCount = (
    db.prepare('SELECT COUNT(*) as c FROM feeds').get() as { c: number }
  ).c;
  const articleCount = (
    db.prepare('SELECT COUNT(*) as c FROM articles').get() as { c: number }
  ).c;
  const rankingProvider = getRankingProvider();
  const now = Date.now();
  const jobCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'queued'")
      .get() as { c: number }
  ).c;
  const oldestQueuedRow = db
    .prepare(
      "SELECT MIN(created_at) AS oldest FROM jobs WHERE status IN ('queued')",
    )
    .get() as { oldest?: number | null } | undefined;
  const oldestQueuedJobAt =
    typeof oldestQueuedRow?.oldest === 'number' &&
    Number.isFinite(oldestQueuedRow.oldest)
      ? oldestQueuedRow.oldest
      : null;
  const aiCooldownRaw = getProviderCooldown(AI_PROCESS_JOB_TYPE, db);
  const jevCooldownRaw = getProviderCooldown(JEV_PROCESS_JOB_TYPE, db);
  const aiCooldownUntil = aiCooldownRaw > now ? aiCooldownRaw : null;
  const jevCooldownUntil = jevCooldownRaw > now ? jevCooldownRaw : null;
  const jevErrors = db
    .prepare(
      `SELECT id, title, jev_error, jev_processed_at
       FROM articles
       WHERE COALESCE(jev_error, '') != ''
       ORDER BY jev_processed_at DESC, id DESC
       LIMIT 10`,
    )
    .all() as Array<{
    id: string;
    title: string;
    jev_error: string;
    jev_processed_at: number | null;
  }>;
  const jev = {
    configured: isJevConfigured(),
    activeProvider: rankingProvider,
    activeProviderConfigured: isRankingProviderConfigured(rankingProvider),
    subqConfigured: isSubqConfigured(),
    cooldownUntil: jevCooldownUntil,
    errors: jevErrors,
    ...(db
      .prepare(
        `
      SELECT COUNT(*) AS total,
        COUNT(jev_score) AS scored,
        SUM(CASE WHEN jev_score IS NULL THEN 1 ELSE 0 END) AS missing
      FROM articles
    `,
      )
      .get() as { total: number; scored: number; missing: number | null }),
    jobs: db
      .prepare(
        `
      SELECT status, COUNT(*) AS count FROM jobs
      WHERE type = 'jev_process' GROUP BY status
    `,
      )
      .all() as Array<{ status: string; count: number }>,
    recentJobs: db
      .prepare(
        `
      SELECT id, status, attempts, max_attempts, scheduled_at, error_message
      FROM jobs WHERE type = 'jev_process'
      ORDER BY created_at DESC, id DESC LIMIT 10
    `,
      )
      .all() as Array<{
      id: string;
      status: string;
      attempts: number;
      max_attempts: number;
      scheduled_at: number | null;
      error_message: string | null;
    }>,
  };
  const failingFeeds = db
    .prepare(
      `SELECT id, title, last_error, error_count
     FROM feeds WHERE enabled = 1 AND error_count > 0
     ORDER BY error_count DESC, id LIMIT 25`,
    )
    .all() as Array<{
    id: string;
    title: string;
    last_error: string;
    error_count: number;
  }>;
  const recentJobs = db
    .prepare('SELECT * FROM feed_fetch_logs ORDER BY created_at DESC LIMIT 10')
    .all();
  const recentErrors = (
    db
      .prepare('SELECT * FROM app_error_logs ORDER BY created_at DESC LIMIT 10')
      .all() as Array<{ details?: string | null; [key: string]: unknown }>
  ).map((row) => ({
    ...row,
    details: parseDetails(row.details),
  }));

  return {
    feedCount,
    articleCount,
    jobCount,
    oldestQueuedJobAt,
    aiCooldownUntil,
    recentJobs,
    recentErrors,
    jev,
    failingFeeds,
  };
};
