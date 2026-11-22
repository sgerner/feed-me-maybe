import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { scheduleNextPoll, wakePoller } from '#lib/server/poller.ts';
import { enqueueFeedFetch, runDueJobs } from '#lib/server/feed/job-queue.ts';
import { recordAppError } from '#lib/server/logging.ts';
import { readJsonObject } from '#lib/server/request-body.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Older clients send no JSON body; keep their manual refresh behavior.
  const body = await readJsonObject(request);
  const force = body?.force !== false;
  if (!force) {
    wakePoller();
    return Response.json({
      success: true,
      queued: 0,
      alreadyActive: 0,
      jobs: [],
    });
  }

  const db = getDb();
  const feeds = db.prepare('SELECT id FROM feeds WHERE enabled = 1').all() as {
    id: string;
  }[];
  const jobs = feeds.map((feed) => enqueueFeedFetch(feed.id, { force: true }));
  // Queue insertion is the durable operation. The in-process worker provides
  // fast feedback when possible, while the poller remains the restart-safe
  // fallback for queued work.
  void runDueJobs({ maxJobs: Math.max(1, feeds.length) })
    .catch((error) => {
      recordAppError({
        source: 'api.feeds.refresh.worker',
        error,
        details: { feedCount: feeds.length },
        path: '/api/feeds/refresh',
        method: 'POST',
      });
    })
    .finally(() => scheduleNextPoll());

  return Response.json({
    success: true,
    queued: jobs.filter((job) => job.status === 'queued').length,
    alreadyActive: jobs.filter((job) => job.status !== 'queued').length,
    jobs,
  });
};
