import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfiguredProxyBaseUrl } from '$lib/server/proxy';
import { recordAppError } from '$lib/server/logging';
import { sanitizeHtml } from '$lib/utils/format';
import {
  MAX_HTML_RESPONSE_BYTES,
  SafeFetchError,
  fetchSafe,
  readResponseText,
} from '$lib/server/network';

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid';
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    throw error(400, 'Missing url parameter');
  }

  const proxyBaseUrl = getConfiguredProxyBaseUrl();
  try {
    const { response, finalUrl } = await fetchSafe(
      targetUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(20000),
      },
      {
        proxyBaseUrl,
        maxBytes: MAX_HTML_RESPONSE_BYTES,
        allowedContentTypes: ['text/html', 'application/xhtml+xml'],
      },
    );

    if (!response.ok) {
      recordAppError({
        source: 'api.proxy',
        error: new Error(`Proxy access denied (${response.status})`),
        details: {
          targetOrigin: safeOrigin(targetUrl),
          proxyOrigin: proxyBaseUrl ? safeOrigin(proxyBaseUrl) : null,
        },
        path: '/api/proxy',
        method: 'GET',
      });
      return new Response(
        `<html><body><h2>Proxy Access Denied (${response.status})</h2><p>This website is actively blocking automated access.</p><p>Try Reader mode or open the source directly.</p></body></html>`,
        {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'private, no-store',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; form-action 'none'",
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    }

    const html = sanitizeHtml(
      await readResponseText(response, MAX_HTML_RESPONSE_BYTES),
    );
    const baseTag = `<base href="${escapeHtmlAttribute(finalUrl)}">`;
    const safeDocument = `<!doctype html><html><head>${baseTag}</head><body>${html}</body></html>`;

    return new Response(safeDocument, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy':
          "default-src 'none'; img-src http: https:; style-src 'unsafe-inline'; font-src https:; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri http: https:",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        Vary: 'Cookie',
      },
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      const status =
        err.code === 'invalid_url' || err.code === 'private_network'
          ? 400
          : err.code === 'unsupported_content_type' ||
              err.code === 'response_too_large'
            ? 415
            : 502;
      throw error(status, err.message);
    }

    recordAppError({
      source: 'api.proxy',
      error: err,
      details: {
        targetOrigin: safeOrigin(targetUrl),
        proxyOrigin: proxyBaseUrl ? safeOrigin(proxyBaseUrl) : null,
      },
      path: '/api/proxy',
      method: 'GET',
    });
    throw error(500, 'Failed to proxy request');
  }
};
