import { getDb } from './db';
import crypto from 'node:crypto';

export function exportOpml(): string {
  const db = getDb();
  const feeds = db.prepare('SELECT url, title, description, category FROM feeds WHERE enabled = 1').all() as Array<Record<string, string>>;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
<head><title>Feed Me Maybe Export</title></head>
<body>\n`;

  for (const feed of feeds) {
    const cat = feed.category ? ` category="${escapeXml(feed.category)}"` : '';
    xml += `  <outline text="${escapeXml(feed.title || feed.url)}"${cat} type="rss" xmlUrl="${escapeXml(feed.url)}"/>\n`;
  }

  xml += '</body>\n</opml>';
  return xml;
}

export interface OpmlOutline {
  text?: string;
  xmlUrl?: string;
  type?: string;
}

export function parseOpml(xml: string): OpmlOutline[] {
  const outlines: OpmlOutline[] = [];
  const regex = /<outline\s[^>]*\/?>/gi;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const text = match[0].match(/text="([^"]*)"/)?.[1];
    const xmlUrl = match[0].match(/xmlUrl="([^"]*)"/i)?.[1];
    const type = match[0].match(/type="([^"]*)"/i)?.[1];
    if (xmlUrl) outlines.push({ text, xmlUrl, type });
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
      db.prepare('INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), outline.xmlUrl, outline.text || '', now, now);
      imported++;
    } catch {
      errors.push(`Invalid URL: ${outline.xmlUrl}`);
    }
  }

  return { imported, errors };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}