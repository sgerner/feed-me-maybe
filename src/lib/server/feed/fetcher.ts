import { DOMParser } from 'linkedom';
import Parser from 'rss-parser';
import { sanitizeHtml } from '#lib/utils/format.ts';
import {
  MAX_FEED_RESPONSE_BYTES,
  fetchSafe,
  readResponseText,
} from '#lib/server/network.ts';
import {
  coerceText,
  normalizeTextArray,
  stripHtml,
} from '#lib/server/normalization.ts';

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
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['dc:creator', 'dcCreator'],
      ['dc:date', 'dcDate'],
    ],
  },
});

const RSS_TIMEZONE_OFFSETS: Record<string, string> = {
  ACDT: '+1030',
  ACST: '+0930',
  ADT: '-0300',
  AEDT: '+1100',
  AEST: '+1000',
  AKDT: '-0800',
  AKST: '-0900',
  AST: '-0400',
  AWST: '+0800',
  BST: '+0100',
  CAT: '+0200',
  CEST: '+0200',
  CET: '+0100',
  EAT: '+0300',
  EEST: '+0300',
  EET: '+0200',
  HKT: '+0800',
  HST: '-1000',
  IST: '+0530',
  JST: '+0900',
  KST: '+0900',
  MSK: '+0300',
  NDT: '-0230',
  NST: '-0330',
  NZDT: '+1300',
  NZST: '+1200',
  PKT: '+0500',
  SAST: '+0200',
  SGT: '+0800',
  WAT: '+0100',
  WEST: '+0100',
  WET: '+0000',
};

