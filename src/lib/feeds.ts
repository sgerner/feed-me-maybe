import { addToast } from '$lib/stores/toast.svelte';
import { fetchWithCsrf } from '$lib/client/csrf';

let syncRequest: Promise<boolean> | null = null;
let lastSilentSyncAt = 0;
const SILENT_SYNC_COOLDOWN_MS = 30_000;

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function prefersReducedNetworkActivity() {
  if (typeof navigator === 'undefined') return false;
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean };
    }
  ).connection;
  return connection?.saveData === true;
}

export async function syncFeeds(options: { silent?: boolean } = {}) {
  const { silent = false } = options;
  if (syncRequest) return syncRequest;
  if (isOffline()) return false;
  if (silent && prefersReducedNetworkActivity()) return true;
  if (silent && Date.now() - lastSilentSyncAt < SILENT_SYNC_COOLDOWN_MS) {
    return true;
  }

  if (silent) lastSilentSyncAt = Date.now();
  syncRequest = (async () => {
    try {
      const res = await fetchWithCsrf('/api/feeds/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !silent }),
      });
      if (res.ok && !silent) {
        addToast('Syncing feeds in background', 'success');
      }
      return res.ok;
    } catch {
      if (!silent) addToast('Sync failed', 'error');
      return false;
    } finally {
      syncRequest = null;
    }
  })();

  return syncRequest;
}

export async function syncFeed(
  feedId: string,
  options: { silent?: boolean } = {},
): Promise<'completed' | 'failed' | 'pending' | false> {
  const { silent = false } = options;
  if (isOffline()) return false;
  try {
    const res = await fetchWithCsrf(`/api/feeds/${feedId}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !silent }),
    });
    if (!res.ok) throw new Error('Feed sync request failed');
    if (silent) return 'pending';
    const queued = (await res.json()) as {
      job?: { id?: string; status?: string };
    };
    const jobId = queued.job?.id;
    if (!jobId) throw new Error('Feed sync response did not include a job');

    const deadline = Date.now() + 30_000;
    let status = queued.job?.status;
    while (
      status !== 'completed' &&
      status !== 'failed' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      try {
        const poll = await fetch(
          `/api/feeds/${encodeURIComponent(feedId)}/refresh?jobId=${encodeURIComponent(jobId)}`,
          { cache: 'no-store' },
        );
        if (!poll.ok) break;
        const detail = (await poll.json()) as {
          job?: { status?: string } | null;
          fetch?: { errorMessage?: string } | null;
        };
        status = detail.job?.status;
        if (status === 'failed') {
          if (!silent) {
            addToast(detail.fetch?.errorMessage || 'Feed sync failed', 'error');
          }
          return 'failed';
        }
      } catch {
        // Keep polling after a transient connection failure until the bounded wait ends.
      }
    }

    if (status === 'completed') {
      if (!silent) addToast('Feed sync finished', 'success');
      return 'completed';
    }
    if (!silent) addToast('Feed sync is still queued or running', 'info');
    return 'pending';
  } catch {
    if (!silent) {
      addToast('Sync failed', 'error');
    }
    return false;
  }
}
