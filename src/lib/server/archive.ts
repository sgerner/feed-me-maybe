import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import {
  formatContent,
  sanitizeHtml as sanitizeContent,
} from '../utils/format';
import {
  MAX_HTML_RESPONSE_BYTES,
  assertPublicNetworkUrl,
  fetchSafe,
  readResponseText,
} from './network';

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

async function fetchPage(
  url: string,
  timeoutMs = 15000,
  proxyBaseUrl?: string,
  deadline?: AbortSignal,
): Promise<{ url: string; html: string } | null> {
  try {
    const { response, finalUrl } = await fetchSafe(
      url,
      {
        headers: buildHeaders(),
        signal: deadline
          ? AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
      {
        proxyBaseUrl,
        maxBytes: MAX_HTML_RESPONSE_BYTES,
        allowedContentTypes: ['text/html', 'application/xhtml+xml'],
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const html = await readResponseText(response, MAX_HTML_RESPONSE_BYTES);
    return { url: finalUrl, html };
  } catch {
    return null;
  }
}

export function isCloudflareChallenge(html: string): boolean {
  // Actual archive snapshots have <html style="background-color:#EEEEEE">
  // Challenge pages have plain <html> with challenge text
  const hasSnapshotStyle =
    /<html\b[^>]*style="[^"]*background-color\s*:\s*#EEEEEE[^"]*"/i.test(html);
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
    'attention required',
    'enable javascript and cookies to continue',
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

export function isJinaErrorPayload(text: string): boolean {
  if (isCloudflareChallenge(text)) return true;
  if (
    /^Warning:\s*(?:Target URL returned error\b|.*\b(?:401|403|404|429|5\d\d|captcha|cloudflare|challenge|blocked|access denied|forbidden)\b)/im.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

function isArchiveSnapshotPage(html: string): boolean {
  return /<html\b[^>]*style="[^"]*background-color\s*:\s*#EEEEEE[^"]*"/i.test(
    html,
  );
}

function isArchiveSearchPage(html: string): boolean {
  // Search results pages have the yellow/beige background
  return /<html\b[^>]*style="[^"]*background-color\s*:\s*#FFFAE1[^"]*"/i.test(
    html,
  );
}

function extractSnapshotIdsFromSearchPage(
  html: string,
  baseHost: string,
): string[] {
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
      if (path === 'search' || path === 'loading' || path.startsWith('http'))
        continue;
      if (!/^[A-Za-z0-9_-]+$/.test(path)) continue;

      ids.add(`${host}/${path}`);
    } catch {
      // Ignore malformed URLs
    }
  }

  return [...ids];
}

function extractMetaContent(
  html: string,
  property: string,
): string | undefined {
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

function extractImageFromHtml(
  html: string,
  pageUrl: string,
): string | undefined {
  const image = extractMetaContent(html, 'og:image');
  if (!image) return undefined;
  try {
    const parsed = new URL(image, pageUrl);
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/gi,
    (match) => entities[match.toLowerCase()] ?? match,
  );
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function extractTitleFromHtml(html: string, fallback: string): string {
  const ogTitle = extractMetaContent(html, 'og:title');
  if (ogTitle) return decodeHtmlEntities(ogTitle);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1])
    return decodeHtmlEntities(stripTags(titleMatch[1])).trim();

  return fallback;
}

function absolutizeUrls(html: string, baseUrl: string): string {
  const attrRegex = /\b(href|src|poster)=("([^"]*)"|'([^']*)')/gi;
  return html.replace(
    attrRegex,
    (_match, attrName, _value, doubleQuoted, singleQuoted) => {
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
    },
  );
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

  return best || body;
}

const MAX_CSS_SELECTOR_LENGTH = 500;

export type CssSelectorValidationResult =
  { valid: true; normalized: string } | { valid: false; error: string };