function parsePublicationDate(...candidates: unknown[]): Date | undefined {
  for (const candidate of candidates) {
    const raw = coerceText(candidate);
    if (!raw) continue;
    const value = raw.replace(
      /\s+\(?([A-Z]{2,5})\)?$/i,
      (full, zone: string) =>
        RSS_TIMEZONE_OFFSETS[zone.toUpperCase()]
          ? ' ' + RSS_TIMEZONE_OFFSETS[zone.toUpperCase()]
          : full,
    );
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
}

function escapeBareAmpersands(xml: string): string {
  return xml.replace(
    /(<!\[CDATA\[[\s\S]*?\]\]>)|&(?!#(?:\d+|x[0-9a-fA-F]+);|[a-zA-Z][\w.-]*;)/g,
    (_match, cdata: string | undefined) => (cdata ? cdata : '&amp;'),
  );
}

async function parseRssXml(xml: string) {
  try {
    return await parser.parseString(xml);
  } catch (firstError) {
    const escaped = escapeBareAmpersands(xml);
    if (escaped !== xml) {
      return await parser.parseString(escaped);
    }
    throw firstError;
  }
}

type MediaEntry = {
  $?: { url?: string; medium?: string; type?: string };
  url?: string;
  medium?: string;
  type?: string;
  baseUrl?: string;
};

function toMediaArray(value: unknown): MediaEntry[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is MediaEntry => Boolean(entry && typeof entry === 'object'),
  );
}

function getMediaUrl(entry: MediaEntry): string {
  if (typeof entry.$?.url === 'string' && entry.$.url.trim()) {
    return entry.$.url.trim();
  }
  if (typeof entry.url === 'string' && entry.url.trim()) {
    return entry.url.trim();
  }
  return '';
}

function getMediaKind(entry: MediaEntry): { medium: string; type: string } {
  return {
    medium: String(entry.$?.medium ?? entry.medium ?? '')
      .trim()
      .toLowerCase(),
    type: String(entry.$?.type ?? entry.type ?? '')
      .trim()
      .toLowerCase(),
  };
}

function isExplicitImageMedia(entry: MediaEntry): boolean {
  const { medium, type } = getMediaKind(entry);
  return medium === 'image' || type.startsWith('image/');
}

function isNonImageMedia(entry: MediaEntry, url: string): boolean {
  const { medium, type } = getMediaKind(entry);
  if (
    medium === 'audio' ||
    medium === 'video' ||
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    (type !== '' && !type.startsWith('image/'))
  ) {
    return true;
  }
  return /\.(?:mp3|m4a|ogg|opus|wav|aac|flac|mp4|webm|mov|m4v)(?:[?#]|$)/i.test(
    url,
  );
}

function pickMediaImage(
  mediaContent: unknown,
  mediaThumbnail: unknown,
  enclosure: unknown,
): { url: string; baseUrl?: string } {
  const contents = toMediaArray(mediaContent);
  const thumbnails = toMediaArray(mediaThumbnail);

  for (const entry of contents) {
    const url = getMediaUrl(entry);
    if (url && isExplicitImageMedia(entry)) {
      return { url, baseUrl: entry.baseUrl };
    }
  }

  for (const entry of thumbnails) {
    const url = getMediaUrl(entry);
    if (url) {
      return { url, baseUrl: entry.baseUrl };
    }
  }

  const enc = enclosure as { url?: unknown; type?: unknown } | undefined;
  if (
    typeof enc?.url === 'string' &&
    enc.url.trim() &&
    typeof enc.type === 'string' &&
    enc.type.toLowerCase().startsWith('image/')
  ) {
    return { url: enc.url.trim() };
  }

  for (const entry of contents) {
    const url = getMediaUrl(entry);
    if (url && !isNonImageMedia(entry, url)) {
      return { url, baseUrl: entry.baseUrl };
    }
  }

  return { url: '' };
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

  const hasClosingFeed =
    /<\/(?:[\w.-]+:)?feed\s*>/i.test(xml) ||
    /<(?:[\w.-]+:)?feed\b[^>]*\/>/i.test(xml);
  if (!hasClosingFeed) {
    throw new Error('Truncated Atom feed: missing closing </feed> tag');
  }

  const isMediaElement = (element: Element) =>
    element.prefix === 'media' ||
    element.tagName.toLowerCase().startsWith('media:') ||
    element.namespaceURI === 'http://search.yahoo.com/mrss/';
  const children = (node: Element, name: string) =>
    Array.from(node.children).filter(
      (child) =>
        !isMediaElement(child) && child.localName.split(':').at(-1) === name,
    );
  const mediaChildren = (node: Element, name: string) =>
    Array.from(node.children).filter(
      (child) =>
        isMediaElement(child) && child.localName.split(':').at(-1) === name,
    );
  const resolveDeclaredXmlBase = (
    element: Element,
    fallbackBase: string,
  ): string | undefined => {
    let resolved = fallbackBase;
    let hasDeclaredBase = false;
    const chain: Element[] = [];
    for (
      let ancestor: Element | null = element;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      chain.unshift(ancestor);
    }
    for (const ancestor of chain) {
      const declared = ancestor.getAttribute('xml:base');
      if (declared) {
        const next = safeHttpUrl(declared, resolved);
        if (next) {
          resolved = next;
          hasDeclaredBase = true;
        }
      }
    }
    return hasDeclaredBase ? resolved : undefined;
  };
  const escapeTextForHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = (node: Element, name: string) =>
    children(node, name)[0]?.textContent?.trim();
  const atomPlainText = (node: Element, name: string) => {
    const element = children(node, name)[0];
    if (!element) return undefined;
    const type = element.getAttribute('type')?.toLowerCase();
    if (type === 'xhtml') {
      return stripHtml(element.innerHTML) || undefined;
    }
    const content = element.textContent?.trim() || '';
    if (!content) return undefined;
    if (type === 'html') {
      return stripHtml(content) || undefined;
    }
    return content;
  };
  const atomText = (
    node: Element,
    name: string,
  ): { value?: string; base?: string } => {
    const element = children(node, name)[0];
    if (!element) return {};
    const declaredBase = resolveDeclaredXmlBase(element, baseUrl);
    const type = element.getAttribute('type')?.toLowerCase();
    if (type === 'xhtml') {
      return { value: element.innerHTML, base: declaredBase };
    }
    const content = element.textContent?.trim() || '';
    return {
      value: type === 'html' ? content : escapeTextForHtml(content),
      base: declaredBase,
    };
  };
  const link = (node: Element) => {
    for (const element of children(node, 'link')) {
      const relation = element.getAttribute('rel');
      if (relation && relation !== 'alternate') continue;
      const resolvedBase = resolveDeclaredXmlBase(element, baseUrl) || baseUrl;
      const href = safeHttpUrl(element.getAttribute('href'), resolvedBase);
      if (href) return href;
    }
    return '';
  };
  const feedDeclaredBase = resolveDeclaredXmlBase(root, baseUrl) || baseUrl;
  return {
    title: atomPlainText(root, 'title'),
    description: atomPlainText(root, 'subtitle'),
    link: link(root),
    image: {
      url:
        safeHttpUrl(
          text(root, 'logo') || text(root, 'icon'),
          feedDeclaredBase,
        ) ||
        text(root, 'logo') ||
        text(root, 'icon'),
    },
    items: children(root, 'entry').map((entry): Record<string, unknown> => {
      const authors = [
        ...children(entry, 'author'),
        ...children(root, 'author'),
      ];
      const summary = atomText(entry, 'summary');
      const content = atomText(entry, 'content');
      const mediaGroups = mediaChildren(entry, 'group');
      const mediaScope = [entry, ...mediaGroups];
      const mediaContent = mediaScope.flatMap((scope) =>
        mediaChildren(scope, 'content').map((el) => ({
          $: {
            url: el.getAttribute('url') || '',
            medium: el.getAttribute('medium') || '',
            type: el.getAttribute('type') || '',
          },
          baseUrl: resolveDeclaredXmlBase(el, baseUrl),
        })),
      );
      const mediaThumbnail = mediaScope.flatMap((scope) =>
        mediaChildren(scope, 'thumbnail').map((el) => ({
          $: { url: el.getAttribute('url') || '' },
          baseUrl: resolveDeclaredXmlBase(el, baseUrl),
        })),
      );
      const mediaDescriptionEl = mediaScope
        .flatMap((scope) => mediaChildren(scope, 'description'))
        .find((el) => Boolean(el.textContent?.trim()));
      const summaryValue =
        summary.value ||
        (mediaDescriptionEl
          ? escapeTextForHtml(mediaDescriptionEl.textContent!.trim())
          : undefined);
      const summaryBase =
        summary.base ||
        (mediaDescriptionEl
          ? resolveDeclaredXmlBase(mediaDescriptionEl, baseUrl)
          : undefined);
      const entryDeclaredBase = resolveDeclaredXmlBase(entry, baseUrl);
      return {
        id: text(entry, 'id'),
        title: atomPlainText(entry, 'title'),
        link: link(entry),
        baseUrl: entryDeclaredBase,
        author: authors.map((author) => text(author, 'name')).find(Boolean),
        summary: summaryValue,
        summaryBase,
        content: content.value,
        contentBase: content.base,
        mediaContent,
        mediaThumbnail,
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
      const summaryRaw = coerceText(item.summary);
      const contentTextRaw = coerceText(item.content_text);
      const contentHtmlRaw = coerceText(item.content_html);
      const derivedSummary = summaryRaw
        ? htmlText(summaryRaw)
        : contentTextRaw
          ? htmlText(contentTextRaw)
          : contentHtmlRaw || '';
      return [
        {
          guid: item.id,
          link: item.url || item.external_url,
          externalUrl: item.external_url,
          title: item.title,
          author: author?.name,
          summary: derivedSummary,
          content: contentHtmlRaw || htmlText(contentTextRaw),
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
      /^(?:\s|\uFEFF)*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\b(?:\[[\s\S]*?\]|[^>])*>)*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\b(?:\[[\s\S]*?\]|[^>])*>|\s)*<(?:[\w.-]+:)?feed[\s>]/i.test(
        xml,
      );
    const result = xml.trimStart().startsWith('{')
      ? parseJsonFeed(xml)
      : ((isAtom ? parseAtom(xml, finalUrl) : null) ??
        (await parseRssXml(xml)));

    const newEtag = response.headers.get('etag') || undefined;
    const newLastModified = response.headers.get('last-modified') || undefined;

    const items: FetchedItem[] = (result.items || [])
      .map((item: Record<string, unknown>) => {
        const pickedMedia = pickMediaImage(
          item.mediaContent,
          item.mediaThumbnail,
          item.enclosure,
        );
        let imageUrl = pickedMedia.url;

        const summary =
          coerceText(item.summary) ||
          coerceText(item.content) ||
          coerceText(item.contentSnippet);
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

        const identifier = coerceText(item.guid) || coerceText(item.id);
        const enclosure = item.enclosure as { url?: unknown } | undefined;
        const safeUrl =
          safeHttpUrl(item.link, finalUrl) ||
          safeHttpUrl(item['rdf:about'], finalUrl) ||
          safeHttpUrl(enclosure?.url, finalUrl) ||
          (/^https?:\/\//i.test(identifier)
            ? safeHttpUrl(identifier, finalUrl)
            : '');
        if (!safeUrl) return null;
        const itemBase =
          (typeof item.baseUrl === 'string' && item.baseUrl) ||
          safeUrl ||
          finalUrl;
        const summaryBase =
          (typeof item.summaryBase === 'string' && item.summaryBase) ||
          itemBase;
        const contentBase =
          (typeof item.contentBase === 'string' && item.contentBase) ||
          itemBase;
        const mediaBase = pickedMedia.baseUrl || itemBase;
        const safeImageUrl = safeHttpUrl(imageUrl, mediaBase);
        const externalUrl = safeHttpUrl(item.externalUrl, finalUrl);

        const cleanSummary = sanitizeHtml(summary, summaryBase);
        const boundedSummary =
          cleanSummary.length > 500
            ? stripHtml(cleanSummary).slice(0, 500).trim()
            : cleanSummary;

        return {
          guid: identifier || undefined,
          url: safeUrl,
          title: coerceText(item.title) || 'Untitled',
          author:
            coerceText(item.creator) ||
            coerceText(item.author) ||
            coerceText(item['dc:creator']) ||
            undefined,
          summary: boundedSummary || undefined,
          content: sanitizeHtml(content, contentBase) || undefined,
          imageUrl: safeImageUrl || undefined,
          externalUrl:
            externalUrl && externalUrl !== safeUrl ? externalUrl : undefined,
          categories: normalizeTextArray(item.categories),
          publishedAt: parsePublicationDate(
            item.pubDate,
            item.isoDate,
            item.dcDate,
            item['dc:date'],
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
