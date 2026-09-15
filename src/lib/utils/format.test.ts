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

  it('removes executable markup and unsafe URL protocols', () => {
    const html = renderContent(
      '<p onclick="alert(1)">Safe</p><script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><strong>kept</strong>',
    );

    expect(html).toContain('<p>Safe</p>');
    expect(html).toContain('<strong>kept</strong>');
    expect(html).not.toMatch(/script|onclick|onerror|javascript:/i);
  });

  it('sanitizes AI and comment markdown before it reaches an HTML sink', () => {
    const html = formatContent(
      '[bad](javascript:alert(1))\n\n<img src="data:text/html,<script>alert(1)</script>">',
    );

    expect(html).not.toMatch(/javascript:|data:|script/i);
  });
});
