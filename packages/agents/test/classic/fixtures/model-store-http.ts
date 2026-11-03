import { createServer } from 'node:http';

// This fixture retains wire items across clients, not a provider-managed model conversation.
export async function modelStoreHttp() {
  const conversationId = 'classic-model-store';
  const items: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname !== `/v1/conversations/${conversationId}/items`) {
      response.writeHead(404).end();
      return;
    }
    let data = items;
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        items: Record<string, unknown>[];
      };
      data = body.items.map((item, index) => ({
        ...item,
        ...(item.role === 'user'
          ? {
              type: 'message',
              content:
                typeof item.content === 'string'
                  ? [{ type: 'input_text', text: item.content }]
                  : item.content,
            }
          : {}),
        id: `item-${items.length + index}`,
      }));
      items.push(...data);
    } else if (
      request.method !== 'GET' ||
      url.searchParams.get('order') !== 'asc'
    ) {
      response.writeHead(400).end();
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ object: 'list', data, has_more: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The model-store fixture did not bind a TCP port.');
  }
  return {
    conversationId,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    items,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
