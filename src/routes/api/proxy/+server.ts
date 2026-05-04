import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildProxiedUrl, getConfiguredProxyBaseUrl } from '$lib/server/proxy';
import { recordAppError } from '$lib/server/logging';

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    throw error(400, 'Missing url parameter');
  }

  try {
    const fetchUrl = buildProxiedUrl(
      targetUrl,
      getConfiguredProxyBaseUrl(),
    );
    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Ch-Ua':
          '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    if (!response.ok) {
      recordAppError({
        source: 'api.proxy',
        error: new Error(`Proxy access denied (${response.status})`),
        details: {
          targetUrl,
          fetchUrl,
        },
        path: '/api/proxy',
        method: 'GET',
      });
      return new Response(
        `<html><body style="background:#0f172a;color:#94a3b8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;">
          <h2 style="color:#f8fafc;">Proxy Access Denied (${response.status})</h2>
          <p>This website is actively blocking automated access.</p>
          <p style="font-size:0.8rem;margin-top:20px;">Try switching to <b>READER</b> mode or open the <b>SOURCE</b> directly.</p>
        </body></html>`,
        {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        },
      );
    }

    const contentType = response.headers.get('Content-Type') || 'text/html';

    // Only process text/html
    if (contentType.includes('text/html')) {
      let html = await response.text();

      // Inject <base> tag to fix relative links
      const baseTag = `<base href="${targetUrl}">`;
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${baseTag}`);
      } else if (html.includes('<html>')) {
        html = html.replace('<html>', `<html><head>${baseTag}</head>`);
      } else {
        html = baseTag + html;
      }

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // For other types, just pipe it through
    return new Response(response.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    console.error('Proxy error:', err);
    recordAppError({
      source: 'api.proxy',
      error: err,
      details: {
        targetUrl,
        fetchUrl: buildProxiedUrl(targetUrl, getConfiguredProxyBaseUrl()),
      },
      path: '/api/proxy',
      method: 'GET',
    });
    throw error(500, 'Failed to proxy request');
  }
};
