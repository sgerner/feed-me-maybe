const ARCHIVE_HOSTS = [
  'https://archive.is',
  'https://archive.ph',
  'https://archive.today',
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

async function fetchArchivePage(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const response = await fetch(url, { headers: buildHeaders() });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;
    return {
      url: response.url,
      html: await response.text(),
    };
  } catch {
    return null;
  }
}

function isSnapshotUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!ARCHIVE_HOSTS.some((host) => parsed.origin === host)) return false;
    return /^\/[A-Za-z0-9_-]{4,}$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function extractSnapshotLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const regex = /href=(['"])([^'"]+)\1/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const href = match[2].trim();
    if (!href) continue;
    if (href.startsWith('#') || href.startsWith('javascript:')) continue;

    try {
      const resolved = new URL(href, baseUrl).toString();
      const parsed = new URL(resolved);
      if (
        ARCHIVE_HOSTS.some((host) => parsed.origin === host) &&
        /^\/[A-Za-z0-9_-]{4,}$/.test(parsed.pathname)
      ) {
        links.add(resolved);
      }
    } catch {
      // Ignore malformed URLs from archive chrome.
    }
  }

  return [...links];
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

function extractTitle(html: string, fallback: string): string {
  const ogTitle = extractMetaContent(html, 'og:title');
  if (ogTitle) return decodeHtmlEntities(ogTitle);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return decodeHtmlEntities(stripTags(titleMatch[1])).trim();

  return fallback;
}

function extractImage(html: string): string | undefined {
  const ogImage = extractMetaContent(html, 'og:image');
  return ogImage ? ogImage : undefined;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

async function resolveArchiveSnapshot(originalUrl: string): Promise<string | null> {
  const attempted = new Set<string>();

  for (const host of ARCHIVE_HOSTS) {
    const candidateUrl = `${host}/${originalUrl}`;
    const candidate = await fetchArchivePage(candidateUrl);
    if (!candidate) continue;

    if (isSnapshotUrl(candidate.url)) {
      return candidate.url;
    }

    for (const snapshotUrl of extractSnapshotLinks(candidate.html, candidate.url)) {
      if (attempted.has(snapshotUrl)) continue;
      attempted.add(snapshotUrl);
      return snapshotUrl;
    }
  }

  return null;
}

export async function fetchArchivedArticle(
  originalUrl: string,
  fallbackTitle: string,
): Promise<ArchivedArticle | null> {
  const directCandidate = await resolveArchiveSnapshot(originalUrl);
  const snapshotUrl = directCandidate || originalUrl;
  const page = await fetchArchivePage(snapshotUrl);
  if (!page) return null;

  const title = extractTitle(page.html, fallbackTitle);
  const imageUrl = extractImage(page.html);
  const extractedHtml = extractCandidateHtml(page.html);
  const content = normalizeContent(extractedHtml, page.url);

  if (!content.trim()) return null;

  return {
    archiveUrl: page.url,
    title,
    content,
    imageUrl,
  };
}
