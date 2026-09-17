import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('offline PWA contract', () => {
  it('publishes transparent-safe icons and authenticated entry-point shortcuts', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'static/manifest.json'), 'utf8'),
    ) as {
      shortcuts?: Array<{ url?: string }>;
      icons?: Array<{ purpose?: string }>;
    };

    expect(manifest.shortcuts?.map((shortcut) => shortcut.url)).toEqual([
      '/',
      '/search',
      '/digest',
      '/saved',
    ]);
    expect(manifest.icons?.map((icon) => icon.purpose)).toEqual(['any', 'any']);
    expect(readFileSync(resolve(root, 'vite.config.ts'), 'utf8')).not.toContain(
      "purpose: 'any maskable'",
    );
  });

  it('keeps the custom worker authenticated-navigation safe', () => {
    const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    const serviceWorker = readFileSync(
      resolve(root, 'src/service-worker.ts'),
      'utf8',
    );

    expect(viteConfig).toContain("strategies: 'injectManifest'");
    expect(viteConfig).toContain("filename: 'service-worker.ts'");
    expect(serviceWorker).toContain('precacheAndRoute(self.__WB_MANIFEST)');
    expect(serviceWorker).toContain("request.destination === 'image'");
    expect(serviceWorker).toContain('FEED_ME_MAYBE_CLEAR_PRIVATE_DATA');
    expect(serviceWorker).toContain("'sync'");
  });
});
