import { DOMParser } from 'linkedom';
import Parser from 'rss-parser';
import { sanitizeHtml } from '$lib/utils/format';
import {
  MAX_FEED_RESPONSE_BYTES,
  fetchSafe,
  readResponseText,
} from '$lib/server/network';
import {
  coerceText,
  normalizeTextArray,
  stripHtml,
} from '$lib/server/normalization';

type FeedParser = Parser<Record<string, unknown>, Record<string, unknown>>;

export interface FetchResult {
  success: boolean;
  subscriptionUrl?: string;
  title?: string;
  description?: string;
  link?: string;
  imageUrl?: string;
  items: FetchedItem[];
  error?: string;
  httpStatus?: number;
  retryAt?: number;
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
      ['dc:date', 'dcDate'],
    ],
  },
});

const RSS_TIMEZONE_OFFSETS: Record<string, string> = {
  BST: '+0100',
  CET: '+0100',
  CEST: '+0200',
  EET: '+0200',
  EEST: '+0300',
  JST: '+0900',
  KST: '+0900',
};

function parsePublicationDate(...candidates: unknown[]): Date | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const value = candidate
      .trim()
      .replace(/\s([A-Z]{3,4})$/i, (full, zone: string) =>
        RSS_TIMEZONE_OFFSETS[zone.toUpperCase()]
          ? ' ' + RSS_TIMEZONE_OFFSETS[zone.toUpperCase()]
          : full,
      );
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
}

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

export function readRetryAt(value: string | null): number | undefined {
  if (!value) return undefined;
  const time = /^\d+$/.test(value)
    ? Date.now() + Number(value) * 1000
    : Date.parse(value);
  return Number.isSafeInteger(time) ? time : undefined;
}

function decodeFeed(bytes: Buffer, contentType: string): string {
  const first = bytes.subarray(0, 384);
  let encoding: string | undefined;
  if (
    (first[0] === 0xff && first[1] === 0xfe) ||
    (first[0] === 0x3c && first[1] === 0)
  ) {
    encoding = 'utf-16le';
  } else if (
    (first[0] === 0xfe && first[1] === 0xff) ||
    (first[0] === 0 && first[1] === 0x3c)
  ) {
    encoding = 'utf-16be';
  } else if (first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf) {
    encoding = 'utf-8';
  }
  encoding ??= /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  encoding ??= /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i.exec(
    first.toString('ascii'),
  )?.[1];
  try {
    return new TextDecoder(encoding || 'utf-8').decode(bytes);
  } catch {
    // Unknown charset labels are common in hand-written feeds.
    return bytes.toString('utf8');
  }
}

function parseAtom(xml: string, baseUrl: string) {
  const root = new DOMParser().parseFromString(xml, 'text/xml')
    .documentElement as unknown as Element | null;
  if (root?.localName.split(':').at(-1) !== 'feed') return null;
  const children = (node: Element, name: string) =>
    Array.from(node.children).filter(
      (child) => child.localName.split(':').at(-1) === name,
    );
  const text = (node: Element, name: string) =>
    children(node, name)[0]?.textContent?.trim();
  const atomText = (node: Element, name: string) => {
    const element = children(node, name)[0];
    if (!element) return undefined;
    const type = element.getAttribute('type');
    if (type === 'xhtml') return element.innerHTML;
    const content = element.textContent?.trim() || '';
    return type === 'html'
      ? content
      : content
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
  };
  const link = (node: Element) => {
    for (const element of children(node, 'link')) {
      const relation = element.getAttribute('rel');
      if (relation && relation !== 'alternate') continue;
      let resolvedBase = baseUrl;
      const chain = [];
      for (
        let ancestor: Element | null = element;
        ancestor;
        ancestor = ancestor.parentElement
      )
        chain.unshift(ancestor);
      for (const ancestor of chain) {
        const declared = ancestor.getAttribute('xml:base');
        if (declared)
          resolvedBase = safeHttpUrl(declared, resolvedBase) || resolvedBase;
      }
      const href = safeHttpUrl(element.getAttribute('href'), resolvedBase);
      if (href) return href;
    }
    return '';
  };
  return {
    title: text(root, 'title'),
    description: text(root, 'subtitle'),
    link: link(root),
    image: { url: text(root, 'logo') || text(root, 'icon') },
    items: children(root, 'entry').map((entry): Record<string, unknown> => {
      const authors = [
        ...children(entry, 'author'),
        ...children(root, 'author'),
      ];
      return {
        id: text(entry, 'id'),
        title: text(entry, 'title'),
        link: link(entry),
        author: authors.map((author) => text(author, 'name')).find(Boolean),
        summary: atomText(entry, 'summary'),
        content: atomText(entry, 'content'),
        categories: children(entry, 'category').map((category) =>
          category.getAttribute('term'),
        ),
        pubDate: [text(entry, 'published'), text(entry, 'updated')].find(
          (value) => value && Number.isFinite(Date.parse(value)),
        ),
      };
    }),
  };
}

