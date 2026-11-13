import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';

it.each([
  {
    selector: 'websocket' as const,
    mode: 'frame-header',
    options: undefined,
    success: false,
  },
  {
    selector: 'http' as const,
    mode: 'upgrade426',
    options: undefined,
    success: true,
  },
  {
    selector: 'websocket' as const,
    mode: 'upgrade426',
    options: undefined,
    success: false,
  },
  {
    selector: 'websocket' as const,
    mode: 'no-pong',
    options: { pingIntervalMs: 20, pingTimeoutMs: 40 },
    success: false,
  },
  {
    selector: 'websocket' as const,
    mode: 'pong',
    options: { pingIntervalMs: 20, pingTimeoutMs: 40 },
    success: true,
  },
  {
    selector: 'websocket' as const,
    mode: 'no-pong',
    options: { pingIntervalMs: 20, pingTimeoutMs: null },
    success: true,
  },
  {
    selector: undefined,
    mode: 'pong',
    options: { pingIntervalMs: 20, pingTimeoutMs: 40 },
    success: true,
  },
  {
    selector: undefined,
    mode: 'no-pong',
    options: { pingIntervalMs: 20, pingTimeoutMs: 40 },
    success: false,
  },
  {
    selector: 'websocket' as const,
    mode: 'uncertain',
    options: undefined,
    success: false,
  },
])(
  'owns native WebSocket transport and keepalive (%o)',
  async ({ selector, mode, options, success }) => {
    const wire = { upgrades: 0, http: 0, frames: 0, pings: 0 };
    const item = {
      id: 'msg_controls',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'wire answer', annotations: [] }],
    };
    const response = {
      id: 'resp_controls',
      model: 'gpt-5.5',
      status: 'completed',
      output: [item],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const events = [
      {
        type: 'response.created',
        response: { ...response, status: 'in_progress', output: [] },
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    const server = createServer(async (request, reply) => {
      for await (const _chunk of request) {
        /* drain the complete HTTP request */
      }
      wire.http++;
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      );
    });
    const sockets = new WebSocketServer({ noServer: true, autoPong: false });
    server.on('upgrade', (request, socket, head) => {
      wire.upgrades++;
      if (mode === 'upgrade426')
        socket.end(
          'HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
      else
        sockets.handleUpgrade(request, socket, head, (ws) =>
          sockets.emit('connection', ws),
        );
    });
    sockets.on('connection', (socket) => {
      socket.on('ping', (data) => {
        wire.pings++;
        if (mode === 'pong') socket.pong(data);
      });
      socket.on('message', async (bytes) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.generate === false) {
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_warmup', output: [] },
            }),
          );
          return;
        }
        wire.frames++;
        if (mode === 'frame-header') {
          const header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt((16 << 20) + 1), 2);
          (
            socket as unknown as { _socket: { write(bytes: Buffer): void } }
          )._socket.write(header);
          return;
        }
        socket.send(JSON.stringify(events[0]));
        if (mode === 'uncertain') socket.close();
        else {
          await delay(150);
          if (socket.readyState === WebSocket.OPEN)
            for (const event of events.slice(1))
              socket.send(JSON.stringify(event));
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected loopback TCP');
    try {
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'synthetic-controls',
        supportsWebsockets: true,
        requestMaxRetries: selector === undefined ? 0 : 3,
        streamMaxRetries: selector === undefined ? 0 : 3,
        streamIdleTimeoutMs: mode === 'frame-header' ? 10000 : 1000,
        websocketOptions: options,
      });
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5.5',
        provider,
        ...(selector === undefined
          ? {}
          : { modelSettings: { requestTransport: selector } }),
      });
      const controller = new AbortController();
      const result = agent.run('hello', { signal: controller.signal });
      try {
        if (mode === 'frame-header') {
          const earlyError = await Promise.race([
            result.then(
              () => false,
              () => true,
            ),
            delay(2000).then(() => false),
          ]);
          expect(earlyError).toBe(true);
        } else if (success) {
          expect((await result).finalOutput).toBe('wire answer');
        } else await expect(result).rejects.toThrow();
      } finally {
        controller.abort();
        await result.catch(() => {});
      }
      if (selector === 'http')
        expect(wire).toMatchObject({ http: 1, upgrades: 0, frames: 0 });
      else {
        if (mode === 'upgrade426') {
          expect(wire.upgrades).toBeGreaterThanOrEqual(1);
          expect(wire.upgrades).toBeLessThanOrEqual(4);
        } else {
          expect(wire.upgrades).toBe(1);
        }
        expect(wire.http).toBe(0);
        expect(wire.frames).toBe(mode === 'upgrade426' ? 0 : 1);
        if (options) expect(wire.pings).toBeGreaterThan(0);
      }
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15_000,
);
