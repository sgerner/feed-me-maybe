type ArticleImageSource = 'hero' | 'content';

export type ArticleImage = {
  src: string;
  alt: string;
  source: ArticleImageSource;
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

function normalizeImageUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = decodeHtmlEntities(candidate).trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:')
  ) {
    return null;
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
    const src = attrs.get('src');
    if (src)
      candidates.push({ src, alt: decodeHtmlEntities(attrs.get('alt') ?? '') });
  }

  for (const [, alt, src] of text.matchAll(
    /!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    candidates.push({ src, alt: decodeHtmlEntities(alt) });
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