function splitTopLevelCommas(
  input: string,
): { parts: string[] } | { error: string } {
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let bracketDepth = 0;
  let parenDepth = 0;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']') {
      bracketDepth--;
      if (bracketDepth < 0) {
        return { error: 'Unbalanced square brackets in CSS selector' };
      }
      continue;
    }
    if (bracketDepth > 0) {
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      if (parenDepth < 0) {
        return { error: 'Unbalanced parentheses in CSS selector' };
      }
      continue;
    }
    if (ch === ',' && parenDepth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }

  if (quote) {
    return { error: 'Unclosed string literal in CSS selector' };
  }
  if (bracketDepth !== 0) {
    return { error: 'Unbalanced square brackets in CSS selector' };
  }
  if (parenDepth !== 0) {
    return { error: 'Unbalanced parentheses in CSS selector' };
  }

  parts.push(input.slice(start));
  return { parts };
}

function consumeCssIdentifier(
  input: string,
  start: number,
  allowColon = false,
): { nextIndex: number } | null {
  if (start >= input.length) return null;

  let i = start;
  if (input[i] === '\\') {
    if (i + 1 >= input.length) return null;
    i += 2;
  } else if (input[i] === '-') {
    if (i + 1 >= input.length) return null;
    const next = input[i + 1];
    if (next === '\\') {
      if (i + 2 >= input.length) return null;
      i += 3;
    } else if (/[A-Za-z_-]/.test(next)) {
      i += 2;
    } else {
      return null;
    }
  } else if (/[A-Za-z_]/.test(input[i])) {
    i++;
  } else {
    return null;
  }

  const bodyCharPattern = allowColon ? /[A-Za-z0-9_:-]/ : /[A-Za-z0-9_-]/;
  while (i < input.length) {
    if (input[i] === '\\') {
      if (i + 1 >= input.length) return null;
      i += 2;
    } else if (bodyCharPattern.test(input[i])) {
      i++;
    } else {
      break;
    }
  }

  return { nextIndex: i };
}

function findMatchingBracket(input: string, openIndex: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = openIndex + 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ']') {
      return i;
    }
  }
  return -1;
}

function findMatchingParen(input: string, openIndex: number): number {
  let quote: '"' | "'" | null = null;
  let bracketDepth = 0;
  let parenDepth = 1;
  for (let i = openIndex + 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
      continue;
    }
    if (bracketDepth > 0) {
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) return i;
    }
  }
  return -1;
}

