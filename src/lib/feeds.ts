import { addToast } from '$lib/stores/toast.svelte';

let syncRequest: Promise<boolean> | null = null;
let lastSilentSyncAt = 0;
const SILENT_SYNC_COOLDOWN_MS = 30_000;

export async function syncFeeds(options: { silent?: boolean } = {}) {
  const { silent = false } = options;
  if (syncRequest) return syncRequest;
  if (silent && Date.now() - lastSilentSyncAt < SILENT_SYNC_COOLDOWN_MS) {
    return true;
  }

  if (silent) lastSilentSyncAt = Date.now();
  syncRequest = (async () => {
    try {
      const res = await fetch('/api/feeds/refresh', { method: 'POST' });
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

export async function syncFeed(feedId: string, options: { silent?: boolean } = {}) {
  const { silent = false } = options;
  try {
    const res = await fetch(`/api/feeds/${feedId}/refresh`, {
      method: 'POST',
    });
    if (res.ok && !silent) {
      addToast('Syncing feed...', 'success');
    }
    return res.ok;
  } catch (err) {
    if (!silent) {
      addToast('Sync failed', 'error');
    }
    return false;
  }
}
