import { describe, expect, it } from 'vitest';
import { formatContent, renderContent, sanitizeHtml } from './format';

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

  it('preserves escaped generics, comparisons, and JSX inside raw HTML documents', () => {
    const html = renderContent(
      '<p>When <code>a &lt; b &amp;&amp; c &gt; d</code>, use <code>Array&lt;T&gt;</code>.</p><pre><code>return &lt;Widget items={list} /&gt;;</code></pre>',
    );

    expect(html).toContain('<code>a &lt; b &amp;&amp; c &gt; d</code>');
    expect(html).toContain('<code>Array&lt;T&gt;</code>');
    expect(html).toContain(
      '<pre tabindex="0"><code>return &lt;Widget items={list} /&gt;;</code></pre>',
    );
  });

  it('decodes fully entity-escaped html bodies when no raw tags exist', () => {
    const html = renderContent(
      '&lt;p&gt;&lt;a href="https://example.com"&gt;example&lt;/a&gt;&lt;/p&gt;',
    );

    expect(html).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">example</a></p>',
    );
  });

  it('preserves table structure, header IDs, fragment links, details/summary, focusable pre, and image link aria-labels', () => {
    const html = sanitizeHtml(
      '<table><caption>Quarterly metrics</caption><colgroup><col span="2"></colgroup><thead><tr><th id="col-name" scope="col">Name</th></tr></thead><tbody><tr><td headers="col-name">Alpha</td></tr></tbody></table><details open><summary>More</summary><p><a href="#col-name">Jump to table</a></p></details><a href="https://example.com/chart"><img src="https://example.com/chart.png" alt="Revenue chart"></a><a href="https://example.com/raw"><img src="https://example.com/raw.png"></a>',
    );

    expect(html).toContain('<caption>Quarterly metrics</caption>');
    expect(html).toContain('<colgroup><col span="2" /></colgroup>');
    expect(html).toContain('<th id="col-name" scope="col">Name</th>');
    expect(html).toContain('<td headers="col-name">Alpha</td>');
    expect(html).toContain('<details open=""><summary>More</summary>');
    expect(html).toContain('<a href="#col-name">Jump to table</a>');
    expect(html).not.toContain('href="#col-name" target="_blank"');
    expect(html).toContain('aria-label="Revenue chart"');
    expect(html).toContain('aria-label="https://example.com/raw"');
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

  it('resolves relative links, images, protocol-relative URLs, lazy attributes, and picture/srcset against baseUrl', () => {
    const html = renderContent(
      '<p><a href="post/1">Read</a></p><picture><source data-srcset="/img/hero-400.webp 400w, //cdn.example.com/hero-800.webp 800w" media="(min-width: 600px)" type="image/webp"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="/img/hero.jpg" srcset="javascript:alert(1) 1x, img/small.jpg 400w" sizes="100vw" alt="Hero"></picture><img data-lazy-src="//cdn.example.com/lazy.png">',
      'https://example.com/blog/index.html',
    );

    expect(html).toContain('href="https://example.com/blog/post/1"');
    expect(html).toContain('<picture>');
    expect(html).toContain('<source ');
    expect(html).toContain(
      'srcset="https://example.com/img/hero-400.webp 400w, https://cdn.example.com/hero-800.webp 800w"',
    );
    expect(html).toContain('media="(min-width: 600px)"');
    expect(html).toContain('type="image/webp"');
    expect(html).toContain('src="https://example.com/img/hero.jpg"');
    expect(html).toContain(
      'srcset="https://example.com/blog/img/small.jpg 400w"',
    );
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain('src="https://cdn.example.com/lazy.png"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:image/gif');

    const protoRelativeNoBase = renderContent(
      '<img src="//cdn.example.com/pic.jpg">',
    );
    expect(protoRelativeNoBase).toContain(
      'src="https://cdn.example.com/pic.jpg"',
    );

    const md = formatContent('[Post](post/2)', 'https://example.com/blog/');
    expect(md).toContain('href="https://example.com/blog/post/2"');
  });
});
