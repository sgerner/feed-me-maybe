import { getDb } from '$lib/server/db';
import { building } from '$app/environment';
import {
  enqueueFeedFetch,
  getNextQueuedJobAt,
  recoverAbandonedJobs,
  runDueJobs,
  type JobRecord,
  type RunJobsResult,
} from '$lib/server/feed/job-queue';
import {
  getEffectivePollIntervalMins,
  getGlobalPollIntervalMins,
} from '$lib/server/feed-management';
import { recordAppError } from '$lib/server/logging';

const INITIAL_POLL_DELAY_MS = 1_000;
const DEFAULT_JOB_BATCH_SIZE = 24;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollStarted = false;
let pollCycle: Promise<PollCycleResult> | null = null;

export type PollCycleResult = {
  checked: number;
  due: number;
  enqueued: JobRecord[];
  worker: RunJobsResult;
};

export function startPolling(): void {
  if (building || pollStarted) return;
  pollStarted = true;
  console.log('[poller] Starting background feed polling loop');
  scheduleNextPoll(INITIAL_POLL_DELAY_MS);
}

export function stopPolling(): void {
  pollStarted = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(delayMs?: number): void {
  if (!pollStarted) return;
  if (pollTimer) clearTimeout(pollTimer);

  const intervalMins = getGlobalPollIntervalMins();
  const queuedJobAt = getNextQueuedJobAt();
  const nextJobDelay =
    queuedJobAt == null ? null : Math.max(1_000, queuedJobAt - Date.now());
  const nextDelay =
    delayMs ??
    Math.min(
      intervalMins * 60 * 1000,
      nextJobDelay ?? Number.POSITIVE_INFINITY,
    );

  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try {
      await pollFeeds();
    } catch (error) {
      recordAppError({ source: 'poller.cycle', error });
    } finally {
      if (pollStarted) scheduleNextPoll();
    }
  }, nextDelay);
}

function getPollableFeeds() {
  return getDb()
    .prepare(
      `
        SELECT id, last_fetch_at, poll_interval_mins, fetch_count_since_change
        FROM feeds
        WHERE enabled = 1
      `,
    )
    .all() as Array<{
    id: string;
    last_fetch_at: number | null;
    poll_interval_mins: number | null;
    fetch_count_since_change: number | null;
  }>;
}

async function runPollCycle(now: number): Promise<PollCycleResult> {
  const globalIntervalMins = getGlobalPollIntervalMins();
  const feeds = getPollableFeeds();
  const dueJobs: JobRecord[] = [];

  for (const feed of feeds) {
    const intervalMins = getEffectivePollIntervalMins(
      feed.poll_interval_mins,
      feed.fetch_count_since_change,
      globalIntervalMins,
    );
    const lastFetch = feed.last_fetch_at || 0;
    if (now - lastFetch < intervalMins * 60 * 1000) continue;

    try {
      dueJobs.push(enqueueFeedFetch(feed.id, { now }));
    } catch (error) {
      recordAppError({
        source: 'poller.enqueue',
        error,
        details: { feedId: feed.id },
      });
    }
  }

  const worker = await runDueJobs({
    now,
    maxJobs: Math.max(DEFAULT_JOB_BATCH_SIZE, dueJobs.length),
  });

  return {
    checked: feeds.length,
    due: dueJobs.length,
    enqueued: dueJobs,
    worker,
  };
}

/**
 * Runs one poll cycle. Calls made while a cycle is in progress share the same
 * promise, so manual refreshes and the timer cannot create duplicate workers.
 */
export function pollFeeds(now = Date.now()): Promise<PollCycleResult> {
  if (pollCycle) return pollCycle;

  // Recovery is intentionally performed before selecting due feeds. This
  // makes a newly restarted process safe even if the first poll interval has
  // not elapsed yet.
  recoverAbandonedJobs(now);
  pollCycle = runPollCycle(now).finally(() => {
    pollCycle = null;
  });
  return pollCycle;
}
