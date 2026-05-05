import { addToast } from '$lib/stores/toast.svelte';

export async function syncFeeds(options: { silent?: boolean } = {}) {
  const { silent = false } = options;
  try {
    const res = await fetch('/api/feeds/refresh', { method: 'POST' });
    if (res.ok && !silent) {
      addToast('Syncing feeds in background', 'success');
    }
    return res.ok;
  } catch (err) {
    if (!silent) {
      addToast('Sync failed', 'error');
    }
    return false;
  }
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
