export function buildProxyRequestUrl(
  proxyBaseUrl: string,
  targetUrl: string,
): string {
  const proxyUrl = new URL(proxyBaseUrl);
  proxyUrl.searchParams.set('url', targetUrl);
  return proxyUrl.href;
}
