import { marked } from 'marked';

const ALLOWED_TAGS = new Set<string>([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

const VOID_TAGS = new Set<string>(['br', 'col', 'hr', 'img', 'source']);

const NON_TEXT_TAGS = new Set<string>([
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
]);

const GLOBAL_ATTRIBUTES = new Set<string>(['dir', 'lang', 'title']);

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel', 'id', 'aria-label']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  details: new Set(['open']),
  h1: new Set(['id']),
  h2: new Set(['id']),
  h3: new Set(['id']),
  h4: new Set(['id']),
  h5: new Set(['id']),
  h6: new Set(['id']),
  img: new Set([
    'src',
    'srcset',
    'sizes',
    'alt',
    'width',
    'height',
    'loading',
    'decoding',
  ]),
  li: new Set(['value']),
  ol: new Set(['start', 'reversed', 'type']),
  pre: new Set(['tabindex', 'role', 'aria-label']),
  source: new Set(['srcset', 'sizes', 'media', 'type']),
  table: new Set([
    'border',
    'cellpadding',
    'cellspacing',
    'summary',
    'aria-label',
    'aria-describedby',
  ]),
  td: new Set(['id', 'colspan', 'rowspan', 'headers']),
  th: new Set(['id', 'colspan', 'rowspan', 'headers', 'scope', 'abbr']),
};

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2f;': '/',
  '&#47;': '/',
  '&nbsp;': ' ',
  '&colon;': ':',
  '&tab;': '\t',
  '&newline;': '\n',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|colon|tab|newline|#39|#x27|#x2F|#47|#(\d+)|#x([0-9a-fA-F]+));/gi,
    (match, dec, hex) => {
      if (dec !== undefined) {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[match.toLowerCase()] ?? match;
    },
  );
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripControlAndSpace(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 32) {
      out += value[i];
    }
  }
  return out;
}

function isPlaceholderSrc(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = stripControlAndSpace(
    decodeHtmlEntities(value),
  ).toLowerCase();
  return !normalized || /^(?:data:|blob:|about:)/.test(normalized);
}

function hasAllowedScheme(
  url: string,
  allowedSchemes: readonly string[],
): boolean {
  const normalized = stripControlAndSpace(decodeHtmlEntities(url));
  if (!normalized) return false;
  const schemeMatch = normalized.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!schemeMatch) {
    return true;
  }
  return allowedSchemes.includes(schemeMatch[1].toLowerCase());
}

function parseSrcsetCandidates(
  raw: string,
  resolveUrl: (value: string | undefined) => string | undefined,
): string | undefined {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const entries: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let urlToken = tokens[i++];
    if (urlToken === ',') continue;
    let hadTrailingComma = false;
    if (urlToken.endsWith(',')) {
      urlToken = urlToken.slice(0, -1);
      hadTrailingComma = true;
    }
    const resolved = resolveUrl(urlToken);
    let validUrl: string | undefined;
    if (
      resolved &&
      !isPlaceholderSrc(resolved) &&
      hasAllowedScheme(resolved, ['http', 'https'])
    ) {
      try {
        const parsed = new URL(resolved);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          validUrl = parsed.href;
        }
      } catch {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(resolved)) {
          validUrl = resolved;
        }
      }
    }

    let descriptor = '';
    if (!hadTrailingComma && i < tokens.length) {
      const next = tokens[i];
      const commaIdx = next.indexOf(',');
      const candidateDesc = commaIdx === -1 ? next : next.slice(0, commaIdx);
      if (/^\d+(?:\.\d+)?[wx]$/i.test(candidateDesc)) {
        descriptor = candidateDesc;
        if (commaIdx !== -1 && commaIdx < next.length - 1) {
          tokens[i] = next.slice(commaIdx + 1);
        } else {
          i++;
        }
      }
    }
    if (validUrl) {
      entries.push(descriptor ? `${validUrl} ${descriptor}` : validUrl);
    }
  }
  return entries.length ? entries.join(', ') : undefined;
}

function parseTagAttributes(attrSource: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex =
    /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrSource)) !== null) {
    const name = match[1].toLowerCase();
    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeHtmlEntities(rawValue);
  }
  return attrs;
}

