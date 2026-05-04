
type Client = {
  id: string;
  controller: ReadableStreamDefaultController;
};

const clients = new Set<Client>();

/**
 * Registers a new SSE client connection.
 * Returns a cleanup function to unregister the client.
 */
export function registerClient(id: string, controller: ReadableStreamDefaultController) {
  const client = { id, controller };
  clients.add(client);
  
  console.log(`[realtime] Client connected: ${id} (Total: ${clients.size})`);
  
  return () => {
    clients.delete(client);
    console.log(`[realtime] Client disconnected: ${id} (Total: ${clients.size})`);
  };
}

/**
 * Broadcasts an event to all connected SSE clients.
 */
export function broadcast(event: string, data: any) {
  if (clients.size === 0) return;

  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoder = new TextEncoder();
  const encoded = encoder.encode(message);

  console.log(`[realtime] Broadcasting event "${event}" to ${clients.size} clients`);

  for (const client of clients) {
    try {
      client.controller.enqueue(encoded);
    } catch (err) {
      // If we can't send, the connection is likely closed
      clients.delete(client);
    }
  }
}
