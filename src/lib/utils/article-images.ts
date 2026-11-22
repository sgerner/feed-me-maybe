type ArticleImageSource = 'hero' | 'content';

export type ArticleImage = {
  src: string;
  alt: string;
  source: ArticleImageSource;
};

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#x27;': "'",
    '&#39;': "'",
    '&#x2f;': '/',
    '&#47;': '/',
    '&nbsp;': ' ',
  };
  return text.replace(
    /&(?:amp|lt|gt|quot|nbsp|#x27|#39|#x2F|#47);/gi,
    (match) => entities[match.toLowerCase()] ?? match,
  );
}

function isPlaceholderImageSrc(value: string | undefined): boolean {
  if (!value) return true;
  const trimmed = decodeHtmlEntities(value).trim();
  return !trimmed || /^(?:data:|blob:|about:)/i.test(trimmed);
}

function normalizeImageUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = decodeHtmlEntities(candidate).trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith('#') ||
    /^(?:javascript:|data:|blob:|about:|mailto:|tel:)/i.test(trimmed)
  ) {
    return null;
  }

  if (trimmed.startsWith('//')) {
    if (baseUrl) {
      try {
        return new URL(trimmed, baseUrl).href;
      } catch {
        // Fall through to https upgrade
      }
    }
    try {
      return new URL(`https:${trimmed}`).href;
    } catch {
      return null;
    }
  }

  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

function extractImageCandidates(text: string): { src: string; alt: string }[] {
  const candidates: { src: string; alt: string }[] = [];
  const html = text.replace(/&lt;img\b.*?&gt;/gi, (tag) =>
    decodeHtmlEntities(tag),
  );
  for (const [tag] of html.matchAll(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = new Map<string, string>();
    for (const [, name, doubleQuoted, singleQuoted] of tag.matchAll(
      /\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attrs.set(name.toLowerCase(), doubleQuoted ?? singleQuoted);
    }
    const rawSrc = attrs.get('src');
    const src = !isPlaceholderImageSrc(rawSrc)
      ? rawSrc
      : attrs.get('data-src') ||
        attrs.get('data-lazy-src') ||
        attrs.get('data-original');
    if (src && !isPlaceholderImageSrc(src))
      candidates.push({ src, alt: decodeHtmlEntities(attrs.get('alt') ?? '') });
  }

  for (const [, alt, src] of text.matchAll(
    /!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    if (!isPlaceholderImageSrc(src)) {
      candidates.push({ src, alt: decodeHtmlEntities(alt) });
    }
  }
  return candidates;
}

export function extractArticleImages(options: {
  articleUrl: string;
  heroUrl?: string | null;
  content?: string | null;
}): ArticleImage[] {
  const images: ArticleImage[] = [];
  const seen = new Map<string, ArticleImage>();

  const push = (
    candidate: string | null | undefined,
    source: ArticleImageSource,
    alt = '',
  ) => {
    if (!candidate) return;
    const normalized = normalizeImageUrl(candidate, options.articleUrl);
    if (!normalized) return;
    const existing = seen.get(normalized);
    if (existing) {
      if (!existing.alt) existing.alt = alt;
      return;
    }
    const image = { src: normalized, source, alt };
    seen.set(normalized, image);
    images.push(image);
  };

  push(options.heroUrl, 'hero');

  if (options.content) {
    for (const candidate of extractImageCandidates(options.content)) {
      push(candidate.src, 'content', candidate.alt);
    }
  }

  return images;
}
