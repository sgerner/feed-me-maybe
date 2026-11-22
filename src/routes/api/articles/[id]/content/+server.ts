import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { fetchPublisherArticle } from '#lib/server/archive.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { isAiProcessingConfigured } from '#lib/server/ai/runtime.ts';
import {
  enqueueAiProcess,
  settleArticleCrawlJob,
} from '#lib/server/feed/job-queue.ts';
import { refreshRankingAfterProfileMutation } from '#lib/server/ranking-freshness.ts';
import { wakePoller } from '#lib/server/poller.ts';

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const article = db
    .prepare(
      `
    SELECT a.feed_id, a.url, a.external_url, a.content, a.summary, f.use_proxy, f.css_selector
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ?
  `,
    )
    .get(params.id) as
    | {
        feed_id: string;
        url: string;
        external_url: string | null;
        content: string | null;
        summary: string | null;
        use_proxy: number;
        css_selector: string | null;
      }
    | undefined;
  if (!article)
    return Response.json({ error: 'Article not found' }, { status: 404 });

  const result = await fetchPublisherArticle(
    article.external_url || article.url,
    article.use_proxy ? getConfiguredProxyBaseUrl() : undefined,
    article.css_selector || undefined,
  );
  if (!result?.content) {
    return Response.json(
      { error: 'The publisher did not return readable article text.' },
      { status: 422 },
    );
  }

  const plainText = (content: string | null | undefined) =>
    (content || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const textLength = (content: string | null | undefined) =>
    plainText(content).length;
  const existingLength = Math.max(
    textLength(article.content),
    textLength(article.summary),
  );
  const nextLength = textLength(result.content);
  const countUserContentIds = (html: string | null | undefined) =>
    (html?.match(/\bid="user-content-/gi) ?? []).length;
  const restoresMissingIds =
    nextLength === existingLength &&
    plainText(result.content) === plainText(article.content) &&
    countUserContentIds(result.content) > countUserContentIds(article.content);
  if (
    existingLength > 0 &&
    nextLength <= existingLength &&
    !restoresMissingIds
  ) {
    return Response.json(
      {
        error:
          'The publisher did not return more text than is already available.',
        alreadyFullText: true,
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
    db.prepare(
      `UPDATE article_ai_metadata
       SET analysis_status = 'pending', analysis_error = '', processed_at = NULL
       WHERE article_id = ?`,
    ).run(params.id);
    settleArticleCrawlJob(params.id, 'completed', {
      feedId: article.feed_id,
      result: { upgraded: true, source: 'manual' },
    });
    refreshRankingAfterProfileMutation(params.id);
    if (isAiProcessingConfigured()) {
      enqueueAiProcess(params.id);
    }
    return true;
  })();
  if (!updated) {
    return Response.json(
      { error: 'The article changed while fetching text. Try again.' },
      { status: 409 },
    );
  }
  wakePoller();
  return Response.json({ content: result.content });
};
