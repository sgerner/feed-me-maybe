import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('offline PWA contract', () => {
  it('publishes safe icons and authenticated entry-point shortcuts', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'static/manifest.json'), 'utf8'),
    ) as {
      shortcuts?: Array<{ url?: string }>;
      icons?: Array<{ purpose?: string; src?: string }>;
    };

    expect(manifest.shortcuts?.map((shortcut) => shortcut.url)).toEqual([
      '/',
      '/search',
      '/digest',
      '/saved',
    ]);
    expect(manifest.icons?.map((icon) => icon.purpose)).toEqual([
      'any',
      'maskable',
      'any',
      'maskable',
    ]);
    expect(
      manifest.icons
        ?.filter((icon) => icon.purpose === 'maskable')
        .map((icon) => icon.src),
    ).toEqual([
      '/android-chrome-maskable-192x192.png',
      '/android-chrome-maskable-512x512.png',
    ]);

    const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain("purpose: 'maskable'");
    expect(viteConfig).not.toContain("purpose: 'any maskable'");
  });

  it('keeps the custom worker authenticated-navigation safe', () => {
    const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    const serviceWorker = readFileSync(
      resolve(root, 'src/service-worker.ts'),
      'utf8',
    );

    expect(viteConfig).toContain("strategies: 'injectManifest'");
    expect(viteConfig).toContain("filename: 'service-worker.ts'");
    expect(viteConfig).toContain("base: '/'");
    expect(viteConfig).toContain("scope: '/'");
    expect(serviceWorker).toContain('precacheAndRoute(self.__WB_MANIFEST)');
    expect(serviceWorker).toContain("request.destination === 'image'");
    expect(serviceWorker).toContain('FEED_ME_MAYBE_CLEAR_PRIVATE_DATA');
    expect(serviceWorker).toContain("'sync'");
    expect(serviceWorker).toContain("request.mode === 'navigate'");
    expect(serviceWorker).toContain("matchPrecache('/offline')");
    expect(serviceWorker).toContain('return await fetch(request)');
    expect(serviceWorker).toContain('PRIVATE_CACHE_NAMES.includes(name)');
    expect(serviceWorker).not.toContain('startsWith(PRIVATE_CACHE_PREFIX)');
  });

  it('uses a static fallback that reads only the active account from IndexedDB', () => {
    const offlinePage = readFileSync(
      resolve(root, 'static/offline.html'),
      'utf8',
    );
    const appHtml = readFileSync(resolve(root, 'src/app.html'), 'utf8');

    expect(appHtml).toContain('%sveltekit.assets%/registerSW.js');
    expect(offlinePage).toContain("'feed-me-maybe-offline'");
    expect(offlinePage).toContain("get('active-scope')");
    expect(offlinePage).toContain('item.scope === scope');
    expect(offlinePage).toContain('heading.textContent = article.title');
  });
});