function validateAttributeSelector(inner: string): string | null {
  const trimmed = inner.trim();
  if (!trimmed) return 'Empty attribute selector';

  const attrIdent = consumeCssIdentifier(trimmed, 0, true);
  if (!attrIdent) return 'Invalid attribute name in CSS selector';

  let i = attrIdent.nextIndex;
  while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
  if (i === trimmed.length) return null;

  const opMatch = trimmed.slice(i).match(/^([~|^$*]?=)/);
  if (!opMatch) return 'Invalid attribute operator in CSS selector';
  i += opMatch[1].length;

  while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
  if (i >= trimmed.length) return 'Missing attribute value in CSS selector';

  if (trimmed[i] === '"' || trimmed[i] === "'") {
    const quote = trimmed[i];
    i++;
    let closed = false;
    while (i < trimmed.length) {
      if (trimmed[i] === '\\') {
        i += 2;
        continue;
      }
      if (trimmed[i] === quote) {
        closed = true;
        i++;
        break;
      }
      i++;
    }
    if (!closed) return 'Unclosed attribute value quote in CSS selector';
  } else {
    const valueStart = i;
    while (i < trimmed.length) {
      if (trimmed[i] === '\\') {
        if (i + 1 >= trimmed.length) {
          return 'Invalid escape in attribute selector';
        }
        i += 2;
        continue;
      }
      if (/[\s"'`=\]<>]/.test(trimmed[i])) break;
      i++;
    }
    if (i === valueStart) return 'Invalid attribute value in CSS selector';
  }

  const remainder = trimmed.slice(i).trim();
  if (remainder && !/^[iIsS]$/.test(remainder)) {
    return 'Unexpected token in attribute selector';
  }
  return null;
}

function validateSelectorList(
  input: string,
  allowLeadingCombinator: boolean,
): string | null {
  const split = splitTopLevelCommas(input);
  if ('error' in split) return split.error;

  for (const rawPart of split.parts) {
    const part = rawPart.trim();
    if (!part) return 'Empty selector in CSS selector list';

    let i = 0;
    let expectingOperand = true;
    let sawToken = false;

    while (i < part.length) {
      const ch = part[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      if (ch === '>' || ch === '+' || ch === '~') {
        if (expectingOperand) {
          if (allowLeadingCombinator && !sawToken) {
            sawToken = true;
            expectingOperand = true;
            i++;
            continue;
          }
          return 'Unexpected combinator in CSS selector';
        }
        expectingOperand = true;
        i++;
        continue;
      }

      const atCompoundStart = i === 0 || /[\s>+~]/.test(part[i - 1]);

      if (ch === '*') {
        if (!atCompoundStart) return 'Unexpected universal selector';
        expectingOperand = false;
        sawToken = true;
        i++;
        continue;
      }

      if (ch === '.' || ch === '#') {
        const ident = consumeCssIdentifier(part, i + 1);
        if (!ident) {
          return ch === '.' ? 'Invalid class selector' : 'Invalid ID selector';
        }
        i = ident.nextIndex;
        expectingOperand = false;
        sawToken = true;
        continue;
      }

      if (ch === '[') {
        const closeBracket = findMatchingBracket(part, i);
        if (closeBracket === -1) {
          return 'Unbalanced square brackets in CSS selector';
        }
        const attrError = validateAttributeSelector(
          part.slice(i + 1, closeBracket),
        );
        if (attrError) return attrError;
        i = closeBracket + 1;
        expectingOperand = false;
        sawToken = true;
        continue;
      }

      if (ch === ':') {
        let j = i + 1;
        if (part[j] === ':') j++;
        const pseudoIdent = consumeCssIdentifier(part, j);
        if (!pseudoIdent) return 'Invalid pseudo-selector in CSS selector';
        const pseudoName = part.slice(j, pseudoIdent.nextIndex).toLowerCase();
        j = pseudoIdent.nextIndex;
        if (part[j] === '(') {
          const closeParen = findMatchingParen(part, j);
          if (closeParen === -1) {
            return 'Unbalanced parentheses in CSS selector';
          }
          const arg = part.slice(j + 1, closeParen).trim();
          if (!arg) return 'Empty pseudo-selector argument in CSS selector';
          if (
            pseudoName === 'is' ||
            pseudoName === 'where' ||
            pseudoName === 'not' ||
            pseudoName === 'matches'
          ) {
            const innerErr = validateSelectorList(arg, false);
            if (innerErr) return innerErr;
          } else if (pseudoName === 'has') {
            const innerErr = validateSelectorList(arg, true);
            if (innerErr) return innerErr;
          }
          j = closeParen + 1;
        }
        i = j;
        expectingOperand = false;
        sawToken = true;
        continue;
      }

      const typeIdent = consumeCssIdentifier(part, i);
      if (!typeIdent || !atCompoundStart) {
        return 'Invalid token in CSS selector';
      }
      i = typeIdent.nextIndex;
      expectingOperand = false;
      sawToken = true;
    }

    if (expectingOperand || !sawToken) {
      return 'Incomplete CSS selector';
    }
  }

  return null;
}

export function validateCssSelector(
  selector: string,
): CssSelectorValidationResult {
  const normalized = selector.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return { valid: true, normalized: '' };
  }
  if (normalized.length > MAX_CSS_SELECTOR_LENGTH) {
    return {
      valid: false,
      error: `CSS selector must be ${MAX_CSS_SELECTOR_LENGTH} characters or fewer`,
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    return {
      valid: false,
      error: 'CSS selector contains invalid control characters',
    };
  }

  const syntaxError = validateSelectorList(normalized, false);
  if (syntaxError) {
    return { valid: false, error: syntaxError };
  }

  try {
    const { document } = parseHTML(
      '<div><article><p class="probe">ok</p></article></div>',
    );
    document.querySelectorAll(normalized);
  } catch {
    return { valid: false, error: 'Invalid CSS selector syntax' };
  }

  return { valid: true, normalized };
}

function normalizeContent(html: string, baseUrl: string): string {
  return sanitizeContent(absolutizeUrls(html, baseUrl), baseUrl);
}

export function extractWithCssSelector(
  html: string,
  pageUrl: string,
  cssSelector: string,
): { title: string; content: string } | null {
  const validation = validateCssSelector(cssSelector);
  if (!validation.valid || !validation.normalized) {
    return null;
  }

  try {
    const { document } = parseHTML(html);
    const matches = Array.from(
      document.querySelectorAll(validation.normalized),
    );
    if (matches.length === 0) {
      return null;
    }

    const topLevelMatches = matches.filter(
      (candidate, index) =>
        !matches.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            typeof other.contains === 'function' &&
            other.contains(candidate),
        ),
    );

    const combinedHtml = topLevelMatches
      .map((element) => element.outerHTML || element.innerHTML || '')
      .filter(Boolean)
      .join('\n');
    if (!combinedHtml.trim()) {
      return null;
    }

    const content = normalizeContent(combinedHtml, pageUrl);
    if (
      !content.trim() ||
      isCloudflareChallenge(content) ||
      isGarbageContent(content)
    ) {
      return null;
    }

    return {
      title: extractTitleFromHtml(html, ''),
      content,
    };
  } catch {
    return null;
  }
}

function extractWithReadability(
  html: string,
  pageUrl: string,
): { title: string; content: string } | null {
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

export async function fetchPublisherArticle(
  url: string,
  proxyBaseUrl?: string,
  cssSelector?: string | null,
) {
  const page = await fetchPage(url, 12000, proxyBaseUrl);
  if (!page || isCloudflareChallenge(page.html)) return null;
  const trimmedSelector = cssSelector?.trim() || '';
  const selectorParsed = trimmedSelector
    ? extractWithCssSelector(page.html, page.url, trimmedSelector)
    : null;
  const parsed = selectorParsed ?? extractWithReadability(page.html, page.url);
  if (
    !parsed ||
    isCloudflareChallenge(parsed.content) ||
    isGarbageContent(parsed.content)
  ) {
    return null;
  }
  return { ...parsed, imageUrl: extractImageFromHtml(page.html, page.url) };
}

function extractWithFallback(
  html: string,
  pageUrl: string,
  fallbackTitle: string,
): { title: string; content: string; imageUrl?: string } | null {
  const title = extractTitleFromHtml(html, fallbackTitle);
  const imageUrl = extractImageFromHtml(html, pageUrl);
  const extractedHtml = extractCandidateHtml(html);
  const content = normalizeContent(extractedHtml, pageUrl);
  if (!content.trim()) return null;
  return { title, content, imageUrl };
}

export function isGarbageContent(content: string): boolean {
  if (isCloudflareChallenge(content)) return true;
  const text = content
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return true;
  const garbageIndicators = [
    'google search',
    'google webcache',
    'was not found on this server',
    '404 not found',
    'page not found',
    'cache miss',
    'access denied',
    '403 forbidden',
    'enable javascript and cookies to continue',
    'please enable cookies',
    'target url returned error',
    'warning: target url returned error',
  ];
  for (const indicator of garbageIndicators) {
    if (
      text === indicator ||
      (text.length < 600 &&
        (text.startsWith(indicator + ' ') || text.includes(indicator)))
    ) {
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
  if (isCloudflareChallenge(html)) return null;
  const title = extractTitleFromHtml(html, fallbackTitle);
  const imageUrl = extractImageFromHtml(html, pageUrl);

  // Try Readability first for clean extraction
  const readability = extractWithReadability(html, pageUrl);
  if (readability?.content && !isGarbageContent(readability.content)) {
    return {
      archiveUrl: pageUrl,
      title: readability.title || title,
      content: readability.content,
      imageUrl,
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
  deadline: AbortSignal,
): Promise<ArchivedArticle | null> {
  const searchUrl = `${mirror}/${originalUrl}`;
  const searchPage = await fetchPage(searchUrl, 4_000, undefined, deadline);
  if (!searchPage) {
    return null;
  }

  // If it's a direct snapshot page, extract content immediately
  if (isArchiveSnapshotPage(searchPage.html)) {
    const result = await extractFromSnapshotPage(
      searchPage.html,
      searchPage.url,
      fallbackTitle,
    );
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
  if (
    isArchiveSearchPage(searchPage.html) ||
    searchPage.html.includes('archive.')
  ) {
    const snapshotUrls = extractSnapshotIdsFromSearchPage(
      searchPage.html,
      mirror,
    );

    for (const snapshotUrl of snapshotUrls.slice(0, 5)) {
      if (deadline.aborted) break;
      const snapshotPage = await fetchPage(
        snapshotUrl,
        4_000,
        undefined,
        deadline,
      );
      if (!snapshotPage) {
        continue;
      }

      if (isArchiveSnapshotPage(snapshotPage.html)) {
        const result = await extractFromSnapshotPage(
          snapshotPage.html,
          snapshotPage.url,
          fallbackTitle,
        );
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

async function tryJinaAi(
  originalUrl: string,
  fallbackTitle: string,
  deadline: AbortSignal,
): Promise<ArchivedArticle | null> {
  try {
    const normalizedOriginal = /^https?:\/\//i.test(originalUrl)
      ? originalUrl
      : `https://${originalUrl}`;
    const jinaUrl = `https://r.jina.ai/${normalizedOriginal}`;
    const { response } = await fetchSafe(
      jinaUrl,
      {
        headers: {
          'User-Agent': ARCHIVE_USER_AGENT,
        },
        signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]),
      },
      {
        maxBytes: MAX_HTML_RESPONSE_BYTES,
        allowedContentTypes: ['text/plain', 'text/markdown', 'text/html'],
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const text = await readResponseText(response, MAX_HTML_RESPONSE_BYTES);
    if (!text.trim() || isJinaErrorPayload(text)) return null;

    // Parse jina.ai markdown format
    const titleMatch = text.match(/^Title:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;
    if (
      /^(?:just a moment|attention required|access denied|security check|403 forbidden|404 not found)/i.test(
        title,
      )
    ) {
      return null;
    }

    // Extract markdown content after "Markdown Content:"
    const contentMatch = text.match(/Markdown Content:\s*\n?([\s\S]+)$/i);
    let content = '';
    if (contentMatch) {
      content = contentMatch[1].trim();
    } else {
      // Fallback: use everything after the metadata
      content = text
        .replace(/^Title:.*$/gm, '')
        .replace(/^URL Source:.*$/gm, '')
        .replace(/^Published Time:.*$/gm, '')
        .replace(/^Warning:.*$/gm, '')
        .replace(/^Markdown Content:.*$/gm, '')
        .trim();
    }

    if (!content || isJinaErrorPayload(content)) {
      return null;
    }

    // Convert markdown-like content to HTML
    const htmlContent = formatContent(content, normalizedOriginal);
    if (isGarbageContent(htmlContent)) {
      return null;
    }

    return {
      archiveUrl: jinaUrl,
      title,
      content: htmlContent,
    };
  } catch {
    return null;
  }
}

export async function fetchArchivedArticle(
  originalUrl: string,
  fallbackTitle: string,
  proxyBaseUrl?: string,
): Promise<ArchivedArticle | null> {
  try {
    // Validate before sending the URL to an archive mirror or extraction
    // service, and again before fetching the original after redirects.
    await assertPublicNetworkUrl(originalUrl);
  } catch {
    return null;
  }

  const archiveDeadline = AbortSignal.timeout(12_000);

  // Limit the combined mirror and extractor time so the publisher still gets a turn.
  for (const mirror of ARCHIVE_MIRRORS) {
    if (archiveDeadline.aborted) break;
    const result = await tryArchiveMirror(
      mirror,
      originalUrl,
      fallbackTitle,
      archiveDeadline,
    );
    if (result) {
      return result;
    }
  }

  // 2. Fallback: jina.ai content extraction (often bypasses paywalls)
  const jinaResult = archiveDeadline.aborted
    ? null
    : await tryJinaAi(originalUrl, fallbackTitle, archiveDeadline);
  if (jinaResult) {
    return jinaResult;
  }

  // 3. Last resort: fetch original directly with Readability
  const originalPage = await fetchPage(originalUrl, 8_000, proxyBaseUrl);
  if (originalPage && !isCloudflareChallenge(originalPage.html)) {
    const readability = extractWithReadability(
      originalPage.html,
      originalPage.url,
    );
    if (readability?.content && !isGarbageContent(readability.content)) {
      return {
        archiveUrl: originalPage.url,
        title: readability.title || fallbackTitle,
        content: readability.content,
        imageUrl: extractImageFromHtml(originalPage.html, originalPage.url),
      };
    }
    const fallback = extractWithFallback(
      originalPage.html,
      originalPage.url,
      fallbackTitle,
    );
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
