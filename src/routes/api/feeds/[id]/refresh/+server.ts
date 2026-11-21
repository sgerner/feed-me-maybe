import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { scheduleNextPoll, wakePoller } from '#lib/server/poller.ts';
import {
  FEED_FETCH_JOB_TYPE,
  enqueueFeedFetch,
  getJob,
  getLatestFeedFetchJob,
  runDueJobs,
} from '#lib/server/feed/job-queue.ts';
import {
  getFeedHealth,
  getLatestFeedFetchLog,
} from '#lib/server/feed-management.ts';
import { recordAppError } from '#lib/server/logging.ts';

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db
    .prepare('SELECT id FROM feeds WHERE id = ?')
    .get(params.id) as { id: string } | undefined;
  if (!feed) return json({ error: 'Feed not found' }, { status: 404 });

  const jobId = url.searchParams.get('jobId');
  let job = getLatestFeedFetchJob(feed.id);
  if (jobId) {
    const requestedJob = getJob(jobId);
    if (
      !requestedJob ||
      requestedJob.type !== FEED_FETCH_JOB_TYPE ||
      requestedJob.payload.feedId !== feed.id
    ) {
      return json({ error: 'Feed fetch job not found' }, { status: 404 });
    }
    job = requestedJob;
  }

  return json({
    job,
    fetch: getLatestFeedFetchLog(feed.id),
    health: getFeedHealth(feed.id),
  });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
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

  let force = true;
  try {
    const body = (await request.json()) as { force?: unknown };
    if (body?.force === false) force = false;
  } catch {
    // Older clients send no JSON body; keep their manual refresh behavior.
  }
  if (!force) {
    wakePoller();
    return json(
      {
        success: true,
        queued: false,
        job: null,
        fetch: getLatestFeedFetchLog(feed.id),
        health: getFeedHealth(feed.id),
      },
      { status: 202 },
    );
  }
  const job = enqueueFeedFetch(feed.id, { force });
  // The job is persisted before this worker is kicked. If the process stops,
  // the poller will recover and retry it on the next cycle.
  void runDueJobs({ maxJobs: 1, jobId: job.id })
    .catch((error) => {
      recordAppError({
        source: 'api.feed.refresh.worker',
        error,
        details: { feedId: feed.id, jobId: job.id },
        path: `/api/feeds/${feed.id}/refresh`,
        method: 'POST',
      });
    })
    .finally(() => scheduleNextPoll());

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
