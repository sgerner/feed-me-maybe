import { getDb } from '$lib/server/db';
import { fetchFeed } from '$lib/server/feed/fetcher';
import {
  isRedditUrl,
  normalizeRedditUrl,
  fetchRedditSource,
} from '$lib/server/sources/reddit';
import { applyPreferenceModelToArticle } from '$lib/server/preferences';
import { processArticle } from '$lib/server/ai/processor';
import { dispatchWebhookEvent } from '$lib/server/webhooks';
import crypto from 'node:crypto';

interface IngestOptions {
  feedId: string;
  url: string;
}

interface IngestResult {
  success: boolean;
  articlesFound: number;
  articlesNew: number;
  error?: string;
  feedTitle?: string;
  feedDescription?: string;
  feedLink?: string;
  feedImageUrl?: string;
}

function generateArticleId(url: string, title: string, guid?: string): string {
  if (guid) {
    return crypto
      .createHash('sha256')
      .update(guid)
      .digest('hex')
      .substring(0, 32);
  }
  return crypto
    .createHash('sha256')
    .update(`${url}|${title}`)
    .digest('hex')
    .substring(0, 32);
}

export async function ingestFeed(
  options: IngestOptions,
): Promise<IngestResult> {
  const db = getDb();
  const { feedId, url } = options;
  const logId = crypto.randomUUID();

  // Get current caching headers and state
  const feedRecord = db
    .prepare(
      'SELECT etag, last_modified_header, fetch_count_since_change, custom_title FROM feeds WHERE id = ?',
    )
    .get(feedId) as
    | {
        etag: string | null;
        last_modified_header: string | null;
        fetch_count_since_change: number;
        custom_title: number;
      }
    | undefined;

  // Record fetch start
  db.prepare(
    'INSERT INTO feed_fetch_logs (id, feed_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(logId, feedId, 'fetching', Date.now(), Date.now());
  db.prepare(
    "UPDATE feeds SET last_fetch_status = 'fetching', last_fetch_at = ? WHERE id = ?",
  ).run(Date.now(), feedId);

  // Fetch the feed with caching headers
  let fetchResult;
  if (isRedditUrl(url)) {
    const redditSource = normalizeRedditUrl(url);
    fetchResult = await fetchRedditSource(redditSource);
  } else {
    fetchResult = await fetchFeed(url, {
      etag: feedRecord?.etag || undefined,
      lastModified: feedRecord?.last_modified_header || undefined,
    });
  }

  if (fetchResult.notModified) {
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, articles_found = 0, articles_new = 0, completed_at = ? WHERE id = ?',
    ).run('success', Date.now(), logId);
    db.prepare(
      "UPDATE feeds SET last_fetch_status = 'success', error_count = 0, fetch_count_since_change = ?, updated_at = ? WHERE id = ?",
    ).run((feedRecord?.fetch_count_since_change || 0) + 1, Date.now(), feedId);
    return { success: true, articlesFound: 0, articlesNew: 0 };
  }

  if (!fetchResult.success) {
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?',
    ).run('error', fetchResult.error || 'Unknown error', Date.now(), logId);
    db.prepare(
      "UPDATE feeds SET last_fetch_status = 'error', last_error = ?, updated_at = ? WHERE id = ?",
    ).run(fetchResult.error || 'Unknown error', Date.now(), feedId);
    return {
      success: false,
      articlesFound: 0,
      articlesNew: 0,
      error: fetchResult.error,
    };
  }

  // Update feed metadata
  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (fetchResult.title && !feedRecord?.custom_title) {
    updates.push('title = ?');
    values.push(fetchResult.title);
  }
  if (fetchResult.description) {
    updates.push('description = ?');
    values.push(fetchResult.description);
  }
  if (fetchResult.link) {
    updates.push('site_url = ?');
    values.push(fetchResult.link);
  }
  if (fetchResult.imageUrl) {
    updates.push('icon_url = ?');
    values.push(fetchResult.imageUrl);
  }

  // Cache headers
  if (fetchResult.etag) {
    updates.push('etag = ?');
    values.push(fetchResult.etag);
  }
  if (fetchResult.lastModified) {
    updates.push('last_modified_header = ?');
    values.push(fetchResult.lastModified);
  }

  if (updates.length > 0) {
    updates.push('updated_at = ?');
    values.push(Date.now());
    values.push(feedId);
    db.prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`).run(
      ...values,
    );
  }

  // Process articles in a transaction for atomicity
  const newArticleIds: string[] = [];
  const ingestTx = db.transaction(() => {
    let articlesNew = 0;
    for (const item of fetchResult.items) {
      // Skip items without URL
      if (!item.url) continue;

      const articleId = generateArticleId(item.url, item.title, item.guid);

      // Skip duplicate or update missing data
      const existing = db
        .prepare('SELECT id, image_url, content, external_url FROM articles WHERE id = ?')
        .get(articleId) as
        | { id: string; image_url: string; content: string; external_url: string }
        | undefined;
      if (existing) {
        let needsUpdate = false;
        const updates: string[] = [];
        const params: any[] = [];

        if (!existing.image_url && item.imageUrl) {
          updates.push('image_url = ?');
          params.push(item.imageUrl);
          needsUpdate = true;
        }

        if (!existing.external_url && item.externalUrl) {
          updates.push('external_url = ?');
          params.push(item.externalUrl);
          needsUpdate = true;
        }

        // If the new content is significantly longer, it's likely a transition from snippet to full content
        const currentLen = existing.content?.length || 0;
        const newLen = item.content?.length || 0;
        if (newLen > currentLen + 50 || (newLen > 0 && !existing.content)) {
          updates.push('content = ?, summary = ?');
          params.push(item.content, item.summary || '');
          needsUpdate = true;
        }

        if (needsUpdate) {
          params.push(articleId);
          db.prepare(
            `UPDATE articles SET ${updates.join(', ')} WHERE id = ?`,
          ).run(...params);
        }
        continue;
      }

      // Insert new article
      db.prepare(
        'INSERT INTO articles (id, feed_id, guid, url, title, author, summary, content, image_url, external_url, categories, published_at, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        articleId,
        feedId,
        item.guid || '',
        item.url,
        item.title,
        item.author || '',
        item.summary || '',
        item.content || '',
        item.imageUrl || '',
        item.externalUrl || '',
        JSON.stringify(item.categories),
        item.publishedAt ? item.publishedAt.getTime() : null,
        Date.now(),
        Date.now(),
        Date.now(),
      );
      applyPreferenceModelToArticle(articleId);

      // Trigger webhook for new article
      const newArticle = db
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(articleId) as any;
      if (newArticle) {
        dispatchWebhookEvent({
          type: 'article.ingested',
          timestamp: Date.now(),
          payload: { article: newArticle },
        });
      }

      newArticleIds.push(articleId);
      articlesNew++;
    }

    // Update fetch log
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, articles_found = ?, articles_new = ?, completed_at = ? WHERE id = ?',
    ).run('success', fetchResult.items.length, articlesNew, Date.now(), logId);

    // Update feed status and adaptive polling info
    if (articlesNew > 0) {
      db.prepare(
        "UPDATE feeds SET last_fetch_status = 'success', error_count = 0, last_changed_at = ?, fetch_count_since_change = 0, updated_at = ? WHERE id = ?",
      ).run(Date.now(), Date.now(), feedId);
    } else {
      db.prepare(
        "UPDATE feeds SET last_fetch_status = 'success', error_count = 0, fetch_count_since_change = ?, updated_at = ? WHERE id = ?",
      ).run(
        (feedRecord?.fetch_count_since_change || 0) + 1,
        Date.now(),
        feedId,
      );
    }

    return articlesNew;
  });

  try {
    const articlesNew = ingestTx();

    // Trigger AI processing for new articles in background
    // We limit this to the most recent/relevant ones if there are many to avoid hammering API
    const articlesToProcess = newArticleIds.slice(0, 5);
    for (const articleId of articlesToProcess) {
      processArticle(articleId).catch((err) =>
        console.error(`[ingester] AI processing failed for ${articleId}:`, err),
      );
    }

    return {
      success: true,
      articlesFound: fetchResult.items.length,
      articlesNew,
      feedTitle: fetchResult.title,
      feedDescription: fetchResult.description,
      feedLink: fetchResult.link,
      feedImageUrl: fetchResult.imageUrl,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Transaction failed';
    // Log the error
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?',
    ).run('error', errorMessage, Date.now(), logId);
    db.prepare(
      "UPDATE feeds SET last_fetch_status = 'error', last_error = ?, updated_at = ? WHERE id = ?",
    ).run(errorMessage, Date.now(), feedId);
    return {
      success: false,
      articlesFound: 0,
      articlesNew: 0,
      error: errorMessage,
    };
  }
}
