export default {
  async fetch(request) {
    const url = new URL(request.url);
    
    // 1. Change the target to Reddit
    const targetUrl = "https://www.reddit.com" + url.pathname + url.search;

    // 2. Prepare clean headers (Reddit blocks requests with Cloudflare-specific headers)
    const newHeaders = new Headers();
    const headersToStrip = ['cf-worker', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-real-ip'];

    for (const [key, value] of request.headers.entries()) {
      if (!headersToStrip.includes(key.toLowerCase())) {
        newHeaders.set(key, value);
      }
    }

    // 3. Set a modern Browser User-Agent (CRITICAL)
    newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    newHeaders.set('Host', 'www.reddit.com');

    // 4. Execute the request
    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        redirect: 'follow'
      });

      // Return the response back to your app
      return new Response(response.body, response);
    } catch (err) {
      return new Response("Proxy Error: " + err.message, { status: 500 });
    }
  }
};
