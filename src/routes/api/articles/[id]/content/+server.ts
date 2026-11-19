import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { fetchPublisherArticle } from '$lib/server/archive';
import { getConfiguredProxyBaseUrl } from '$lib/server/proxy';

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const article = db
    .prepare(
      `
    SELECT a.url, a.content, f.use_proxy
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ?
  `,
    )
    .get(params.id) as
    { url: string; content: string | null; use_proxy: number } | undefined;
  if (!article) return json({ error: 'Article not found' }, { status: 404 });

  const result = await fetchPublisherArticle(
    article.url,
    article.use_proxy ? getConfiguredProxyBaseUrl() : undefined,
  );
  if (!result?.content) {
    return json(
      { error: 'The publisher did not return readable article text.' },
      { status: 422 },
    );
  }

  const textLength = (content: string) =>
    content
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim().length;
  if (
    article.content &&
    textLength(result.content) <= textLength(article.content)
  ) {
    return json(
      {
        error:
          'The publisher did not return more text than is already available.',
      },
      { status: 422 },
    );
  }

  const update = db
    .prepare('UPDATE articles SET content = ? WHERE id = ? AND content IS ?')
    .run(result.content, params.id, article.content);
  if (!update.changes) {
    return json(
      { error: 'The article changed while fetching text. Try again.' },
      { status: 409 },
    );
  }
  return json({ content: result.content });
};
