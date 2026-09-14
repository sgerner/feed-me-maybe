import { registerClient } from '$lib/server/realtime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
  if (!locals.sessionId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const clientId = crypto.randomUUID();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      // Send initial comment to establish connection
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));

      const unregister = registerClient(clientId, controller);

      // Keep connection alive with heartbeats every 30 seconds
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
        } catch (err) {
          cleanup();
        }
      }, 30000);

      // When the client closes the connection, clean up the registry and timer.
      cleanup = () => {
        clearInterval(heartbeatInterval);
        unregister();
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
