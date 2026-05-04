import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

function parseDetails(value: string | null | undefined): Record<string, unknown> {
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
  const jobCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'queued'")
      .get() as { c: number }
  ).c;
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

  return { feedCount, articleCount, jobCount, recentJobs, recentErrors };
};
