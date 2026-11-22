import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { hasExplicitHide } from '#lib/server/preferences.ts';
import { recordInteraction } from '#lib/server/interactions.ts';
import { fetchArchivedArticle, isGarbageContent } from '#lib/server/archive.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { resolveStreamNeighbors } from '#lib/server/reader-neighbors.ts';

function stripHtmlText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
    LEFT JOIN article_ai_metadata am ON am.article_id = a.id AND am.analysis_status = 'ready'
    WHERE a.id = ?
  `,
    )
    .get(params.id) as Record<string, unknown> | undefined;

  if (!article) {
    throw error(404, 'Article not found');
  }

  article.feed_site_url = safeFeedSiteUrl(article.feed_site_url);

  // Resolve stream-aware neighbors BEFORE recordInteraction mutates `read` or
  // `hidden` flags (e.g. marking an `/inbox` item read or `hide_on_open`).
  const { neighbors, returnPath } = resolveStreamNeighbors(
    db,
    {
      id: String(article.id),
      feed_id: String(article.feed_id),
      published_at: (article.published_at as number | null) ?? null,
      fetched_at: (article.fetched_at as number | null) ?? null,
    },
    url.searchParams.get('from'),
  );

  if (!article.hidden && !article.rejected && !article.thumbs_down) {
    recordInteraction(params.id, 'open');
  }

  // Read state and explicit-hide flag after `open` so hidden, state_version,
  // and read flags reflect any hide-on-open / open updates immediately.
  const readerState = db
    .prepare(
      'SELECT read, read_at, saved, saved_at, hidden, hidden_at, thumbs_up, thumbs_down, rejected, rejected_at, state_version, updated_at FROM articles WHERE id = ?',
    )
    .get(params.id);
  if (readerState) Object.assign(article, readerState);
  article.explicitly_hidden = hasExplicitHide(params.id);

  let archiveFailed = false;
  if (url.searchParams.get('mode') === 'archive') {
    const archived = await fetchArchivedArticle(
      String(article.external_url || article.url || ''),
      String(article.title || 'Archived Article'),
      article.feed_use_proxy ? getConfiguredProxyBaseUrl() : undefined,
    );

    if (archived && archived.content && !isGarbageContent(archived.content)) {
      const existingLength = Math.max(
        stripHtmlText(article.content).length,
        stripHtmlText(article.summary).length,
      );
      const archivedLength = stripHtmlText(archived.content).length;
      article.archive_url = archived.archiveUrl;
      article.image_url = archived.imageUrl || article.image_url;

      if (archivedLength >= existingLength || !existingLength) {
        const countUserContentIds = (html: unknown) =>
          typeof html === 'string'
            ? (html.match(/\bid="user-content-/gi) ?? []).length
            : 0;
        article.title = archived.title || article.title;
        const previousContent = article.content;
        article.content = archived.content;
        if (
          archivedLength > existingLength ||
          (archivedLength === existingLength &&
            stripHtmlText(archived.content) ===
              stripHtmlText(previousContent) &&
            countUserContentIds(archived.content) >
              countUserContentIds(previousContent))
        ) {
          db.prepare(
            "UPDATE articles SET content = ?, image_url = COALESCE(NULLIF(image_url, ''), ?), updated_at = ? WHERE id = ?",
          ).run(
            archived.content,
            archived.imageUrl ?? null,
            Date.now(),
            params.id,
          );
        }
      } else {
        archiveFailed = true;
      }
    } else {
      archiveFailed = true;
    }
  }

  return {
    article,
    neighbors,
    returnPath,
    proxyBaseUrl: getConfiguredProxyBaseUrl() || null,
    archiveFailed,
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
