import { DOMParser } from 'linkedom';
import { getDb } from './db';
import { isRedditUrl, normalizeRedditUrl } from './sources/reddit';
import { enqueueFeedFetch } from './feed/job-queue';
import {
  normalizeFeedUrl,
  parseRedditSourceMetadata,
  serializeRedditSourceMetadata,
} from './feed-management';
import { isArticleOpenMode } from '#lib/constants/article-open-modes.ts';
import { validatePublicUrl } from './network';
import { wakePoller } from './poller';
import crypto from 'node:crypto';

type OpmlExportFeedRow = {
  url: string;
  title: string | null;
  site_url: string | null;
  description: string | null;
  category: string | null;
  source_type: string | null;
  source_metadata: string | null;
  enabled: number | null;
  use_proxy: number | null;
  open_mode: string | null;
  poll_interval_mins: number | null;
  custom_title: number | null;
};

function renderOutlineAttributes(feed: OpmlExportFeedRow): string {
  const xmlUrl = getExportUrl(feed);
  const attrs: string[] = [
    `text="${escapeXml(feed.title || xmlUrl)}"`,
    'type="rss"',
    `xmlUrl="${escapeXml(xmlUrl)}"`,
  ];
  if (feed.site_url) {
    attrs.push(`htmlUrl="${escapeXml(feed.site_url)}"`);
  }
  if (feed.enabled !== undefined && feed.enabled !== null) {
    attrs.push(`fmmEnabled="${Number(feed.enabled) ? 'true' : 'false'}"`);
  }
  if (feed.use_proxy !== undefined && feed.use_proxy !== null) {
    attrs.push(`fmmUseProxy="${Number(feed.use_proxy) ? 'true' : 'false'}"`);
  }
  if (feed.open_mode && isArticleOpenMode(feed.open_mode)) {
    attrs.push(`fmmOpenMode="${escapeXml(feed.open_mode)}"`);
  }
  if (
    feed.poll_interval_mins !== undefined &&
    feed.poll_interval_mins !== null
  ) {
    attrs.push(`fmmPollIntervalMins="${Number(feed.poll_interval_mins)}"`);
  }
  if (feed.custom_title !== undefined && feed.custom_title !== null) {
    attrs.push(
      `fmmCustomTitle="${Number(feed.custom_title) ? 'true' : 'false'}"`,
    );
  }
  return attrs.join(' ');
}

