type ArticleImageSource = 'hero' | 'content';

export type ArticleImage = {
  src: string;
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

function extractImageCandidates(text: string): string[] {
  const decoded = decodeHtmlEntities(text);
  const candidates: string[] = [];

  const htmlImgRegex = /<img\b[^>]*src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = htmlImgRegex.exec(decoded)) !== null) {
    candidates.push(match[1]);
  }

  const markdownImgRegex = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((match = markdownImgRegex.exec(decoded)) !== null) {
    candidates.push(match[1]);
  }

  return candidates;
}

export function extractArticleImages(options: {
  articleUrl: string;
  heroUrl?: string | null;
  content?: string | null;
}): ArticleImage[] {
  const images: ArticleImage[] = [];
  const seen = new Set<string>();

  const push = (candidate: string | null | undefined, source: ArticleImageSource) => {
    if (!candidate) return;
    const normalized = normalizeImageUrl(candidate, options.articleUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    images.push({ src: normalized, source });
  };

  push(options.heroUrl, 'hero');

  if (options.content) {
    for (const candidate of extractImageCandidates(options.content)) {
      push(candidate, 'content');
    }
  }

  return images;
}
