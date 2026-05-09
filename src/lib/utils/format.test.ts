import { describe, expect, it } from 'vitest';
import { formatContent, renderContent } from './format';

describe('formatContent', () => {
  it('renders markdown formatting and links', () => {
    const html = formatContent('**bold** [link](https://example.com)');

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>',
    );
  });

  it('preserves literal HTML while normalizing links', () => {
    const html = renderContent(
      '<p><a href="https://example.com">example</a></p>',
    );

    expect(html).toContain('<p><a href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('decodes escaped html bodies before rendering', () => {
    const html = renderContent(
      '&lt;p&gt;<a href="https://example.com">example</a>&lt;/p&gt;',
    );

    expect(html).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">example</a></p>',
    );
  });
});
