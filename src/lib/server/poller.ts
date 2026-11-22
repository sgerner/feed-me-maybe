import { getDb } from '#lib/server/db/index.ts';
import { building } from '$app/env';
import {
  enqueueFeedFetch,
  getNextQueuedJobAt,
  reclaimInterruptedProcessingJobs,
  recoverAbandonedJobs,
  runDueJobs,
  type JobRecord,
  type RunJobsResult,
} from '#lib/server/feed/job-queue.ts';
import {
  getEffectivePollIntervalMins,
  getGlobalPollIntervalMins,
} from '#lib/server/feed-management.ts';
import {
  pruneOperationalHistory,
  recordAppError,
} from '#lib/server/logging.ts';

const INITIAL_POLL_DELAY_MS = 1_000;
const DEFAULT_JOB_BATCH_SIZE = 24;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimerDueAt: number | null = null;
let pollStarted = false;
let wakeRequested = false;
let startupReclaimed = false;
let nextHistoryPruneAt = 0;
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
  if (!startupReclaimed) {
    startupReclaimed = true;
    try {
      reclaimInterruptedProcessingJobs();
    } catch (error) {
      recordAppError({ source: 'poller.startup-reclaim', error });
    }
  }
  scheduleNextPoll(INITIAL_POLL_DELAY_MS);
}

export function stopPolling(): void {
  pollStarted = false;
  wakeRequested = false;
  startupReclaimed = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  pollTimerDueAt = null;
}

export function wakePoller(): void {
  if (pollCycle) {
    wakeRequested = true;
  }
  scheduleNextPoll(INITIAL_POLL_DELAY_MS);
}

export function scheduleNextPoll(delayMs?: number): void {
  if (!pollStarted) return;

  const now = Date.now();
  const effectiveDelay =
    delayMs ?? (wakeRequested ? INITIAL_POLL_DELAY_MS : undefined);
  const intervalMins = getGlobalPollIntervalMins();
  const queuedJobAt = getNextQueuedJobAt(now);
  const nextJobDelay =
    queuedJobAt == null
      ? null
      : Math.max(INITIAL_POLL_DELAY_MS, queuedJobAt - now);
  const nextDelay =
    effectiveDelay ??
    Math.min(
      intervalMins * 60 * 1000,
      nextJobDelay ?? Number.POSITIVE_INFINITY,
    );
  const desiredDueAt = now + nextDelay;

  if (pollTimer && pollTimerDueAt !== null && pollTimerDueAt <= desiredDueAt) {
    return;
  }

  if (pollTimer) clearTimeout(pollTimer);
  pollTimerDueAt = desiredDueAt;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    pollTimerDueAt = null;
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
        SELECT id, last_fetch_at, poll_interval_mins, fetch_count_since_change, error_count
        FROM feeds
        WHERE enabled = 1
      `,
    )
    .all() as Array<{
    id: string;
    last_fetch_at: number | null;
    poll_interval_mins: number | null;
    fetch_count_since_change: number | null;
    error_count: number | null;
  }>;
}

async function runPollCycle(now: number): Promise<PollCycleResult> {
  wakeRequested = false;
  if (now >= nextHistoryPruneAt) {
    nextHistoryPruneAt = now + 24 * 60 * 60 * 1000;
    try {
      pruneOperationalHistory(now);
    } catch (error) {
      recordAppError({ source: 'poller.history-retention', error });
    }
  }
  const globalIntervalMins = getGlobalPollIntervalMins();
  const feeds = getPollableFeeds();
  const dueJobs: JobRecord[] = [];

  for (const feed of feeds) {
    const intervalMins = getEffectivePollIntervalMins(
      feed.poll_interval_mins,
      feed.fetch_count_since_change,
      globalIntervalMins,
      feed.error_count ?? 0,
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
