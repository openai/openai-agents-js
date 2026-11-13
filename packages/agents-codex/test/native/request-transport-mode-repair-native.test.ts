import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider } from '../../src';

it.each([
  ['agent', 'http'],
  ['agent', 'websocket'],
  ['updated', 'http'],
  ['updated', 'websocket'],
] as const)(
  'retains %s selected %s through prompted output repair',
  async (source, selected) => {
    const wire = { http: 0, upgrades: 0, generations: 0 };
    const events = () => {
      const ordinal = ++wire.generations;
      const item = {
        id: `msg_${ordinal}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({ label: ordinal === 1 ? 'x' : 'fixed' }),
            annotations: [],
          },
        ],
      };
      const response = {
        id: `resp_${ordinal}`,
        model: 'gpt-5.5',
        status: 'completed',
        output: [item],
      };
      return [
        {
          type: 'response.created',
          response: { ...response, status: 'in_progress', output: [] },
        },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ];
    };
    const server = createServer(async (request, reply) => {
      for await (const _chunk of request) {
        /* drain the request */
      }
      wire.http++;
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end(
        events()
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      );
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      wire.upgrades++;
      if (selected === 'http' || wire.upgrades > 1) {
        socket.end(
          'HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) =>
        sockets.emit('connection', ws),
      );
    });
    sockets.on('connection', (socket) =>
      socket.on('message', (bytes) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.generate === false) {
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'warmup', output: [] },
            }),
          );
          return;
        }
        for (const event of events()) socket.send(JSON.stringify(event));
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
        apiKey: 'synthetic-repair-mode',
        supportsWebsockets: true,
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      });
      const initial =
        source === 'agent'
          ? selected
          : selected === 'http'
            ? 'websocket'
            : 'http';
      const agent = new Agent({
        instructions: 'Return JSON.',
        model: 'gpt-5.5',
        provider,
        modelSettings: { requestTransport: initial },
        outputType: {
          mode: 'prompted',
          schema: z.object({ label: z.string().min(2) }),
          maxRetries: 1,
        },
      });
      await using session = await agent.session();
      if (source === 'updated')
        await session.update({ modelSettings: { requestTransport: selected } });
      const turn = await session.submit('Return the label.');
      if (selected === 'http') {
        expect((await turn.wait()).finalOutput).toEqual({ label: 'fixed' });
        expect(wire).toEqual({ http: 2, upgrades: 0, generations: 2 });
      } else {
        await expect(turn.wait()).rejects.toThrow();
        expect(wire).toEqual({ http: 0, upgrades: 2, generations: 1 });
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
