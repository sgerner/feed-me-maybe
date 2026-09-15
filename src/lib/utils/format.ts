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
  'pre',
  'q',
  's',
  'samp',
  'small',
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
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  table: ['border', 'cellpadding', 'cellspacing'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope'],
};

/**
 * Sanitize content from feeds, AI providers, archives, and Reddit before it
 * reaches a Svelte {@html} sink. Keeping this policy centralized prevents a
 * newly added renderer from accidentally reintroducing executable markup.
 */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return '';

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
      a: sanitizeHtmlLib.simpleTransform(
        'a',
        { target: '_blank', rel: 'noopener noreferrer' },
        true,
      ),
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
export function formatContent(text: string | null | undefined): string {
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

  return sanitizeHtml(html);
}

/**
 * Renders content that may already be HTML or may be markdown/plain text.
 * HTML is preserved only within the strict allowlist above.
 */
export function renderContent(text: string | null | undefined): string {
  if (!text) return '';

  if (looksLikeHtml(text)) {
    return sanitizeHtml(decodeHtmlEntities(text));
  }

  return formatContent(text);
}
