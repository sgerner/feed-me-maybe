import { defineEnvVars } from '@sveltejs/kit/env';

// SvelteKit only exposes variables declared here through `$app/env/private`.
// All of them are optional: the code that reads each one decides whether it is
// required (see README.md for what is needed to run the app).
const optional = (description: string) => ({
  description,
  schema: (value: string | undefined) => value,
});

export const variables = defineEnvVars({
  APP_PASSWORD: optional('Password for application access.'),
  APP_SECRET: optional(
    'Random secret used to encrypt provider and webhook credentials.',
  ),
  DATABASE_URL: optional('Path to the SQLite database file.'),
  PROXY_BASE_URL: optional(
    'Generic proxy worker used for per-feed proxying, Reddit comments, and other blocked fetches.',
  ),
  REDDIT_BASE_URL: optional('Legacy alias for PROXY_BASE_URL.'),
});
