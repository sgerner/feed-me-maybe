const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const STRIP_HEADERS = new Set([
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'connection',
  'content-encoding',
  'content-length',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

function buildTargetUrl(requestUrl) {
  const incoming = new URL(requestUrl);
  const explicitTarget = incoming.searchParams.get('url');

  if (explicitTarget) {
    const explicitUrl = new URL(explicitTarget);
    if (!['http:', 'https:'].includes(explicitUrl.protocol)) {
      throw new Error('Unsupported target protocol');
    }
    return explicitUrl.href;
  }

  if (incoming.pathname === '/' && !incoming.search) {
    throw new Error('Missing url parameter');
  }

  // Legacy compatibility: treat path-based requests as Reddit paths.
  return new URL(
    `https://www.reddit.com${incoming.pathname}${incoming.search}`,
  ).href;
}

function buildForwardHeaders(request) {
  const headers = new Headers();

  for (const [key, value] of request.headers.entries()) {
    if (STRIP_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }

  headers.set('User-Agent', BROWSER_UA);
  if (!headers.has('Accept-Language')) {
    headers.set('Accept-Language', 'en-US,en;q=0.9');
  }

  return headers;
}

function buildCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Accept,Accept-Language,Authorization,Content-Type,If-Modified-Since,If-None-Match,Range,X-Requested-With',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(),
      });
    }

    let targetUrl;
    try {
      targetUrl = buildTargetUrl(request.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Proxy Error: ${message}`, {
        status: 400,
        headers: buildCorsHeaders(),
      });
    }

    try {
      const headers = buildForwardHeaders(request);
      const init = {
        method: request.method,
        headers,
        redirect: 'follow',
      };

      if (!['GET', 'HEAD'].includes(request.method)) {
        init.body = request.body;
      }

      const response = await fetch(targetUrl, init);
      const responseHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(buildCorsHeaders())) {
        responseHeaders.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Proxy Error: ${message}`, {
        status: 500,
        headers: buildCorsHeaders(),
      });
    }
  },
};
