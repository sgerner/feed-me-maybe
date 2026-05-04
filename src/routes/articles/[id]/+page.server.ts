import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { recordInteraction } from '$lib/server/interactions';
import { fetchArchivedArticle } from '$lib/server/archive';
import { getConfiguredProxyBaseUrl } from '$lib/server/proxy';

export const load: PageServerLoad = async ({ params, locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const article = db
    .prepare(
      `
    SELECT a.*, f.title as feed_title, f.url as feed_url, f.site_url as feed_site_url,
           f.use_proxy as feed_use_proxy,
           am.summary as ai_summary, am.topics, am.content_type, am.explanation
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_ai_metadata am ON am.article_id = a.id
    WHERE a.id = ?
  `,
    )
    .get(params.id) as Record<string, unknown> | undefined;

  if (!article) {
    throw error(404, 'Article not found');
  }

  recordInteraction(params.id, 'open');

  if (url.searchParams.get('mode') === 'archive') {
    const archived = await fetchArchivedArticle(
      String(article.url || ''),
      String(article.title || 'Archived Article'),
    );

    if (archived) {
      article.title = archived.title || article.title;
      article.content = archived.content;
      article.image_url = archived.imageUrl || article.image_url;
      article.archive_url = archived.archiveUrl;
    }
  }

  return {
    article,
    proxyBaseUrl: getConfiguredProxyBaseUrl() || null,
  };
};
