import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { enqueueFeedFetch, runDueJobs } from '$lib/server/feed/job-queue';
import { recordAppError } from '$lib/server/logging';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feeds = db.prepare('SELECT id FROM feeds WHERE enabled = 1').all() as {
    id: string;
  }[];

  const jobs = feeds.map((feed) => enqueueFeedFetch(feed.id, { force: true }));
  // Queue insertion is the durable operation. The in-process worker provides
  // fast feedback when possible, while the poller remains the restart-safe
  // fallback for queued work.
  void runDueJobs({ maxJobs: Math.max(1, feeds.length) }).catch((error) => {
    recordAppError({
      source: 'api.feeds.refresh.worker',
      error,
      details: { feedCount: feeds.length },
      path: '/api/feeds/refresh',
      method: 'POST',
    });
  });

  return json({
    success: true,
    queued: jobs.filter((job) => job.status === 'queued').length,
    alreadyActive: jobs.filter((job) => job.status !== 'queued').length,
    jobs,
  });
};