function parseJsonFeed(source: string) {
  const feed = JSON.parse(source) as Record<string, unknown>;
  if (
    !feed ||
    typeof feed.version !== 'string' ||
    !/^https:\/\/jsonfeed\.org\/version\/1(?:\.1)?$/.test(feed.version) ||
    !Array.isArray(feed.items)
  )
    throw new Error('The URL did not return a valid JSON Feed');

  const htmlText = (value: unknown) =>
    coerceText(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return {
    title: coerceText(feed.title),
    description: coerceText(feed.description),
    link: coerceText(feed.home_page_url),
    image: { url: coerceText(feed.icon) },
    items: feed.items.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      const author = (
        Array.isArray(item.authors) ? item.authors[0] : item.author
      ) as { name?: unknown } | undefined;
      const date = [item.date_published, item.date_modified].find(
        (value) =>
          typeof value === 'string' && Number.isFinite(Date.parse(value)),
      );
      return [
        {
          guid: item.id,
          link: item.url || item.external_url,
          externalUrl: item.external_url,
          title: item.title,
          author: author?.name,
          summary: htmlText(item.summary),
          content: coerceText(item.content_html) || htmlText(item.content_text),
          mediaContent: { url: item.image || item.banner_image },
          categories: item.tags,
          pubDate: date,
        },
      ];
    }),
  };
}

