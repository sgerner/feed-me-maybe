/// <reference lib="webworker" />

import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  matchPrecache,
  precacheAndRoute,
} from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { getMetaValue } from './lib/offline/db';
import { replayOfflineMutations } from './lib/offline/outbox';

declare let self: ServiceWorkerGlobalScope & typeof globalThis;

const OFFLINE_SYNC_TAG = 'feed-me-maybe-outbox-v1';
const PRIVATE_CACHE_NAMES = ['feed-me-maybe-article-images-v1'];

setCacheNameDetails({ prefix: 'feed-me-maybe' });
// Activate updates after existing tabs close so their lazy chunks stay cached.
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Keep authenticated SSR navigations network-only. If the request fails at
// the network layer, show the static shell that reads the signed-in user's
// bounded article snapshot from IndexedDB. HTTP responses such as 401 remain
// untouched and no navigation response is written to Cache Storage.
registerRoute(
  ({ request, url }) =>
    request.mode === 'navigate' && url.origin === self.location.origin,
  async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      // SvelteKit's PWA manifest normalizes static HTML assets to extensionless
      // URLs, so offline.html is precached under /offline.
      return (await matchPrecache('/offline')) ?? Response.error();
    }
  },
  'GET',
);

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
      .filter((name) => PRIVATE_CACHE_NAMES.includes(name))
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
