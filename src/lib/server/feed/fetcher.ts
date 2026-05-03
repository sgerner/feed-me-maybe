import Parser from 'rss-parser';

type FeedParser = Parser<Record<string, unknown>, Record<string, unknown>>;

export interface FetchResult {
  success: boolean;
  title?: string;
  description?: string;
  link?: string;
  imageUrl?: string;
  items: FetchedItem[];
  error?: string;
  httpStatus?: number;
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
}

export interface FetchedItem {
  guid?: string;
  url: string;
  title: string;
  author?: string;
  summary?: string;
  content?: string;
  imageUrl?: string;
  categories: string[];
  publishedAt?: Date;
}

const parser: FeedParser = new Parser({
  timeout: 15000,
  maxRedirects: 5,
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['dc:creator', 'dcCreator'],
    ],
  },
});

export async function fetchFeed(
  url: string,
  options: { etag?: string; lastModified?: string } = {},
): Promise<FetchResult> {
  try {
    // Validate URL
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        success: false,
        items: [],
        error: 'Only http/https URLs are supported',
      };
    }

    const headers: Record<string, string> = {
      'User-Agent': 'FeedMeMaybe/1.0 RSS Reader',
      Accept:
        'application/rss+xml, application/atom+xml, application/xml, text/xml',
    };

    if (options.etag) {
      headers['If-None-Match'] = options.etag;
    }
    if (options.lastModified) {
      headers['If-Modified-Since'] = options.lastModified;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 304) {
      return { success: true, items: [], notModified: true, httpStatus: 304 };
    }

    if (!response.ok) {
      return {
        success: false,
        items: [],
        error: `HTTP error ${response.status}`,
        httpStatus: response.status,
      };
    }

    const xml = await response.text();
    const result = await parser.parseString(xml);

    const newEtag = response.headers.get('etag') || undefined;
    const newLastModified = response.headers.get('last-modified') || undefined;

    const items: FetchedItem[] = (result.items || []).map(
      (item: Record<string, unknown>) => {
        // Extract image from various possible sources
        let imageUrl = '';

        const mediaContent = item.mediaContent as any;
        const mediaThumbnail = item.mediaThumbnail as any;
        const enclosure = item.enclosure as any;

        if (mediaContent?.$?.url) {
          imageUrl = mediaContent.$.url;
        } else if (mediaThumbnail?.$?.url) {
          imageUrl = mediaThumbnail.$.url;
        } else if (enclosure?.url && enclosure?.type?.startsWith('image/')) {
          imageUrl = enclosure.url;
        } else if (typeof mediaContent?.url === 'string') {
          imageUrl = mediaContent.url;
        } else if (typeof mediaThumbnail?.url === 'string') {
          imageUrl = mediaThumbnail.url;
        }

        // Fallback: extract first img src from HTML content
        if (!imageUrl) {
          const fullContent =
            (item['content:encoded'] as string) ||
            (item.content as string) ||
            (item.contentSnippet as string) ||
            '';
          const imgMatch = fullContent.match(/<img[^>]+src=["']([^"']+)["']/i);
          if (imgMatch) {
            imageUrl = imgMatch[1];
            // Handle potential HTML entities in URL
            if (imageUrl.includes('&amp;')) {
              imageUrl = imageUrl.replace(/&amp;/g, '&');
            }
            if (imageUrl.includes('&#038;')) {
              imageUrl = imageUrl.replace(/&#038;/g, '&');
            }
          }
        }

        return {
          guid: String(item.guid || item.link || ''),
          url: String(item.link || ''),
          title: String((item.title as string)?.trim() || 'Untitled'),
          author:
            (item.creator as string) ||
            (item['dc:creator'] as string) ||
            undefined,
          summary:
            (item.contentSnippet as string)?.trim()?.substring(0, 500) ||
            undefined,
          content:
            (item['content:encoded'] as string)?.trim() ||
            (item.content as string)?.trim() ||
            (item.contentSnippet as string)?.trim() ||
            undefined,
          imageUrl: imageUrl || undefined,
          categories: (item.categories as string[]) || [],
          publishedAt: item.pubDate
            ? new Date(item.pubDate as string)
            : item.isoDate
              ? new Date(item.isoDate as string)
              : undefined,
        } as FetchedItem;
      },
    );

    return {
      success: true,
      title: result.title || undefined,
      description: result.description || undefined,
      link: result.link || undefined,
      imageUrl: result.image?.url || undefined,
      items,
      etag: newEtag,
      lastModified: newLastModified,
    };
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : 'Unknown fetch error';
    return {
      success: false,
      items: [],
      error: errorMessage,
    };
  }
}
