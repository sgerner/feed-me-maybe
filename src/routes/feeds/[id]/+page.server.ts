import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { hasConfiguredProxy } from '$lib/server/proxy';
import { getFeedArticles } from '$lib/server/feed/articles';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const feedId = params.id;
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const showHiddenContent = url.searchParams.get('showHidden') === '1';

  // Verify feed exists
  const feed = db
    .prepare('SELECT * FROM feeds WHERE id = ?')
    .get(feedId) as any;
  if (!feed) {
    throw error(404, 'Feed not found');
  }

  const articlePage = getFeedArticles({
    feedId,
    page,
    showHiddenContent,
  });

  return {
    feed,
    articles: articlePage.articles,
    page: articlePage.page,
    totalPages: articlePage.totalPages,
    totalArticles: articlePage.totalArticles,
    hiddenContentLimit: articlePage.hiddenContentLimit,
    showHiddenContent,
    feedId,
    proxyAvailable: hasConfiguredProxy(),
  };
};
