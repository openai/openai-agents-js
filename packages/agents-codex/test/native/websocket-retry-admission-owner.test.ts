import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { Agent, NativeProvider, type RetryContext } from '../../src';

it.each(['before-open', 'after-send'] as const)(
  'keeps native retry admission scoped to %s',
  async (failure) => {
    const wire = { upgrades: 0, generations: 0, http: 0 };
    const seen: RetryContext[] = [];
    const server = createServer((_request, response) => {
      wire.http++;
      response.writeHead(500).end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      wire.upgrades++;
      if (failure === 'before-open' && wire.upgrades === 1) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) =>
        sockets.emit('connection', ws),
      );
    });
    sockets.on('connection', (socket) =>
      socket.on('message', () => {
        wire.generations++;
        if (failure === 'after-send') {
          socket.close();
          return;
        }
        const item = {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'recovered', annotations: [] },
          ],
        };
        for (const event of [
          { type: 'response.created', response: { id: 'resp' } },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: { id: 'resp', output: [item] },
          },
        ])
          socket.send(JSON.stringify(event));
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP fixture');
    try {
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'synthetic-retry-boundary',
        supportsWebsockets: true,
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      });
      const result = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5.5',
        provider,
        modelSettings: {
          requestTransport: 'websocket',
          retry: {
            maxRetries: 1,
            policy(context) {
              seen.push(context);
              return { retry: true, delayMs: 0, approveUnsafeReplay: true };
            },
          },
        },
      }).run('Reply.');
      if (failure === 'before-open') {
        expect((await result).finalOutput).toBe('recovered');
        expect(wire).toEqual({ upgrades: 2, generations: 1, http: 0 });
        expect(seen).toHaveLength(1);
      } else {
        await expect(result).rejects.toThrow();
        expect(wire).toEqual({ upgrades: 1, generations: 1, http: 0 });
      }
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);
