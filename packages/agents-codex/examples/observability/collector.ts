import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

/** A bounded local demonstration receiver, not a telemetry service. */
export async function startCollector({
  maxBytes = 4 * 1024 * 1024,
  maxRequests = 16,
}: { maxBytes?: number; maxRequests?: number } = {}) {
  const batches: { signal: 'traces' | 'logs'; data: unknown }[] = [];
  const sockets = new Set<Socket>();
  const handlers = new Set<Promise<void>>();
  let requests = 0;
  let failure: string | undefined;
  let closing = false;
  let closed: Promise<void> | undefined;

  async function receive(request: IncomingMessage, response: ServerResponse) {
    try {
      if (++requests > maxRequests) {
        failure ??= 'request count exceeded';
        response.writeHead(429).end();
        request.resume();
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/v1/traces', '/v1/logs'].includes(request.url ?? '')
      ) {
        failure ??= 'unsupported method or path';
        response.writeHead(404).end();
        request.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          failure ??= 'body byte limit exceeded';
          response.writeHead(413).end();
          request.resume();
          return;
        }
        chunks.push(buffer);
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        failure ??= 'invalid JSON body';
        throw new Error('Invalid collector JSON');
      }
      batches.push({
        signal: request.url === '/v1/traces' ? 'traces' : 'logs',
        data,
      });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } catch {
      if (!closing) failure ??= 'body read failed';
      if (!response.destroyed && !response.headersSent)
        response.writeHead(400).end();
    }
  }

  const server = createServer((request, response) => {
    const handler = receive(request, response);
    handlers.add(handler);
    void handler.then(() => handlers.delete(handler));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('error', () => {
    failure ??= 'server failure';
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Collector did not bind loopback');

  return {
    url: `http://127.0.0.1:${address.port}`,
    snapshot: () => structuredClone(batches),
    close(): Promise<void> {
      closed ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        // Also unblock handlers whose clients never finished sending a body.
        for (const socket of sockets) socket.destroy();
        await Promise.all([...handlers]);
        await stopped;
        if (failure)
          throw new Error(
            `Local telemetry collector rejected a request: ${failure}`,
          );
      })();
      return closed;
    },
  };
}
