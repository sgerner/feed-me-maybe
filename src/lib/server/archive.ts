import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const ARCHIVE_MIRRORS = [
  'https://archive.is',
  'https://archive.today',
  'https://archive.ph',
  'https://archive.vn',
  'https://archive.md',
  'https://archive.fo',
  'https://archive.li',
  'https://archive.wf',
] as const;

const ARCHIVE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type ArchivedArticle = {
  archiveUrl: string;
  title: string;
  content: string;
  imageUrl?: string;
};

function buildHeaders(): HeadersInit {
  return {
    'User-Agent': ARCHIVE_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Ch-Ua':
      '"Not_A Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

async function fetchPage(url: string, timeoutMs = 15000): Promise<{ url: string; html: string } | null> {
  try {
    const response = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return null;
    }
    const html = await response.text();
    return { url: response.url, html };
  } catch (err) {
    return null;
  }
}

function isCloudflareChallenge(html: string): boolean {
  // Actual archive snapshots have <html style="background-color:#EEEEEE">
  // Challenge pages have plain <html> with challenge text
  const hasSnapshotStyle = /<html\b[^>]*style="[^"]*background-color\s*:\s*#EEEEEE[^"]*"/i.test(html);
  if (hasSnapshotStyle) {
    return false;
  }

  const lower = html.toLowerCase();
  const challengeIndicators = [
    'one more step',
    'security check',
    'please complete',
    'cf-browser-verification',
    'challenge-form',
    'turnstile',
    'checking your browser',
    'cf-challenge-running',
    'cf-im-under-attack',
    '__cf_chl_jschl_tk__',
    'cdn-cgi/challenge-platform',
    'cf-turnstile',
    'just a moment',
    'ddos protection',
    'ray id',
    'cloudflare',
    'verify you are a human',
    "i'm not a robot",
    'recaptcha',
  ];

  for (const indicator of challengeIndicators) {
    if (lower.includes(indicator)) {
      return true;
    }
  }

  return false;
}

function isArchiveSnapshotPage(html: string): boolean {
  return /<html\b[^>]*style="[^"]*background-color\s*:\s*#EEEEEE[^"]*"/i.test(html);
}

function isArchiveSearchPage(html: string): boolean {
  // Search results pages have the yellow/beige background
  return /<html\b[^>]*style="[^"]*background-color\s*:\s*#FFFAE1[^"]*"/i.test(html);
}

