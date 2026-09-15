/// <reference lib="webworker" />

import { clientsClaim, setCacheNameDetails, skipWaiting } from 'workbox-core';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { getMetaValue } from './lib/offline/db';
import { replayOfflineMutations } from './lib/offline/outbox';

declare let self: ServiceWorkerGlobalScope & typeof globalThis;

const OFFLINE_SYNC_TAG = 'feed-me-maybe-outbox-v1';
const PRIVATE_CACHE_PREFIX = 'feed-me-maybe-';

setCacheNameDetails({ prefix: 'feed-me-maybe' });
skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Keep the existing bounded external-image cache. Article JSON/content is
// stored in the authenticated client's IndexedDB library instead of a Cache
// Storage response, so SSR/auth responses never become shared cache entries.
registerRoute(
  ({ request, url }) =>
    request.destination === 'image' && url.origin !== self.location.origin,
  new CacheFirst({
    cacheName: 'feed-me-maybe-article-images-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 80,
        maxAgeSeconds: 30 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  }),
  'GET',
);

function isSyncEvent(event: ExtendableEvent): event is ExtendableEvent & {
  tag: string;
} {
  return (
    'tag' in event &&
    (event as ExtendableEvent & { tag?: string }).tag === OFFLINE_SYNC_TAG
  );
}

async function notifyClients(message: Record<string, unknown>): Promise<void> {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const client of clients) client.postMessage(message);
}

async function clearPrivateCaches(): Promise<void> {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith(PRIVATE_CACHE_PREFIX))
      .map((name) => caches.delete(name)),
  );
}

async function replayForClients(scope?: string): Promise<void> {
  const resolvedScope = scope ?? (await getMetaValue('active-scope'));
  if (typeof resolvedScope !== 'string' || !resolvedScope) {
    await notifyClients({ type: 'FEED_ME_MAYBE_REPLAY_OUTBOX' });
    return;
  }

  const result = await replayOfflineMutations(resolvedScope, {
    fetchImpl: fetch.bind(self),
  });
  await notifyClients({
    type: 'FEED_ME_MAYBE_OUTBOX_RESULT',
    scope: resolvedScope,
    result,
  });
}

self.addEventListener('message', (event) => {
  const message = event.data as { type?: string; scope?: string } | null;
  if (!message?.type) return;

  if (message.type === 'FEED_ME_MAYBE_CLEAR_PRIVATE_DATA') {
    event.waitUntil(clearPrivateCaches());
    return;
  }

  if (message.type === 'FEED_ME_MAYBE_REPLAY_OUTBOX') {
    event.waitUntil(replayForClients(message.scope));
  }
});

self.addEventListener('sync', ((event: ExtendableEvent & { tag: string }) => {
  if (isSyncEvent(event)) event.waitUntil(replayForClients());
}) as EventListener);
