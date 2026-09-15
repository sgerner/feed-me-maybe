import dns from 'node:dns/promises';
import net from 'node:net';
import { buildProxyRequestUrl } from '$lib/proxy';

export const MAX_FEED_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_HTML_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 4;

const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.test'];

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_url'
      | 'private_network'
      | 'dns_failure'
      | 'too_many_redirects'
      | 'unsafe_redirect'
      | 'response_too_large'
      | 'unsupported_content_type',
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }

  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6Hextets(address: string): number[] | null {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = value.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  return [
    ...left.map((part) => parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => parseInt(part, 16)),
  ];
}

export function isPrivateIpAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (net.isIP(normalized) !== 6) return true;

  const hextets = parseIpv6Hextets(normalized);
  if (!hextets) return true;
  const first = hextets[0];
  const mappedIpv4 =
    hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff
      ? `${hextets[6] >> 8}.${hextets[6] & 255}.${hextets[7] >> 8}.${hextets[7] & 255}`
      : null;

  return (
    (mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false) ||
    hextets.every((part) => part === 0) ||
    hextets.slice(0, 7).every((part) => part === 0) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (hextets[0] === 0x2001 && hextets[1] === 0xdb8)
  );
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
}

export function validatePublicUrl(input: string | URL): URL {
  let parsed: URL;
  try {
    parsed = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new SafeFetchError('Invalid URL', 'invalid_url');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SafeFetchError(
      'Only http/https URLs are supported',
      'invalid_url',
    );
  }
  if (parsed.username || parsed.password) {
    throw new SafeFetchError(
      'URLs with embedded credentials are not supported',
      'invalid_url',
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (
    !hostname ||
    hostname === 'localhost' ||
    (net.isIP(hostname) === 0 &&
      BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
  ) {
    throw new SafeFetchError(
      'Private network URLs are not allowed',
      'private_network',
    );
  }
  if (net.isIP(hostname) !== 0 && isPrivateIpAddress(hostname)) {
    throw new SafeFetchError(
      'Private network URLs are not allowed',
      'private_network',
    );
  }

  return parsed;
}

export async function assertPublicNetworkUrl(
  input: string | URL,
): Promise<URL> {
  const parsed = validatePublicUrl(input);
  const hostname = normalizeHostname(parsed.hostname);
  if (net.isIP(hostname) !== 0) return parsed;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError('Unable to resolve remote host', 'dns_failure');
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateIpAddress(address))
  ) {
    throw new SafeFetchError(
      'Remote host resolves to a private network',
      'private_network',
    );
  }
  return parsed;
}

function mimeType(response: Response): string {
  return (response.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

export function hasAllowedContentType(
  response: Response,
  allowedContentTypes: readonly string[],
): boolean {
  const contentType = mimeType(response);
  return (
    !contentType ||
    allowedContentTypes.some((allowed) => contentType === allowed)
  );
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SafeFetchError(
      'Remote response is too large',
      'response_too_large',
    );
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new SafeFetchError(
        'Remote response is too large',
        'response_too_large',
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response_too_large');
        throw new SafeFetchError(
          'Remote response is too large',
          'response_too_large',
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type SafeFetchOptions = {
  proxyBaseUrl?: string;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: readonly string[];
};

export async function fetchSafe(
  targetUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const target = await assertPublicNetworkUrl(targetUrl);
  let requestUrl = options.proxyBaseUrl
    ? buildProxyRequestUrl(
        validatePublicUrl(options.proxyBaseUrl).href,
        target.href,
      )
    : target.href;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetch(requestUrl, {
      ...init,
      redirect: 'manual',
    });

    if (HTTP_REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= maxRedirects) {
        throw new SafeFetchError('Too many redirects', 'too_many_redirects');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new SafeFetchError(
          'Redirect did not include a location',
          'unsafe_redirect',
        );
      }
      const next = await assertPublicNetworkUrl(new URL(location, requestUrl));
      requestUrl = next.href;
      continue;
    }

    if (
      response.ok &&
      options.allowedContentTypes &&
      !hasAllowedContentType(response, options.allowedContentTypes)
    ) {
      throw new SafeFetchError(
        'Remote response has an unsupported content type',
        'unsupported_content_type',
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      options.maxBytes &&
      Number.isFinite(declaredLength) &&
      declaredLength > options.maxBytes
    ) {
      throw new SafeFetchError(
        'Remote response is too large',
        'response_too_large',
      );
    }
    return { response, finalUrl: requestUrl };
  }
}
