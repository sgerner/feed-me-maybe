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

  article.feed_site_url = safeFeedSiteUrl(article.feed_site_url);

  if (!article.hidden && !article.rejected && !article.thumbs_down) {
    recordInteraction(params.id, 'open');
  }

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

  const published = Number(article.published_at ?? article.fetched_at);
  const neighbor = (previous: boolean) => {
    const comparison = previous ? '>' : '<';
    const order = previous ? 'ASC' : 'DESC';
    const row = db
      .prepare(
        `
      SELECT id FROM articles
      WHERE feed_id = ? AND hidden = 0 AND thumbs_down = 0
        AND (COALESCE(published_at, fetched_at), id) ${comparison} (?, ?)
      ORDER BY COALESCE(published_at, fetched_at) ${order}, id ${order}
      LIMIT 1
    `,
      )
      .get(article.feed_id, published, params.id) as { id: string } | undefined;
    return row?.id ?? null;
  };

  return {
    article,
    neighbors: { previous: neighbor(true), next: neighbor(false) },
    proxyBaseUrl: getConfiguredProxyBaseUrl() || null,
  };
};

function safeFeedSiteUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  } catch {
    return '';
  }
}
