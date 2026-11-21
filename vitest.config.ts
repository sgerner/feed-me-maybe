import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  // Kit loads .env files into $app/env/private under Vitest too. Point it at a
  // directory without any so tests only see what they export themselves.
  plugins: [sveltekit({ env: { dir: 'src' } })],
  test: {
    include: [
      'src/**/*.{test,spec}.{js,ts}',
      'reddit-proxy/**/*.{test,spec}.{js,ts}',
    ],
    environment: 'node',
    globals: true,
  },
});
