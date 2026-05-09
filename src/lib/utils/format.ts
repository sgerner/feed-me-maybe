import { marked } from 'marked';

function normalizeLinksInHtml(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    let newAttrs = attrs.trim();
    if (!newAttrs.includes('target=')) {
      newAttrs += ' target="_blank"';
    }
    if (!newAttrs.includes('rel=')) {
      newAttrs += ' rel="noopener noreferrer"';
    }
    return `<a ${newAttrs}>`;
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

  let html = marked.parse(text, {
    renderer,
    gfm: true,
    breaks: true,
    async: false,
  }) as string;

  return normalizeLinksInHtml(html);
}

/**
 * Renders content that may already be HTML or may be markdown/plain text.
 * HTML is preserved and only link targets are normalized.
 */
export function renderContent(text: string | null | undefined): string {
  if (!text) return '';

  if (looksLikeHtml(text)) {
    return normalizeLinksInHtml(decodeHtmlEntities(text));
  }

  return formatContent(text);
}