export async function fetchFeed(
  url: string,
  options: {
    etag?: string;
    lastModified?: string;
    proxyBaseUrl?: string;
    discover?: boolean;
    deadline?: AbortSignal;
  } = {},
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

    const deadline = options.deadline ?? AbortSignal.timeout(15000);
    const headers: Record<string, string> = {
      'User-Agent': 'FeedMeMaybe/1.0 RSS Reader',
      Accept:
        'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml' +
        (options.discover
          ? ', text/html;q=0.8, application/xhtml+xml;q=0.8'
          : ''),
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
        signal: deadline,
      },
      {
        proxyBaseUrl: options.proxyBaseUrl,
        maxBytes: MAX_FEED_RESPONSE_BYTES,
        allowedContentTypes: [
          'application/atom+xml',
          'application/rss+xml',
          'application/feed+json',
          'application/json',
          'application/xml',
          'text/xml',
          'text/rss',
          'text/atom',
          'application/rdf+xml',
          'application/octet-stream',
          'text/plain',
          ...(options.discover ? ['text/html', 'application/xhtml+xml'] : []),
        ],
      },
    );

    if (response.status === 304) {
      return { success: true, items: [], notModified: true, httpStatus: 304 };
    }

    if (!response.ok) {
      await response.body?.cancel();
      return {
        success: false,
        items: [],
        error: `HTTP error ${response.status}`,
        httpStatus: response.status,
        retryAt: readRetryAt(response.headers.get('retry-after')),
      };
    }

    const xml = await readResponseText(
      response,
      MAX_FEED_RESPONSE_BYTES,
      (bytes) => decodeFeed(bytes, response.headers.get('content-type') || ''),
    );
    if (
      options.discover &&
      (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
        response.headers.get('content-type') || '',
      ) ||
        /^\s*(?:<!doctype html|<html[\s>])/i.test(xml))
    ) {
      const document = new DOMParser().parseFromString(
        xml,
        'text/html',
      ) as unknown as Document;
      const base =
        safeHttpUrl(
          document.querySelector('head base[href]')?.getAttribute('href'),
          finalUrl,
        ) || finalUrl;
      const candidates = new Set<string>();
      for (const link of document.querySelectorAll('link')) {
        const attrs = Object.fromEntries(
          Array.from(link.attributes, ({ name, value }) => [
            name.toLowerCase(),
            value,
          ]),
        );
        const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
        const type = (attrs.type || '').toLowerCase().split(';')[0].trim();
        if (
          !rel.includes('alternate') ||
          ![
            'application/rss+xml',
            'application/atom+xml',
            'application/feed+json',
            'application/json',
          ].includes(type)
        )
          continue;
        const candidate = safeHttpUrl(attrs.href, base);
        if (candidate && candidate !== finalUrl) candidates.add(candidate);
        if (candidates.size === 3) break;
      }
      for (const candidate of candidates) {
        if (deadline.aborted) break;
        const result = await fetchFeed(candidate, {
          deadline,
          proxyBaseUrl: options.proxyBaseUrl,
        });
        if (result.success) return result;
      }
      return {
        success: false,
        items: [],
        error:
          candidates.size > 0
            ? 'The website advertised feeds, but none returned a readable feed.'
            : 'No feed was advertised by this website. Enter the feed URL directly.',
      };
    }
    const isAtom =
      /^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?feed[\s>]/i.test(
        xml,
      );
    const result = xml.trimStart().startsWith('{')
      ? parseJsonFeed(xml)
      : ((isAtom ? parseAtom(xml, finalUrl) : null) ??
        (await parser.parseString(xml)));

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

        const summary =
          coerceText(item.summary) || coerceText(item.contentSnippet);
        const content =
          coerceText(item['content:encoded']) ||
          coerceText(item.content) ||
          summary;

        // Fallback: extract first img src from HTML content
        if (!imageUrl) {
          const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
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

        const identifier = coerceText(item.guid || item.id);
        const safeUrl =
          safeHttpUrl(item.link, finalUrl) ||
          safeHttpUrl(item['rdf:about'], finalUrl) ||
          safeHttpUrl(enclosure?.url, finalUrl) ||
          (/^https?:\/\//i.test(identifier)
            ? safeHttpUrl(identifier, finalUrl)
            : '');
        if (!safeUrl) return null;
        const safeImageUrl = safeHttpUrl(imageUrl, safeUrl);
        const externalUrl = safeHttpUrl(item.externalUrl, finalUrl);

        const cleanSummary = sanitizeHtml(summary, safeUrl);
        const boundedSummary =
          cleanSummary.length > 500
            ? stripHtml(cleanSummary).slice(0, 500).trim()
            : cleanSummary;

        return {
          guid: coerceText(item.guid || item.id || item.link),
          url: safeUrl,
          title: coerceText(item.title) || 'Untitled',
          author:
            coerceText(item.creator) ||
            coerceText(item.author) ||
            coerceText(item['dc:creator']) ||
            undefined,
          summary: boundedSummary || undefined,
          content: sanitizeHtml(content, safeUrl) || undefined,
          imageUrl: safeImageUrl || undefined,
          externalUrl:
            externalUrl && externalUrl !== safeUrl ? externalUrl : undefined,
          categories: normalizeTextArray(item.categories),
          publishedAt: parsePublicationDate(
            item.pubDate,
            item.isoDate,
            item.dcDate,
          ),
        } as FetchedItem;
      })
      .filter((item): item is FetchedItem => Boolean(item));

    return {
      success: true,
      subscriptionUrl: parsedUrl.href,
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