function findTagEnd(html: string, startIndex: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = startIndex; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function addImageLinkAriaLabels(sanitizedHtml: string): string {
  return sanitizedHtml.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (fullMatch, rawAttrs: string, innerHtml: string) => {
      if (/\baria-label\s*=/i.test(rawAttrs)) return fullMatch;
      if (!/<img\b/i.test(innerHtml)) return fullMatch;
      const textContent = decodeHtmlEntities(
        innerHtml.replace(/<[^>]*>/g, ' '),
      ).trim();
      if (textContent) return fullMatch;

      const altMatch = innerHtml.match(/<img\b[^>]*?\balt="([^"]*)"/i);
      const altText = altMatch ? decodeHtmlEntities(altMatch[1]).trim() : '';
      const hrefMatch = rawAttrs.match(/\bhref="([^"]*)"/i);
      const hrefText = hrefMatch ? decodeHtmlEntities(hrefMatch[1]).trim() : '';
      const label = altText || hrefText || 'Linked image';
      return `<a${rawAttrs} aria-label="${escapeAttribute(label)}">${innerHtml}</a>`;
    },
  );
}

/**
 * Sanitize content from feeds, AI providers, archives, and Reddit before it
 * reaches a Svelte {@html} sink. Implemented without heavy Node/PostCSS CJS
 * dependencies so client and server chunks stay small and deterministic.
 */
export function sanitizeHtml(
  html: string | null | undefined,
  baseUrl?: string,
): string {
  if (!html) return '';

  const resolveUrl = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('#')) return trimmed;
    if (trimmed.startsWith('//')) {
      if (baseUrl) {
        try {
          return new URL(trimmed, baseUrl).href;
        } catch {
          // Fall back to HTTPS upgrade when baseUrl is invalid.
        }
      }
      try {
        return new URL(`https:${trimmed}`).href;
      } catch {
        return undefined;
      }
    }
    if (!baseUrl) return trimmed;
    try {
      return new URL(trimmed, baseUrl).href;
    } catch {
      return trimmed;
    }
  };

  // Strip comments, declarations, and processing instructions first.
  const stripped = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\?[\s\S]*?(?:\?>|$)/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g, '$1');

  const out: string[] = [];
  const openStack: string[] = [];
  const nonTextStack: string[] = [];
  let i = 0;

  while (i < stripped.length) {
    const lt = stripped.indexOf('<', i);
    if (lt === -1) {
      if (nonTextStack.length === 0) {
        out.push(stripped.slice(i));
      }
      break;
    }

    if (lt > i && nonTextStack.length === 0) {
      out.push(stripped.slice(i, lt));
    }

    const headMatch = stripped
      .slice(lt)
      .match(/^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s/>])/);
    if (!headMatch) {
      if (nonTextStack.length === 0) {
        out.push('&lt;');
      }
      i = lt + 1;
      continue;
    }

    const isClosing = headMatch[1] === '/';
    const tagName = headMatch[2].toLowerCase();
    const attrStart = lt + headMatch[0].length;
    const tagEnd = findTagEnd(stripped, attrStart);

    if (tagEnd === -1) {
      // Unclosed tag at end of input: never emit raw '<'.
      if (
        nonTextStack.length === 0 &&
        !NON_TEXT_TAGS.has(tagName) &&
        ALLOWED_TAGS.has(tagName)
      ) {
        out.push('&lt;');
      }
      break;
    }

    const rawAttrPart = stripped.slice(attrStart, tagEnd);
    const selfClosing = /\/\s*$/.test(rawAttrPart);
    i = tagEnd + 1;

    if (NON_TEXT_TAGS.has(tagName)) {
      if (isClosing) {
        const idx = nonTextStack.lastIndexOf(tagName);
        if (idx !== -1) nonTextStack.length = idx;
      } else if (!selfClosing) {
        nonTextStack.push(tagName);
      }
      continue;
    }

    if (nonTextStack.length > 0) {
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) {
      continue;
    }

    if (isClosing) {
      if (VOID_TAGS.has(tagName)) continue;
      const idx = openStack.lastIndexOf(tagName);
      if (idx !== -1) {
        while (openStack.length > idx) {
          const closed = openStack.pop()!;
          out.push(`</${closed}>`);
        }
      }
      continue;
    }

    const attrs = parseTagAttributes(rawAttrPart.replace(/\/\s*$/, ''));

    if (tagName === 'a') {
      const rawHref = attrs.href?.trim();
      const isFragment = Boolean(rawHref && rawHref.startsWith('#'));
      const resolvedHref = resolveUrl(rawHref);
      if (
        resolvedHref &&
        (isFragment ||
          hasAllowedScheme(resolvedHref, ['http', 'https', 'mailto', 'tel']))
      ) {
        attrs.href = resolvedHref;
      } else {
        delete attrs.href;
      }

      if (isFragment) {
        delete attrs.target;
        delete attrs.rel;
      } else {
        attrs.target = '_blank';
        attrs.rel = 'noopener noreferrer';
      }
    } else if (tagName === 'img') {
      const rawSrc = !isPlaceholderSrc(attrs.src)
        ? attrs.src
        : attrs['data-src'] ||
          attrs['data-lazy-src'] ||
          attrs['data-original'] ||
          attrs.src;
      const resolvedSrc = resolveUrl(rawSrc);
      if (
        resolvedSrc &&
        !isPlaceholderSrc(resolvedSrc) &&
        hasAllowedScheme(resolvedSrc, ['http', 'https'])
      ) {
        attrs.src = resolvedSrc;
      } else {
        delete attrs.src;
      }

      const rawSrcset = attrs.srcset || attrs['data-srcset'];
      const srcset = rawSrcset
        ? parseSrcsetCandidates(rawSrcset, resolveUrl)
        : undefined;
      if (srcset) {
        attrs.srcset = srcset;
      } else {
        delete attrs.srcset;
      }
    } else if (tagName === 'source') {
      const rawSrcset = attrs.srcset || attrs['data-srcset'];
      const srcset = rawSrcset
        ? parseSrcsetCandidates(rawSrcset, resolveUrl)
        : undefined;
      if (srcset) {
        attrs.srcset = srcset;
      } else {
        delete attrs.srcset;
      }
    } else if (tagName === 'pre') {
      attrs.tabindex = attrs.tabindex?.trim() || '0';
    }

    const allowedForTag = ALLOWED_ATTRIBUTES[tagName];
    const serializedAttrs: string[] = [];
    for (const [attrName, attrValue] of Object.entries(attrs)) {
      if (
        !GLOBAL_ATTRIBUTES.has(attrName) &&
        (!allowedForTag || !allowedForTag.has(attrName))
      ) {
        continue;
      }
      serializedAttrs.push(`${attrName}="${escapeAttribute(attrValue)}"`);
    }

    const attrSuffix = serializedAttrs.length
      ? ` ${serializedAttrs.join(' ')}`
      : '';
    if (VOID_TAGS.has(tagName)) {
      out.push(`<${tagName}${attrSuffix} />`);
    } else {
      out.push(`<${tagName}${attrSuffix}>`);
      openStack.push(tagName);
    }
  }

  while (openStack.length > 0) {
    out.push(`</${openStack.pop()!}>`);
  }

  return addImageLinkAriaLabels(out.join(''));
}

