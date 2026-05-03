export const ARTICLE_OPEN_MODES = [
  { value: 'app', label: 'Fetch & Render (In-App)' },
  { value: 'iframe', label: 'Iframe (In-App)' },
  { value: 'proxy', label: 'Iframe via Proxy (Bypass Blocks)' },
  { value: 'archive', label: 'Archive Reader (In-App)' },
  { value: 'tab', label: 'New Tab' },
] as const;

export type ArticleOpenMode = (typeof ARTICLE_OPEN_MODES)[number]['value'];

export function isArticleOpenMode(value: unknown): value is ArticleOpenMode {
  return ARTICLE_OPEN_MODES.some((mode) => mode.value === value);
}

