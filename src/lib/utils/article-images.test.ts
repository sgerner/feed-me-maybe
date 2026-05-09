import { describe, expect, it } from 'vitest';
import { extractArticleImages } from './article-images';

describe('extractArticleImages', () => {
  it('collects hero and content images without duplicates', () => {
    const images = extractArticleImages({
      articleUrl: 'https://example.com/post',
      heroUrl: 'https://example.com/hero.jpg',
      content:
        '<p>Text</p><img src="https://example.com/hero.jpg"><img src="https://example.com/second.jpg">',
    });

    expect(images.map((image) => image.src)).toEqual([
      'https://example.com/hero.jpg',
      'https://example.com/second.jpg',
    ]);
  });

  it('extracts markdown and relative image urls', () => {
    const images = extractArticleImages({
      articleUrl: 'https://example.com/articles/123',
      content:
        '![alt](images/one.png) and ![alt](https://cdn.example.com/two.png)',
    });

    expect(images.map((image) => image.src)).toEqual([
      'https://example.com/articles/images/one.png',
      'https://cdn.example.com/two.png',
    ]);
  });

  it('decodes escaped html image urls', () => {
    const images = extractArticleImages({
      articleUrl: 'https://example.com/post',
      content: '&lt;img src="https://example.com/escaped.jpg"&gt;',
    });

    expect(images.map((image) => image.src)).toEqual([
      'https://example.com/escaped.jpg',
    ]);
  });
});
