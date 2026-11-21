import { describe, expect, it } from 'vitest';
import { normalizeTextArray, parseJsonTextArray } from './normalization';

describe('provider value normalization', () => {
  it('extracts labels from RSS object-shaped values without leaking object strings', () => {
    expect(
      normalizeTextArray([
        { _: 'Politics', $: { domain: 'www.nytimes.com' } },
        { term: 'Technology' },
        { _: 'Politics' },
        { $: { domain: 'missing-label' } },
      ]),
    ).toEqual(['Politics', 'Technology']);
  });

  it('normalizes JSON arrays and drops unusable objects', () => {
    expect(
      parseJsonTextArray(
        '[{"name":"AI"},{"label":"Research"},{"value":"AI"},{"x":"ignored"}]',
      ),
    ).toEqual(['AI', 'Research']);
  });

  it('decodes entity-encoded scripts and tags before stripping markup', async () => {
    const { stripHtml } = await import('./normalization');
    expect(
      stripHtml(
        '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x&gt;Hello &amp;amp; Co.',
      ),
    ).toBe('Hello & Co.');
    expect(stripHtml('&lt;img src="https://example.com/a.png"&gt;')).toBe('');
  });
});
