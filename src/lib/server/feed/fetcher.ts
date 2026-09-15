import Parser from 'rss-parser';
import { sanitizeHtml } from '$lib/utils/format';
import {
  MAX_FEED_RESPONSE_BYTES,
  fetchSafe,
  readResponseText,
} from '$lib/server/network';
import { coerceText, normalizeTextArray } from '$lib/server/normalization';

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
  externalUrl?: string;
  categories: string[];
  publishedAt?: Date;
}

const parser: FeedParser = new Parser({
  timeout: 15000,
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['dc:creator', 'dcCreator'],
    ],
  },
});

function safeHttpUrl(value: unknown, baseUrl: string): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim(), baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export async function fetchFeed(
  url: string,
  options: { etag?: string; lastModified?: string; proxyBaseUrl?: string } = {},
): Promise<FetchResult> {
  try {
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

    const { response, finalUrl } = await fetchSafe(
      parsedUrl.href,
      {
        headers,
        signal: AbortSignal.timeout(15000),
      },
      {
        proxyBaseUrl: options.proxyBaseUrl,
        maxBytes: MAX_FEED_RESPONSE_BYTES,
        allowedContentTypes: [
          'application/atom+xml',
          'application/rss+xml',
          'application/xml',
          'text/xml',
          'text/rss',
          'text/atom',
        ],
      },
    );

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

    const xml = await readResponseText(response, MAX_FEED_RESPONSE_BYTES);
    const result = await parser.parseString(xml);

    const newEtag = response.headers.get('etag') || undefined;
    const newLastModified = response.headers.get('last-modified') || undefined;

    const items: FetchedItem[] = (result.items || [])
      .map((item: Record<string, unknown>) => {
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

        const safeUrl = safeHttpUrl(item.link, finalUrl);
        if (!safeUrl) return null;
        const safeImageUrl = safeHttpUrl(imageUrl, finalUrl);

        return {
          guid: coerceText(item.guid || item.link),
          url: safeUrl,
          title: coerceText(item.title) || 'Untitled',
          author:
            coerceText(item.creator) ||
            coerceText(item['dc:creator']) ||
            undefined,
          summary:
            sanitizeHtml(
              (item.contentSnippet as string)?.trim()?.substring(0, 500),
            ) || undefined,
          content:
            sanitizeHtml(
              (item['content:encoded'] as string)?.trim() ||
                (item.content as string)?.trim() ||
                (item.contentSnippet as string)?.trim(),
            ) || undefined,
          imageUrl: safeImageUrl || undefined,
          categories: normalizeTextArray(item.categories),
          publishedAt: item.pubDate
            ? new Date(item.pubDate as string)
            : item.isoDate
              ? new Date(item.isoDate as string)
              : undefined,
        } as FetchedItem;
      })
      .filter((item): item is FetchedItem => Boolean(item));

    return {
      success: true,
      title: result.title || undefined,
      description: result.description || undefined,
      link: safeHttpUrl(result.link, finalUrl) || undefined,
      imageUrl: safeHttpUrl(result.image?.url, finalUrl) || undefined,
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