const HTML_TAG_PATTERN =
  /<\/?(?:p|div|span|a|ul|ol|li|blockquote|h[1-6]|img|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|details|summary|pre|code|br|hr|picture|source|section|article|header|footer|main|aside)\b/i;

function looksLikeRawHtml(text: string): boolean {
  const withoutCodeSpans = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '')
    .trim();
  if (!withoutCodeSpans) return false;
  return HTML_TAG_PATTERN.test(withoutCodeSpans);
}

/**
 * Formats non-HTML content by:
 * 1. Converting Markdown to HTML
 * 2. Automatically detecting and linkifying URLs (GFM)
 * 3. Ensuring external links open in a new tab while preserving #fragment links
 */
export function formatContent(
  text: string | null | undefined,
  baseUrl?: string,
): string {
  if (!text) return '';

  const renderer = new marked.Renderer();

  renderer.link = ({ href, title, text: linkText }) => {
    const isFragment = Boolean(href?.trim().startsWith('#'));
    const targetRel = isFragment
      ? ''
      : ' target="_blank" rel="noopener noreferrer"';
    return `<a href="${href}"${title ? ` title="${title}"` : ''}${targetRel}>${linkText}</a>`;
  };

  const html = marked.parse(text, {
    renderer,
    gfm: true,
    breaks: true,
    async: false,
  }) as string;

  return sanitizeHtml(html, baseUrl);
}

/**
 * Renders content that may already be HTML or may be markdown/plain text.
 * HTML is preserved only within the strict allowlist above, without decoding
 * escaped entities inside raw HTML documents (so escaped generics, comparisons,
 * and JSX inside <code>/<pre> are never turned into tags and stripped).
 */
export function renderContent(
  text: string | null | undefined,
  baseUrl?: string,
): string {
  if (!text) return '';

  if (looksLikeRawHtml(text)) {
    return sanitizeHtml(text, baseUrl);
  }

  // Support feeds whose entire payload was entity-encoded HTML with zero raw tags
  if (/^\s*&lt;[a-zA-Z]/.test(text)) {
    const decoded = decodeHtmlEntities(text);
    if (looksLikeRawHtml(decoded)) {
      return sanitizeHtml(decoded, baseUrl);
    }
  }

  return formatContent(text, baseUrl);
}
