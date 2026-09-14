import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig({
  server: {
    port: 5373,
    strictPort: false,
  },
  plugins: [
    tailwindcss(),
    sveltekit(),
    SvelteKitPWA({
      // SvelteKit SSR does not inject the generated registration script into
      // app.html; the deferred script tag is declared there explicitly.
      injectRegister: 'auto',
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.png',
        'apple-touch-icon.png',
        'favicon.ico',
        'manifest.json',
      ],
      manifest: {
        name: 'Feed Me Maybe',
        short_name: 'FeedMeMaybe',
        description: 'AI-powered RSS reader',
        id: '/',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        lang: 'en',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
        // Project screenshots are documentation, not runtime assets. Excluding
        // them keeps install/update downloads small and prevents oversized
        // screenshots from breaking service-worker generation.
        globIgnores: ['**/projects/**'],
        cleanupOutdatedCaches: true,
        // This is an SSR app: caching a generic navigation fallback can serve
        // stale or unauthenticated HTML. Let navigations reach the server and
        // keep offline caching limited to immutable assets and article media.
        navigateFallback: undefined,
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) =>
              request.destination === 'image' &&
              url.origin !== self.location.origin,
            handler: 'CacheFirst',
            options: {
              cacheName: 'feed-me-maybe-article-images-v1',
              cacheableResponse: { statuses: [0, 200] },
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 30 * 24 * 60 * 60,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
      },
    }),
  ],
});
