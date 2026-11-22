import { marked } from 'marked';
import sanitizeHtmlLib from 'sanitize-html';

const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'cite',
  'code',
  'del',
  'dd',
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
] as const;

const ALLOWED_ATTRIBUTES = {
  '*': ['dir', 'lang', 'title'],
  a: ['href', 'target', 'rel'],
  img: [
    'src',
    'srcset',
    'sizes',
    'alt',
    'width',
    'height',
    'loading',
    'decoding',
  ],
  source: ['srcset', 'sizes', 'media', 'type'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  table: ['border', 'cellpadding', 'cellspacing'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope'],
};

function isPlaceholderSrc(value: string | undefined): boolean {
  return !value || /^(?:data:|blob:|about:)/i.test(value.trim());
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
    if (resolved) {
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

/**
 * Sanitize content from feeds, AI providers, archives, and Reddit before it
 * reaches a Svelte {@html} sink. Keeping this policy centralized prevents a
 * newly added renderer from accidentally reintroducing executable markup.
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

  return sanitizeHtmlLib(html, {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto', 'tel'],
      img: ['http', 'https'],
    },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'noscript',
      'template',
    ],
    transformTags: {
      a: (tagName, attrs) => {
        const href = resolveUrl(attrs.href);
        return {
          tagName,
          attribs: {
            ...attrs,
            ...(href ? { href } : {}),
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        };
      },
      img: (tagName, attrs) => {
        const rawSrc = !isPlaceholderSrc(attrs.src)
          ? attrs.src
          : attrs['data-src'] ||
            attrs['data-lazy-src'] ||
            attrs['data-original'] ||
            attrs.src;
        const src = resolveUrl(rawSrc);
        const rawSrcset = attrs.srcset || attrs['data-srcset'];
        const srcset = rawSrcset
          ? parseSrcsetCandidates(rawSrcset, resolveUrl)
          : undefined;
        return {
          tagName,
          attribs: {
            ...attrs,
            ...(src ? { src } : {}),
            ...(srcset ? { srcset } : {}),
          },
        };
      },
      source: (tagName, attrs) => {
        const rawSrcset = attrs.srcset || attrs['data-srcset'];
        const srcset = rawSrcset
          ? parseSrcsetCandidates(rawSrcset, resolveUrl)
          : undefined;
        return {
          tagName,
          attribs: {
            ...attrs,
            ...(srcset ? { srcset } : {}),
          },
        };
      },
    },
  });
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

function looksLikeHtml(text: string): boolean {
  const decoded = decodeHtmlEntities(text).trim();
  if (!decoded) return false;

  return /<\/?(?:p|div|span|a|ul|ol|li|blockquote|h[1-6]|img|figure|figcaption|table|thead|tbody|tr|td|th|pre|code|br|hr|section|article|header|footer|main|aside)\b/i.test(
    decoded,
  );
}

/**
 * Formats non-HTML content by:
 * 1. Converting Markdown to HTML
 * 2. Automatically detecting and linkifying URLs (GFM)
 * 3. Ensuring all links (including literal HTML links) open in a new tab
 */
export function formatContent(
  text: string | null | undefined,
  baseUrl?: string,
): string {
  if (!text) return '';

  // Configure marked for this call
  // We use a custom renderer to ensure target="_blank" on markdown links
  const renderer = new marked.Renderer();

  renderer.link = ({ href, title, text }) => {
    return `<a href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
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
 * HTML is preserved only within the strict allowlist above.
 */
export function renderContent(
  text: string | null | undefined,
  baseUrl?: string,
): string {
  if (!text) return '';

  if (looksLikeHtml(text)) {
    return sanitizeHtml(decodeHtmlEntities(text), baseUrl);
  }

  return formatContent(text, baseUrl);
}
