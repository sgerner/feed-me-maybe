import { DOMParser } from 'linkedom';
import { getDb } from './db';
import { isRedditUrl, normalizeRedditUrl } from './sources/reddit';
import { enqueueFeedFetch } from './feed/job-queue';
import { normalizeFeedUrl } from './feed-management';
import { validatePublicUrl } from './network';
import { wakePoller } from './poller';
import crypto from 'node:crypto';

export function exportOpml(): string {
  const db = getDb();
  const feeds = db
    .prepare(
      'SELECT url, title, site_url, description, category, source_type, source_metadata FROM feeds WHERE enabled = 1',
    )
    .all() as Array<Record<string, string>>;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
<head><title>Feed Me Maybe Export</title></head>
<body>\n`;

  const categorized: Record<string, typeof feeds> = {};
  const uncategorized: typeof feeds = [];

  for (const feed of feeds) {
    if (feed.category) {
      if (!categorized[feed.category]) categorized[feed.category] = [];
      categorized[feed.category].push(feed);
    } else {
      uncategorized.push(feed);
    }
  }

  // Export categorized feeds in groups
  for (const [cat, catFeeds] of Object.entries(categorized)) {
    xml += `  <outline text="${escapeXml(cat)}">\n`;
    for (const feed of catFeeds) {
      const xmlUrl = getExportUrl(feed);
      const htmlUrl = feed.site_url
        ? ` htmlUrl="${escapeXml(feed.site_url)}"`
        : '';
      xml += `    <outline text="${escapeXml(feed.title || xmlUrl)}" type="rss" xmlUrl="${escapeXml(xmlUrl)}"${htmlUrl}/>\n`;
    }
    xml += `  </outline>\n`;
  }

  // Export uncategorized feeds
  for (const feed of uncategorized) {
    const xmlUrl = getExportUrl(feed);
    const htmlUrl = feed.site_url
      ? ` htmlUrl="${escapeXml(feed.site_url)}"`
      : '';
    xml += `  <outline text="${escapeXml(feed.title || xmlUrl)}" type="rss" xmlUrl="${escapeXml(xmlUrl)}"${htmlUrl}/>\n`;
  }

  xml += '</body>\n</opml>';
  return xml;
}

export interface OpmlOutline {
  text?: string;
  xmlUrl?: string;
  htmlUrl?: string;
  type?: string;
  category?: string;
}

export function parseOpml(xml: string): OpmlOutline[] {
  const outlines: OpmlOutline[] = [];
  const document = new DOMParser().parseFromString(xml, 'text/xml');

  function getAttr(element: Element, name: string): string | undefined {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase() === name.toLowerCase()) {
        return attribute.value;
      }
    }
    return undefined;
  }

  function visit(element: Element, inheritedCategory = ''): void {
    for (const child of Array.from(element.children)) {
      if (child.localName.toLowerCase() !== 'outline') {
        visit(child, inheritedCategory);
        continue;
      }

      const xmlUrl = getAttr(child, 'xmlUrl');
      const text = getAttr(child, 'text') || getAttr(child, 'title');
      const category = getAttr(child, 'category') || inheritedCategory;
      if (xmlUrl) {
        outlines.push({
          text,
          xmlUrl,
          htmlUrl: getAttr(child, 'htmlUrl'),
          type: getAttr(child, 'type'),
          category,
        });
      }

      visit(child, text || inheritedCategory);
    }
  }

  visit(document as unknown as Element);

  return outlines;
}

export function importOpml(xml: string): {
  imported: number;
  errors: string[];
} {
  const db = getDb();
  const outlines = parseOpml(xml);
  let imported = 0;
  const errors: string[] = [];
  const importTx = db.transaction(() => {
    for (const outline of outlines) {
      if (!outline.xmlUrl) continue;
      try {
        const added = db.transaction(() => {
          const safeUrl = safeHttpUrl(outline.xmlUrl);
          if (!safeUrl) throw new Error('Feed URL must use http or https');
          const feedUrl = normalizeFeedUrl(
            validatePublicUrl(safeUrl).href,
          );

          const redditSource = isRedditUrl(feedUrl)
            ? normalizeRedditUrl(feedUrl)
            : null;
          const storedUrl = redditSource?.normalizedUrl || feedUrl;
          const existing = db
            .prepare('SELECT id FROM feeds WHERE url = ?')
            .get(storedUrl);
          if (existing) return false;

          const id = crypto.randomUUID();
          const now = Date.now();
          db.prepare(
            `INSERT INTO feeds (
              id, url, title, site_url, category, source_type, source_metadata,
              custom_title, poll_interval_mins, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          ).run(
            id,
            storedUrl,
            outline.text || '',
            safeHttpUrl(outline.htmlUrl) || '',
            outline.category || '',
            redditSource ? 'reddit' : 'rss',
            redditSource
              ? JSON.stringify({
                  originalUrl: feedUrl,
                  redditKind: redditSource.redditKind,
                  subreddit: redditSource.subreddit,
                  username: redditSource.username,
                  query: redditSource.query,
                })
              : '{}',
            outline.text ? 1 : 0,
            now,
            now,
          );
          enqueueFeedFetch(id, { now });
          return true;
        })();
        if (added) imported++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Error importing ${outline.xmlUrl}: ${message}`);
      }
    }
  });
  importTx();
  if (imported > 0) wakePoller();

  return { imported, errors };
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getExportUrl(feed: Record<string, string>): string {
  if (feed.source_type !== 'reddit' || !feed.source_metadata) return feed.url;
  try {
    const metadata = JSON.parse(feed.source_metadata) as {
      originalUrl?: unknown;
    };
    if (typeof metadata.originalUrl === 'string') return metadata.originalUrl;
  } catch {
    // Fall back to the normalized stored URL when older metadata is malformed.
  }
  return feed.url;
}
