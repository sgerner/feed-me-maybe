import { env } from '$env/dynamic/private';
import { buildProxyRequestUrl } from '$lib/proxy';

const PROXY_ENV_KEYS = ['PROXY_BASE_URL', 'REDDIT_BASE_URL'] as const;

export function getConfiguredProxyBaseUrl(): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key] || process.env[key];
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function buildProxiedUrl(
  targetUrl: string,
  proxyBaseUrl?: string,
): string {
  return proxyBaseUrl ? buildProxyRequestUrl(proxyBaseUrl, targetUrl) : targetUrl;
}

export function hasConfiguredProxy(): boolean {
  return Boolean(getConfiguredProxyBaseUrl());
}
