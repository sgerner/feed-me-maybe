import { getDb } from './db';
import crypto from 'node:crypto';

export function exportOpml(): string {
  const db = getDb();
  const feeds = db.prepare('SELECT url, title, site_url, description, category FROM feeds WHERE enabled = 1').all() as Array<Record<string, string>>;

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
      const htmlUrl = feed.site_url ? ` htmlUrl="${escapeXml(feed.site_url)}"` : '';
      xml += `    <outline text="${escapeXml(feed.title || feed.url)}" type="rss" xmlUrl="${escapeXml(feed.url)}"${htmlUrl}/>\n`;
    }
    xml += `  </outline>\n`;
  }

  // Export uncategorized feeds
  for (const feed of uncategorized) {
    const htmlUrl = feed.site_url ? ` htmlUrl="${escapeXml(feed.site_url)}"` : '';
    xml += `  <outline text="${escapeXml(feed.title || feed.url)}" type="rss" xmlUrl="${escapeXml(feed.url)}"${htmlUrl}/>\n`;
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
  
  // Basic robust attribute extractor
  function getAttr(tag: string, attr: string): string | undefined {
    const regex = new RegExp(`${attr}=(['"])(.*?)\\1`, 'i');
    return tag.match(regex)?.[2];
  }

  // Find all outline tags
  const outlineRegex = /<outline\s+([^>]+?)(?:>([\s\S]*?)<\/outline>|\/>|>)/gi;
  let match;

  while ((match = outlineRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const content = match[2];
    
    const xmlUrl = getAttr(attrs, 'xmlUrl');
    const htmlUrl = getAttr(attrs, 'htmlUrl');
    const text = getAttr(attrs, 'text') || getAttr(attrs, 'title');
    const type = getAttr(attrs, 'type');
    const category = getAttr(attrs, 'category');

    if (xmlUrl) {
      outlines.push({ text, xmlUrl, htmlUrl, type, category });
    } else if (content) {
      // It's a container outline (likely a category)
      const parentText = text;
      const subOutlines = parseOpml(content);
      for (const sub of subOutlines) {
        if (!sub.category && parentText) {
          sub.category = parentText;
        }
        outlines.push(sub);
      }
    }
  }

  return outlines;
}

export function importOpml(xml: string): { imported: number; errors: string[] } {
  const db = getDb();
  const outlines = parseOpml(xml);
  let imported = 0;
  const errors: string[] = [];

  for (const outline of outlines) {
    if (!outline.xmlUrl) continue;
    try {
      new URL(outline.xmlUrl);
      const existing = db.prepare('SELECT id FROM feeds WHERE url = ?').get(outline.xmlUrl);
      if (existing) continue;

      const now = Date.now();
      db.prepare('INSERT INTO feeds (id, url, title, site_url, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), outline.xmlUrl, outline.text || '', outline.htmlUrl || '', outline.category || '', now, now);
      imported++;
    } catch (err: any) {
      errors.push(`Error importing ${outline.xmlUrl}: ${err.message}`);
    }
  }

  return { imported, errors };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}