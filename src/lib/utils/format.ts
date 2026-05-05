import { marked } from 'marked';

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
    async: false
  }) as string;

  // Final pass to ensure target="_blank" and rel="noopener noreferrer" on all links
  // This handles literal HTML links that might have been in the original text
  // or naked URLs that were linkified but didn't go through the renderer
  html = html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    let newAttrs = attrs.trim();
    if (!newAttrs.includes('target=')) {
      newAttrs += ' target="_blank"';
    }
    if (!newAttrs.includes('rel=')) {
      newAttrs += ' rel="noopener noreferrer"';
    }
    return `<a ${newAttrs}>`;
  });

  return html;
}
