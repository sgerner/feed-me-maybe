import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

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

  return { feedCount, articleCount, jobCount, recentJobs };
};
