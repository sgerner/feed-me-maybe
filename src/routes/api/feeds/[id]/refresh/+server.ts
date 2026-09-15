import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import {
  enqueueFeedFetch,
  getLatestFeedFetchJob,
  runDueJobs,
} from '$lib/server/feed/job-queue';
import {
  getFeedHealth,
  getLatestFeedFetchLog,
} from '$lib/server/feed-management';
import { recordAppError } from '$lib/server/logging';

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db
    .prepare('SELECT id FROM feeds WHERE id = ?')
    .get(params.id) as { id: string } | undefined;
  if (!feed) return json({ error: 'Feed not found' }, { status: 404 });

  return json({
    job: getLatestFeedFetchJob(feed.id),
    fetch: getLatestFeedFetchLog(feed.id),
    health: getFeedHealth(feed.id),
  });
};

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db
    .prepare('SELECT id FROM feeds WHERE id = ?')
    .get(params.id) as { id: string } | undefined;

  if (!feed) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }

  const job = enqueueFeedFetch(feed.id, { force: true });
  // The job is persisted before this worker is kicked. If the process stops,
  // the poller will recover and retry it on the next cycle.
  void runDueJobs({ maxJobs: 1 }).catch((error) => {
    recordAppError({
      source: 'api.feed.refresh.worker',
      error,
      details: { feedId: feed.id, jobId: job.id },
      path: `/api/feeds/${feed.id}/refresh`,
      method: 'POST',
    });
  });

  return json(
    {
      success: true,
      queued: job.status === 'queued',
      job,
      fetch: getLatestFeedFetchLog(feed.id),
      health: getFeedHealth(feed.id),
    },
    { status: 202 },
  );
};
