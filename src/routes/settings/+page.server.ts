import { wakePoller } from '#lib/server/poller.ts';
import type { PageServerLoad, Actions } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { fail } from '@sveltejs/kit';
import { isArticleOpenMode } from '#lib/constants/article-open-modes.ts';
import { isJevConfigured, isSubqConfigured } from '#lib/server/ai/jev.ts';
import { getRankingProvider } from '#lib/server/ranking-provider.ts';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};

  const db = getDb();
  const pollInterval = db
    .prepare("SELECT value FROM app_settings WHERE key = 'poll_interval_mins'")
    .get() as { value: string } | undefined;
  const openMode = db
    .prepare("SELECT value FROM app_settings WHERE key = 'article_open_mode'")
    .get() as { value: string } | undefined;
  const hideOnOpen = db
    .prepare("SELECT value FROM app_settings WHERE key = 'hide_on_open'")
    .get() as { value: string } | undefined;

  return {
    pollInterval: parseInt(pollInterval?.value || '15', 10),
    articleOpenMode: openMode?.value || 'app',
    hideOnOpen: hideOnOpen?.value === 'true',
    rankingProvider: getRankingProvider(),
    rankingProviderConfigured: {
      jev: isJevConfigured(),
      subq: isSubqConfigured(),
    },
  };
};

export const actions: Actions = {
  updatePolling: async ({ request, locals }) => {
    if (!locals.sessionId) return fail(401);

    const data = await request.formData();
    const interval = data.get('interval');

    const intervalValue = typeof interval === 'string' ? Number(interval) : NaN;

    if (
      !Number.isInteger(intervalValue) ||
      intervalValue < 1 ||
      intervalValue > 1440
    ) {
      return fail(400, {
        action: 'updatePolling',
        field: 'interval',
        error: 'Enter a whole number from 1 to 1440 minutes.',
      });
    }

    const db = getDb();
    db.prepare(
      "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'poll_interval_mins'",
    ).run(String(intervalValue), Date.now());
    wakePoller();

    return { action: 'updatePolling', success: true };
  },
  updateArticleSettings: async ({ request, locals }) => {
    if (!locals.sessionId) return fail(401);

    const data = await request.formData();
    const openMode = data.get('openMode');
    const hideOnOpen = data.get('hideOnOpen') === 'on';

    if (!openMode || !isArticleOpenMode(openMode)) {
      return fail(400, {
        action: 'updateArticleSettings',
        field: 'openMode',
        error: 'Choose a valid article open mode.',
      });
    }

    const db = getDb();
    db.prepare(
      "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'article_open_mode'",
    ).run(String(openMode), Date.now());
    db.prepare(
      "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'hide_on_open'",
    ).run(hideOnOpen ? 'true' : 'false', Date.now());

    return { action: 'updateArticleSettings', success: true };
  },
};