export function exportOpml(): string {
  const db = getDb();
  const feeds = db
    .prepare(
      `SELECT url, title, site_url, description, category, source_type,
              source_metadata, enabled, use_proxy, open_mode,
              poll_interval_mins, custom_title
       FROM feeds
       ORDER BY category COLLATE NOCASE, title COLLATE NOCASE`,
    )
    .all() as OpmlExportFeedRow[];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
<head><title>Feed Me Maybe Export</title></head>
<body>\n`;

  const categorized: Record<string, OpmlExportFeedRow[]> = {};
  const uncategorized: OpmlExportFeedRow[] = [];

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
      xml += `    <outline ${renderOutlineAttributes(feed)}/>\n`;
    }
    xml += `  </outline>\n`;
  }

  // Export uncategorized feeds
  for (const feed of uncategorized) {
    xml += `  <outline ${renderOutlineAttributes(feed)}/>\n`;
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
  fmmUseProxy?: string;
  fmmOpenMode?: string;
  fmmEnabled?: string;
  fmmPollIntervalMins?: string;
  fmmCustomTitle?: string;
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
        const fmmUseProxy = getAttr(child, 'fmmUseProxy');
        const fmmOpenMode = getAttr(child, 'fmmOpenMode');
        const fmmEnabled = getAttr(child, 'fmmEnabled');
        const fmmPollIntervalMins = getAttr(child, 'fmmPollIntervalMins');
        const fmmCustomTitle = getAttr(child, 'fmmCustomTitle');
        outlines.push({
          text,
          xmlUrl,
          htmlUrl: getAttr(child, 'htmlUrl'),
          type: getAttr(child, 'type'),
          category,
          ...(fmmUseProxy !== undefined ? { fmmUseProxy } : {}),
          ...(fmmOpenMode !== undefined ? { fmmOpenMode } : {}),
          ...(fmmEnabled !== undefined ? { fmmEnabled } : {}),
          ...(fmmPollIntervalMins !== undefined ? { fmmPollIntervalMins } : {}),
          ...(fmmCustomTitle !== undefined ? { fmmCustomTitle } : {}),
        });
      }

      visit(child, text || inheritedCategory);
    }
  }

  visit(document as unknown as Element);

  return outlines;
}

function parseOpmlBoolean(
  value: string | undefined,
  defaultValue: boolean,
): number {
  if (value === undefined) return defaultValue ? 1 : 0;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return 1;
  if (normalized === 'false' || normalized === '0') return 0;
  return defaultValue ? 1 : 0;
}

function parseOpmlPollInterval(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) return null;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) return null;
  return parsed;
}

export function importOpml(xml: string): {
  imported: number;
  errors: string[];
} {
  const db = getDb();
  const outlines = parseOpml(xml);
  let imported = 0;
  let importedEnabled = 0;
  const errors: string[] = [];
  const importTx = db.transaction(() => {
    for (const outline of outlines) {
      if (!outline.xmlUrl) continue;
      try {
        const added = db.transaction(() => {
          const safeUrl = safeHttpUrl(outline.xmlUrl);
          if (!safeUrl) throw new Error('Feed URL must use http or https');
          const feedUrl = normalizeFeedUrl(validatePublicUrl(safeUrl).href);

          const redditSource = isRedditUrl(feedUrl)
            ? normalizeRedditUrl(feedUrl)
            : null;
          const storedUrl = redditSource?.normalizedUrl || feedUrl;
          const existing = db
            .prepare('SELECT id FROM feeds WHERE url = ?')
            .get(storedUrl);
          if (existing) return { added: false, enabled: 0 };

          const id = crypto.randomUUID();
          const now = Date.now();
          const enabled = parseOpmlBoolean(outline.fmmEnabled, true);
          const useProxy = parseOpmlBoolean(outline.fmmUseProxy, false);
          const customTitle =
            parseOpmlBoolean(outline.fmmCustomTitle, false) &&
            Boolean(outline.text?.trim())
              ? 1
              : 0;
          const openMode =
            outline.fmmOpenMode && isArticleOpenMode(outline.fmmOpenMode)
              ? outline.fmmOpenMode
              : null;
          const pollIntervalMins = parseOpmlPollInterval(
            outline.fmmPollIntervalMins,
          );

          db.prepare(
            `INSERT INTO feeds (
              id, url, title, site_url, category, source_type, source_metadata,
              enabled, use_proxy, open_mode, custom_title, poll_interval_mins,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            storedUrl,
            outline.text || '',
            safeHttpUrl(outline.htmlUrl) || '',
            outline.category || '',
            redditSource ? 'reddit' : 'rss',
            redditSource
              ? serializeRedditSourceMetadata(redditSource, feedUrl)
              : '{}',
            enabled,
            useProxy,
            openMode,
            customTitle,
            pollIntervalMins,
            now,
            now,
          );
          if (enabled) {
            enqueueFeedFetch(id, { now });
          }
          return { added: true, enabled };
        })();
        if (added.added) {
          imported++;
          if (added.enabled) importedEnabled++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Error importing ${outline.xmlUrl}: ${message}`);
      }
    }
  });
  importTx();
  if (importedEnabled > 0) wakePoller();

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

function getExportUrl(
  feed: Pick<OpmlExportFeedRow, 'url' | 'source_type' | 'source_metadata'>,
): string {
  if (feed.source_type !== 'reddit' || !feed.source_metadata) return feed.url;
  return (
    parseRedditSourceMetadata(feed.source_metadata).originalUrl || feed.url
  );
}
