import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  extractArticleHeadings,
  formatContent,
  normalizeFragmentHref,
  normalizeUserContentId,
  renderContent,
  sanitizeHtml,
  shouldToggleReaderOutline,
} from './format';

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

  it('preserves table structure, prefixed header IDs, fragment links, details/summary, focusable pre, and image link aria-labels', () => {
    const html = sanitizeHtml(
      '<table><caption>Quarterly metrics</caption><colgroup><col span="2"></colgroup><thead><tr><th id="col-name" scope="col">Name</th></tr></thead><tbody><tr><td headers="col-name">Alpha</td></tr></tbody></table><details open><summary>More</summary><p><a href="#col-name">Jump to table</a></p></details><a href="https://example.com/chart"><img src="https://example.com/chart.png" alt="Revenue chart"></a><a href="https://example.com/raw"><img src="https://example.com/raw.png"></a>',
    );

    expect(html).toContain('<caption>Quarterly metrics</caption>');
    expect(html).toContain('<colgroup><col span="2" /></colgroup>');
    expect(html).toContain(
      '<th id="user-content-col-name" scope="col">Name</th>',
    );
    expect(html).toContain('<td headers="user-content-col-name">Alpha</td>');
    expect(html).toContain('<details open=""><summary>More</summary>');
    expect(html).toContain(
      '<a href="#user-content-col-name">Jump to table</a>',
    );
    expect(html).not.toContain('href="#user-content-col-name" target="_blank"');
    expect(html).toContain('aria-label="Revenue chart"');
    expect(html).toContain('aria-label="https://example.com/raw"');
  });

  it('prefixes safe footnote IDs idempotently across elements and rewrites #fragment links without target="_blank"', () => {
    const rawFootnoteHtml =
      '<p>Claim<sup id="fnref:1"><a href="#fn:1">[1]</a></sup></p><ol><li id="fn:1">Source note <a href="#fnref%3A1">↩</a></li></ol>';
    const once = sanitizeHtml(rawFootnoteHtml, 'https://example.com/post');
    const twice = renderContent(once, 'https://example.com/post');

    expect(once).toContain('<sup id="user-content-fnref:1">');
    expect(once).toContain('<a href="#user-content-fn:1">[1]</a>');
    expect(once).toContain('<li id="user-content-fn:1">');
    expect(once).toContain('<a href="#user-content-fnref:1">↩</a>');
    expect(once).not.toContain('target="_blank"');
    expect(twice).toBe(once);

    expect(normalizeUserContentId('user-content-fn-1')).toBe(
      'user-content-fn-1',
    );
    expect(normalizeUserContentId('USER-CONTENT-user-content-fn-1')).toBe(
      'user-content-fn-1',
    );
    expect(normalizeFragmentHref('#user-content-fn-1')).toBe(
      '#user-content-fn-1',
    );

    const md = formatContent('Jump to [note](#fn-2) or [ext](mailto:a@b.co).');
    expect(md).toContain('<a href="#user-content-fn-2">note</a>');
    expect(md).not.toContain('href="#user-content-fn-2" target="_blank"');
    expect(md).toContain(
      '<a href="mailto:a@b.co" target="_blank" rel="noopener noreferrer">ext</a>',
    );
  });

  it('guards against DOM clobbering of main-content, app-sidebar, and window properties and drops invalid IDs', () => {
    const html = sanitizeHtml(
      '<div id="main-content">a</div><p id="app-sidebar">b</p><a id="location" href="https://example.com">c</a><span id="document">d</span><p id="bad space">e</p><p id="user-content-">f</p><p id="../escape">g</p><a href="#">empty</a><a href="#bad space">broken</a>',
    );

    expect(html).not.toContain('id="main-content"');
    expect(html).not.toContain('id="app-sidebar"');
    expect(html).not.toContain('id="location"');
    expect(html).not.toContain('id="document"');
    expect(html).toContain('<div id="user-content-main-content">a</div>');
    expect(html).toContain('<p id="user-content-app-sidebar">b</p>');
    expect(html).toContain(
      '<a id="user-content-location" href="https://example.com" target="_blank" rel="noopener noreferrer">c</a>',
    );
    expect(html).toContain('<span id="user-content-document">d</span>');
    expect(html).toContain('<p>e</p>');
    expect(html).toContain('<p>f</p>');
    expect(html).toContain('<p>g</p>');
    expect(html).toContain('<a>empty</a>');
    expect(html).toContain('<a>broken</a>');
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

describe('reader prose styles, heading outline extraction, and [ shortcut guards', () => {
  it('styles .prose-glass tables, resets pre code pills, and offsets [id] scroll targets in app.css', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');

    expect(css).toMatch(
      /\.prose-glass table\s*\{[^}]*border-collapse:\s*collapse/s,
    );
    expect(css).toMatch(/\.prose-glass table\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(
      /\.prose-glass th,\s*\.prose-glass td\s*\{[^}]*padding:\s*0\.625rem 0\.875rem/s,
    );
    expect(css).toMatch(/\.prose-glass th\s*\{[^}]*font-weight:\s*600/s);
    expect(css).toMatch(
      /\.prose-glass pre code\s*\{[^}]*background:\s*transparent[^}]*padding:\s*0[^}]*border-radius:\s*0[^}]*font-size:\s*inherit/s,
    );
    expect(css).toMatch(/\.prose-glass \[id\]\s*\{[^}]*scroll-margin-top:/s);
  });

  it('extracts h1-h4 headings, assigns missing user-content- IDs, and deduplicates repeated slugs', () => {
    const { document } = parseHTML(
      '<div id="article"><h2>Overview</h2><h3>   </h3><h3 id="user-content-architecture">Architecture</h3><h2>Overview</h2><h4>Deep Dive!</h4><h5>Ignored h5</h5><p id="user-content-deep-dive-2">Existing anchor</p><h4>Deep Dive!</h4></div>',
    );
    const container = document.getElementById('article');
    const headings = extractArticleHeadings(container);

    expect(headings).toEqual([
      { id: 'user-content-overview', text: 'Overview', level: 2 },
      { id: 'user-content-architecture', text: 'Architecture', level: 3 },
      { id: 'user-content-overview-2', text: 'Overview', level: 2 },
      { id: 'user-content-deep-dive', text: 'Deep Dive!', level: 4 },
      { id: 'user-content-deep-dive-3', text: 'Deep Dive!', level: 4 },
    ]);

    // Re-running against the same DOM stays idempotent.
    expect(extractArticleHeadings(container)).toEqual(headings);
  });

  it('enforces single-key, mode, heading count, modal, and input guards on the [ outline shortcut', () => {
    const { document } = parseHTML(
      '<div><p id="prose">Text</p><input id="field" /><div role="dialog"><button id="dialog-btn">Close</button></div></div>',
    );
    const proseEl = document.getElementById('prose')!;
    const inputEl = document.getElementById('field')!;
    const dialogBtn = document.getElementById('dialog-btn')!;

    const baseEvent = {
      key: '[',
      defaultPrevented: false,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: proseEl as unknown as EventTarget,
    };
    const baseContext = {
      singleKeyShortcutsEnabled: true,
      lightboxOpen: false,
      isReaderMode: true,
      headingCount: 3,
      hasOpenModal: false,
    };

    expect(shouldToggleReaderOutline(baseEvent, baseContext)).toBe(true);
    expect(
      shouldToggleReaderOutline(baseEvent, { ...baseContext, headingCount: 1 }),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline(baseEvent, {
        ...baseContext,
        isReaderMode: false,
      }),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline(baseEvent, {
        ...baseContext,
        lightboxOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline(baseEvent, {
        ...baseContext,
        singleKeyShortcutsEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline(baseEvent, {
        ...baseContext,
        hasOpenModal: true,
      }),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline({ ...baseEvent, ctrlKey: true }, baseContext),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline({ ...baseEvent, repeat: true }, baseContext),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline(
        { ...baseEvent, target: inputEl as unknown as EventTarget },
        baseContext,
      ),
    ).toBe(false);
    expect(
      shouldToggleReaderOutline(
        { ...baseEvent, target: dialogBtn as unknown as EventTarget },
        baseContext,
      ),
    ).toBe(false);
  });
});
