import { describe, expect, it } from 'vitest';
import {
  decodeRedditCommentEntities,
  parseRedditCommentsResponse,
} from './reddit-comments';
import { formatContent } from './utils/format';

describe('reddit-comments', () => {
  it('decodes HTML entities in comment bodies so blockquotes and inline code render without double-escaping', () => {
    const payload = [
      { kind: 'Listing', data: { children: [] } },
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't1',
              data: {
                id: 'c1',
                author: 'alice',
                body: '&gt; Quoted line\n\nUse `Array&lt;T&gt;` &amp; &quot;enjoy&quot; &#39;now&#39;.',
                score: 42,
                created_utc: 1700000000,
                replies: '',
              },
            },
          ],
        },
      },
    ];

    const comments = parseRedditCommentsResponse(payload);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(
      '> Quoted line\n\nUse `Array<T>` & "enjoy" \'now\'.',
    );

    const rendered = formatContent(comments[0]?.body);
    expect(rendered).toContain('<blockquote>');
    expect(rendered).toContain('<code>Array&lt;T&gt;</code>');
    expect(rendered).not.toContain('&amp;lt;');
  });

  it('decodes entities in a single pass without double-unescaping &amp;lt;', () => {
    expect(decodeRedditCommentEntities('&amp;lt;tag&amp;gt;')).toBe(
      '&lt;tag&gt;',
    );
  });
});
