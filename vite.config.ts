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
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
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
        categories: ['news', 'productivity'],
        shortcuts: [
          {
            name: 'Inbox',
            short_name: 'Inbox',
            description: 'Open the latest feed articles',
            url: '/',
            icons: [
              {
                src: '/android-chrome-192x192.png',
                sizes: '192x192',
                type: 'image/png',
              },
            ],
          },
          {
            name: 'Search',
            short_name: 'Search',
            description: 'Search your reading library',
            url: '/search',
            icons: [
              {
                src: '/android-chrome-192x192.png',
                sizes: '192x192',
                type: 'image/png',
              },
            ],
          },
          {
            name: 'Digest',
            short_name: 'Digest',
            description: 'Open your calm daily briefing',
            url: '/digest',
            icons: [
              {
                src: '/android-chrome-192x192.png',
                sizes: '192x192',
                type: 'image/png',
              },
            ],
          },
          {
            name: 'Saved',
            short_name: 'Saved',
            description: 'Open saved articles',
            url: '/saved',
            icons: [
              {
                src: '/android-chrome-192x192.png',
                sizes: '192x192',
                type: 'image/png',
              },
            ],
          },
        ],
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
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
        // Project screenshots are documentation, not runtime assets. Excluding
        // them keeps install/update downloads small and prevents oversized
        // screenshots from breaking service-worker generation.
        globIgnores: ['**/projects/**'],
      },
      workbox: {
        // SSR/auth navigations are intentionally not given a generic fallback.
        // The custom worker owns only precaching and offline coordination.
      },
    }),
  ],
});
