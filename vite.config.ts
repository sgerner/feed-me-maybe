import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { withPwa } from '@vite-pwa/sveltekit';

export default defineConfig({
  server: {
    port: 5373,
    strictPort: false,
  },
  plugins: [
    tailwindcss(),
    // withPwa runs sveltekit() itself so the PWA build can hook the adapter.
    withPwa(
      { preprocess: vitePreprocess(), adapter: adapter() },
      {
        base: '/',
        scope: '/',
        // SvelteKit SSR does not inject the generated registration script into
        // app.html; the deferred script tag is declared there explicitly.
        injectRegister: 'auto',
        registerType: 'prompt',
        strategies: 'buildSW',
        // Existing installs are registered at this URL; changing it would leave
        // them on the old worker forever. The source file must not live at
        // src/service-worker.* or SvelteKit would build and register it too.
        filename: 'service-worker.js',
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
                  purpose: 'any',
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
                  purpose: 'any',
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
                  purpose: 'any',
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
                  purpose: 'any',
                },
              ],
            },
          ],
          icons: [
            {
              src: '/android-chrome-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/android-chrome-maskable-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: '/android-chrome-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/android-chrome-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        buildSW: {
          swSrc: 'src/sw.ts',
          // The plugin always adds a prerendered/** glob; this app prerenders
          // nothing, so strict matching would fail the build.
          globStrict: false,
          // Paths are relative to .svelte-kit/output, so assets live under client/.
          globPatterns: ['client/**/*.{js,css,html,ico,png,svg,webp}'],
          // Project screenshots are documentation, not runtime assets. Excluding
          // them keeps install/update downloads small and prevents oversized
          // screenshots from breaking service-worker generation.
          globIgnores: ['**/projects/**'],
        },
        // SSR/auth navigations are intentionally not given a generic fallback.
        // The custom worker owns only precaching and offline coordination.
      },
    ),
  ],
});