function extractSnapshotIdsFromSearchPage(html: string, baseHost: string): string[] {
  const ids = new Set<string>();
  const regex = /href=(['"])([^'"]+)\1/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const href = match[2].trim();
    if (!href) continue;

    try {
      const resolved = new URL(href, baseHost).toString();
      const parsed = new URL(resolved);
      const host = parsed.origin;
      const path = parsed.pathname.replace(/^\//, '');

      // Skip non-archive hosts and non-snapshot paths
      if (!ARCHIVE_MIRRORS.some((m) => m === host)) continue;
      if (!path || path.includes('/') || path.length < 4) continue;
      if (path === 'search' || path === 'loading' || path.startsWith('http')) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(path)) continue;

      ids.add(`${host}/${path}`);
    } catch {
      // Ignore malformed URLs
    }
  }

  return [...ids];
}

function extractMetaContent(html: string, property: string): string | undefined {
  const metaRegex = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const propertyMatch = tag.match(
      new RegExp(`(?:property|name)=(['"])${property}\\1`, 'i'),
    );
    if (!propertyMatch) continue;

    const contentMatch = tag.match(/content=(['"])(.*?)\1/i);
    if (contentMatch?.[2]) return contentMatch[2].trim();
  }

  return undefined;
}

function extractImageFromHtml(html: string): string | undefined {
  return extractMetaContent(html, 'og:image');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function extractTitleFromHtml(html: string, fallback: string): string {
  const ogTitle = extractMetaContent(html, 'og:title');
  if (ogTitle) return decodeHtmlEntities(ogTitle);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return decodeHtmlEntities(stripTags(titleMatch[1])).trim();

  return fallback;
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/<(?:nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, '')
    .replace(/\son[a-z]+=(["']).*?\1/gi, '');
}

function absolutizeUrls(html: string, baseUrl: string): string {
  const attrRegex = /\b(href|src|poster)=("([^"]*)"|'([^']*)')/gi;
  return html.replace(attrRegex, (_match, attrName, _value, doubleQuoted, singleQuoted) => {
    const raw = (doubleQuoted || singleQuoted || '').trim();
    if (
      !raw ||
      raw.startsWith('#') ||
      raw.startsWith('mailto:') ||
      raw.startsWith('tel:') ||
      raw.startsWith('data:') ||
      raw.startsWith('javascript:')
    ) {
      return `${attrName}="${raw}"`;
    }

    try {
      const resolved = new URL(raw, baseUrl).toString();
      return `${attrName}="${resolved}"`;
    } catch {
      return `${attrName}="${raw}"`;
    }
  });
}

function extractCandidateHtml(html: string): string {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;

  const patterns = [
    /<article\b[^>]*>[\s\S]*?<\/article>/gi,
    /<main\b[^>]*>[\s\S]*?<\/main>/gi,
  ];

  let best = '';
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      if (match[0].length > best.length) {
        best = match[0];
      }
    }
  }

  return sanitizeHtml(best || body);
}

function normalizeContent(html: string, baseUrl: string): string {
  return absolutizeUrls(sanitizeHtml(html), baseUrl);
}

function extractWithReadability(html: string, pageUrl: string): { title: string; content: string } | null {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();
    if (!article || !article.content) return null;
    return {
      title: article.title || '',
      content: normalizeContent(article.content, pageUrl),
    };
  } catch {
    return null;
  }
}

function extractWithFallback(html: string, pageUrl: string, fallbackTitle: string): { title: string; content: string; imageUrl?: string } | null {
  const title = extractTitleFromHtml(html, fallbackTitle);
  const imageUrl = extractImageFromHtml(html);
  const extractedHtml = extractCandidateHtml(html);
  const content = normalizeContent(extractedHtml, pageUrl);
  if (!content.trim()) return null;
  return { title, content, imageUrl };
}

function isGarbageContent(content: string): boolean {
  const text = content.toLowerCase();
  const garbageIndicators = [
    'google search',
    'google webcache',
    'was not found on this server',
    '404 not found',
    'page not found',
    'cache miss',
  ];
  for (const indicator of garbageIndicators) {
    if (text.includes(indicator)) {
      return true;
    }
  }
  return false;
}

async function extractFromSnapshotPage(
  html: string,
  pageUrl: string,
  fallbackTitle: string,
): Promise<ArchivedArticle | null> {
  const title = extractTitleFromHtml(html, fallbackTitle);
  const imageUrl = extractImageFromHtml(html);

  // Try Readability first for clean extraction
  const readability = extractWithReadability(html, pageUrl);
  if (readability?.content && !isGarbageContent(readability.content)) {
    return {
      archiveUrl: pageUrl,
      title: readability.title || title,
      content: readability.content,
      imageUrl: imageUrl || extractImageFromHtml(html),
    };
  }

  // Fallback to regex extraction
  const fallback = extractWithFallback(html, pageUrl, fallbackTitle);
  if (fallback && !isGarbageContent(fallback.content)) {
    return {
      archiveUrl: pageUrl,
      title: fallback.title,
      content: fallback.content,
      imageUrl: fallback.imageUrl,
    };
  }

  return null;
}

async function tryArchiveMirror(
  mirror: string,
  originalUrl: string,
  fallbackTitle: string,
): Promise<ArchivedArticle | null> {
  const searchUrl = `${mirror}/${originalUrl}`;
  const searchPage = await fetchPage(searchUrl, 20000);
  if (!searchPage) {
    return null;
  }


  // If it's a direct snapshot page, extract content immediately
  if (isArchiveSnapshotPage(searchPage.html)) {
    const result = await extractFromSnapshotPage(searchPage.html, searchPage.url, fallbackTitle);
    if (result) {
      return result;
    }
    return null;
  }

  // If it's a challenge page, skip this mirror
  if (isCloudflareChallenge(searchPage.html)) {
    return null;
  }

  // If it's a search results page, parse snapshot IDs and try each
  if (isArchiveSearchPage(searchPage.html) || searchPage.html.includes('archive.')) {
    const snapshotUrls = extractSnapshotIdsFromSearchPage(searchPage.html, mirror);

    for (const snapshotUrl of snapshotUrls.slice(0, 5)) {
      const snapshotPage = await fetchPage(snapshotUrl, 15000);
      if (!snapshotPage) {
        continue;
      }

      if (isArchiveSnapshotPage(snapshotPage.html)) {
        const result = await extractFromSnapshotPage(snapshotPage.html, snapshotPage.url, fallbackTitle);
        if (result) {
          return result;
        }
      }

      // Skip challenge pages
      if (isCloudflareChallenge(snapshotPage.html)) {
        continue;
      }
    }
  }

  return null;
}

async function tryJinaAi(originalUrl: string, fallbackTitle: string): Promise<ArchivedArticle | null> {
  try {
    const jinaUrl = `https://r.jina.ai/http://${originalUrl.replace(/^https?:\/\//, '')}`;
    const response = await fetch(jinaUrl, {
      headers: {
        'User-Agent': ARCHIVE_USER_AGENT,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.trim()) return null;

    // Parse jina.ai markdown format
    const titleMatch = text.match(/^Title:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;

    // Extract markdown content after "Markdown Content:"
    const contentMatch = text.match(/Markdown Content:\s*\n?([\s\S]+)$/i);
    let content = '';
    if (contentMatch) {
      content = contentMatch[1].trim();
    } else {
      // Fallback: use everything after the metadata
      content = text.replace(/^Title:.*$/gm, '').replace(/^URL Source:.*$/gm, '').replace(/^Published Time:.*$/gm, '').replace(/^Warning:.*$/gm, '').replace(/^Markdown Content:.*$/gm, '').trim();
    }

    if (!content) {
      return null;
    }

    // Convert markdown-like content to HTML (basic)
    const htmlContent = content
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>')
      .replace(/\n/g, '<br>');

    return {
      archiveUrl: jinaUrl,
      title,
      content: htmlContent,
    };
  } catch (err) {
    return null;
  }
}

export async function fetchArchivedArticle(
  originalUrl: string,
  fallbackTitle: string,
): Promise<ArchivedArticle | null> {

  // 1. Try archive mirrors in rotation
  for (const mirror of ARCHIVE_MIRRORS) {
    const result = await tryArchiveMirror(mirror, originalUrl, fallbackTitle);
    if (result) {
      return result;
    }
  }


  // 2. Fallback: jina.ai content extraction (often bypasses paywalls)
  const jinaResult = await tryJinaAi(originalUrl, fallbackTitle);
  if (jinaResult) {
    return jinaResult;
  }


  // 3. Last resort: fetch original directly with Readability
  const originalPage = await fetchPage(originalUrl, 15000);
  if (originalPage) {
    const readability = extractWithReadability(originalPage.html, originalPage.url);
    if (readability?.content && !isGarbageContent(readability.content)) {
      return {
        archiveUrl: originalPage.url,
        title: readability.title || fallbackTitle,
        content: readability.content,
        imageUrl: extractImageFromHtml(originalPage.html),
      };
    }
    const fallback = extractWithFallback(originalPage.html, originalPage.url, fallbackTitle);
    if (fallback && !isGarbageContent(fallback.content)) {
      return {
        archiveUrl: originalPage.url,
        title: fallback.title,
        content: fallback.content,
        imageUrl: fallback.imageUrl,
      };
    }
  }

  return null;
}
