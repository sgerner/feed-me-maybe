import type { RequestHandler } from './$types';
import {
  FEED_FETCH_JOB_TYPE,
  getJob,
  getLatestFeedFetchJob,
} from '#lib/server/feed/job-queue.ts';
import {
  dispatchFeedRefresh,
  getFeedExists,
  getFeedHealth,
  getLatestFeedFetchLog,
  parseRefreshForceFlag,
} from '#lib/server/feed-management.ts';

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const feed = getFeedExists(params.id);
  if (!feed) return Response.json({ error: 'Feed not found' }, { status: 404 });

  const jobId = url.searchParams.get('jobId');
  let job = getLatestFeedFetchJob(feed.id);
  if (jobId) {
    const requestedJob = getJob(jobId);
    if (
      !requestedJob ||
      requestedJob.type !== FEED_FETCH_JOB_TYPE ||
      requestedJob.payload.feedId !== feed.id
    ) {
      return Response.json(
        { error: 'Feed fetch job not found' },
        { status: 404 },
      );
    }
    job = requestedJob;
  }

  return Response.json({
    job,
    fetch: getLatestFeedFetchLog(feed.id),
    health: getFeedHealth(feed.id),
  });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const feed = getFeedExists(params.id);
  if (!feed) {
    return Response.json({ error: 'Feed not found' }, { status: 404 });
  }

  const force = await parseRefreshForceFlag(request);
  return Response.json(
    dispatchFeedRefresh(feed.id, {
      force,
      path: `/api/feeds/${feed.id}/refresh`,
    }),
    { status: 202 },
  );
};
