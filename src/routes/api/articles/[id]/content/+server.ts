import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { fetchPublisherArticle } from '#lib/server/archive.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { isAiProcessingConfigured } from '#lib/server/ai/runtime.ts';
import { enqueueAiProcess } from '#lib/server/feed/job-queue.ts';
import { refreshRankingAfterProfileMutation } from '#lib/server/ranking-freshness.ts';
import { wakePoller } from '#lib/server/poller.ts';

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const article = db
    .prepare(
      `
    SELECT a.url, a.external_url, a.content, f.use_proxy
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ?
  `,
    )
    .get(params.id) as
    | {
        url: string;
        external_url: string | null;
        content: string | null;
        use_proxy: number;
      }
    | undefined;
  if (!article) return json({ error: 'Article not found' }, { status: 404 });

  const result = await fetchPublisherArticle(
    article.external_url || article.url,
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

  const updated = db.transaction(() => {
    const update = db
      .prepare(
        "UPDATE articles SET content = ?, image_url = COALESCE(NULLIF(image_url, ''), ?), updated_at = ? WHERE id = ? AND content IS ?",
      )
      .run(
        result.content,
        result.imageUrl ?? null,
        Date.now(),
        params.id,
        article.content,
      );
    if (!update.changes) return false;
    refreshRankingAfterProfileMutation(params.id);
    if (isAiProcessingConfigured()) {
      db.prepare(
        `UPDATE article_ai_metadata
         SET analysis_status = 'pending', analysis_error = '', processed_at = NULL
         WHERE article_id = ? AND analysis_status IN ('failed', 'skipped')`,
      ).run(params.id);
      enqueueAiProcess(params.id);
    }
    return true;
  })();
  if (!updated) {
    return json(
      { error: 'The article changed while fetching text. Try again.' },
      { status: 409 },
    );
  }
  wakePoller();
  return json({ content: result.content });
};
