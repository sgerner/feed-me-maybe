const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const ALLOWED_CONTENT_TYPES = [
  'application/atom+xml',
  'application/json',
  'application/ld+json',
  'application/rss+xml',
  'application/xml',
  'text/atom',
  'text/html',
  'text/plain',
  'text/rss',
  'text/xml',
];

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
  'authorization',
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
  'x-api-key',
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
  return new URL(`https://www.reddit.com${incoming.pathname}${incoming.search}`)
    .href;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isSafeTargetUrl(value) {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    return false;
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    /\.(localhost|local|internal|test)$/.test(hostname)
  )
    return false;
  if (/^\d+(?:\.\d+){3}$/.test(hostname) && isPrivateIpv4(hostname))
    return false;
  if (
    hostname === '::1' ||
    hostname === '::' ||
    /^(?:fc|fd|fe8|fe9|fea|feb|ff)/.test(hostname)
  )
    return false;
  return true;
}

function contentTypeIsAllowed(response) {
  const contentType = (response.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return !contentType || ALLOWED_CONTENT_TYPES.includes(contentType);
}

async function fetchTarget(targetUrl, request) {
  let currentUrl = targetUrl;
  for (let redirects = 0; ; redirects += 1) {
    if (!isSafeTargetUrl(currentUrl)) throw new Error('Unsafe target URL');
    const response = await fetch(currentUrl, {
      method: request.method,
      headers: buildForwardHeaders(request),
      redirect: 'manual',
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect did not include a location');
      const nextUrl = new URL(location, currentUrl).href;
      if (!isSafeTargetUrl(nextUrl)) throw new Error('Unsafe redirect target');
      currentUrl = nextUrl;
      continue;
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error('Response too large');
    }
    if (!contentTypeIsAllowed(response))
      throw new Error('Unsupported content type');
    return response;
  }
}

function limitResponseBody(body) {
  if (!body) return body;
  let total = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          controller.error(new Error('Response too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function buildForwardHeaders(request) {
  const headers = new Headers();

  for (const [key, value] of request.headers.entries()) {
    if (STRIP_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }

  // Use the incoming User-Agent if provided, otherwise fallback to BROWSER_UA
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', BROWSER_UA);
  }

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

    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { ...buildCorsHeaders(), Allow: 'GET, HEAD, OPTIONS' },
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
      const response = await fetchTarget(targetUrl, request);
      const responseHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(buildCorsHeaders())) {
        responseHeaders.set(key, value);
      }

      return new Response(limitResponseBody(response.body), {
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
