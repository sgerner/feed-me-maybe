import { getDb } from '$lib/server/db';
import { building } from '$app/environment';
import { ingestFeed } from '$lib/server/feed/ingester';

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let isPolling = false;

export function startPolling(): void {
  if (building || pollTimer) return;
  console.log('[poller] Starting background feed polling loop');
  scheduleNextPoll(10000); // Start first poll in 10 seconds
}

export function stopPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(delayMs?: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  
  const intervalMins = getGlobalPollInterval();
  const nextDelay = delayMs ?? (intervalMins * 60 * 1000);
  
  pollTimer = setTimeout(async () => {
    await pollFeeds();
    scheduleNextPoll();
  }, nextDelay);
}

function getGlobalPollInterval(): number {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'poll_interval_mins'").get() as { value: string } | undefined;
    return parseInt(row?.value || '15', 10);
  } catch {
    return 15;
  }
}

async function pollFeeds(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const db = getDb();
    const globalIntervalMins = getGlobalPollInterval();
    
    // Select enabled feeds
    const feeds = db.prepare('SELECT id, url, last_fetch_at, poll_interval_mins, fetch_count_since_change FROM feeds WHERE enabled = 1').all() as { 
      id: string; 
      url: string; 
      last_fetch_at: number | null;
      poll_interval_mins: number;
      fetch_count_since_change: number;
    }[];
    
    console.log(`[poller] Checking ${feeds.length} feeds for updates (Global interval: ${globalIntervalMins}m)`);
    
    for (const feed of feeds) {
      // Simple adaptive logic: 
      // If we've fetched many times without change, back off.
      // fetch_count_since_change is incremented in ingester.ts when no new articles are found.
      let effectiveIntervalMins = feed.poll_interval_mins || globalIntervalMins;
      
      if (feed.fetch_count_since_change > 10) {
        effectiveIntervalMins *= 2; // Slow down
      }
      if (feed.fetch_count_since_change > 50) {
        effectiveIntervalMins *= 2; // Slow down further
      }
      
      // Cap at 24 hours
      effectiveIntervalMins = Math.min(effectiveIntervalMins, 24 * 60);

      const now = Date.now();
      const lastFetch = feed.last_fetch_at || 0;
      const msSinceLastFetch = now - lastFetch;
      
      if (msSinceLastFetch >= effectiveIntervalMins * 60 * 1000) {
        try {
          console.log(`[poller] Polling feed: ${feed.id} (Effective interval: ${effectiveIntervalMins}m)`);
          await ingestFeed({ feedId: feed.id, url: feed.url });
        } catch (err) {
          console.error(`[poller] Error refreshing feed ${feed.id}:`, err);
        }
      }
    }
  } finally {
    isPolling = false;
  }
}
