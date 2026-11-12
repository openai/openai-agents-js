import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { call, message, ModelServer } from './fixtures/model-server';

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'independent native Responses WebSocket endpoint',
  () => {
    it.each(['plain', 'session'] as const)(
      'keeps HTTP and WebSocket traffic on separate origins for a %s run',
      async (mode) => {
        const http = new ModelServer([[message('http answer')]]);
        const websocket = new ModelServer([]);
        const sockets = new WebSocketServer({ noServer: true });
        const httpPaths: string[] = [];
        const upgrades: Array<{
          path: string | undefined;
          authorization: string | undefined;
        }> = [];
        const sampled: Array<{ input?: unknown }> = [];
        let warmups = 0;
        http.onRecord = (phase, detail) => {
          if (phase === 'MODEL_REQUEST')
            httpPaths.push((detail as { path: string }).path);
        };
        websocket.onUpgrade((request, socket, head) => {
          upgrades.push({
            path: request.url,
            authorization: request.headers.authorization,
          });
          sockets.handleUpgrade(request, socket, head, (connection) => {
            connection.on('message', (raw) => {
              const request = JSON.parse(raw.toString()) as {
                generate?: boolean;
                input?: unknown;
              };
              const warmup = request.generate === false;
              if (!warmup) sampled.push(request);
              const id = warmup
                ? `warmup-${++warmups}`
                : `sample-${sampled.length}`;
              const send = (frame: object) =>
                connection.send(JSON.stringify(frame));
              send({ type: 'response.created', response: { id } });
              if (!warmup)
                send({
                  type: 'response.output_item.done',
                  output_index: 0,
                  item:
                    sampled.length === 1
                      ? call('lookup', {}, { callId: 'separate-origin-call' })
                      : message('websocket answer'),
                });
              send({ type: 'response.completed', response: { id } });
            });
          });
        });

        try {
          const baseUrl = `http://127.0.0.1:${await http.port()}/http-root?route=http`;
          const websocketBaseUrl = `ws://127.0.0.1:${await websocket.port()}/ws-root?route=websocket`;
          const instructions = 'Answer with the provider response.';
          const model = 'gpt-5';
          await using httpProvider = new NativeProvider({
            baseUrl,
            websocketBaseUrl,
            supportsWebsockets: false,
            apiKey: 'synthetic-http',
          });
          const httpAgent = new Agent({
            instructions,
            model,
            provider: httpProvider,
          });
          expect((await httpAgent.run('Use HTTP')).finalOutput).toBe(
            'http answer',
          );
          expect(upgrades).toEqual([]);

          let executions = 0;
          const lookup = tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => {
              executions++;
              return 'separate-origin-tool-result';
            },
          });
          await using provider = new NativeProvider({
            baseUrl,
            websocketBaseUrl,
            supportsWebsockets: true,
            apiKey: 'synthetic-websocket',
          });
          const agent = new Agent({
            instructions,
            model,
            provider,
            tools: [lookup],
          });
          await using session =
            mode === 'session' ? await agent.session() : undefined;
          const result = session
            ? await (await session.submit('Use WebSocket')).wait()
            : await agent.run('Use WebSocket');
          expect(result.finalOutput).toBe('websocket answer');
          expect(executions).toBe(1);
          expect(sampled).toHaveLength(2);
          expect(JSON.stringify(sampled[1]?.input)).toContain(
            'separate-origin-tool-result',
          );
          expect(upgrades.length).toBeGreaterThan(0);
          for (const upgrade of upgrades)
            expect(upgrade).toEqual({
              path: '/ws-root/responses?route=websocket',
              authorization: 'Bearer synthetic-websocket',
            });
          expect(httpPaths).toEqual(['/http-root/responses?route=http']);
          expect(
            http.requestHeaders.map((headers) => headers.authorization),
          ).toEqual(['Bearer synthetic-http']);
          http.assertExhausted();
          websocket.assertExhausted();
        } finally {
          for (const socket of sockets.clients) socket.terminate();
          sockets.close();
          await ModelServer.closeAll();
        }
      },
      15_000,
    );

    it.each([
      {
        title: 'falls back to the HTTP origin for an unsupported upgrade',
        status: 426,
        fallback: true,
      },
      {
        title: 'preserves overload without rerouting to the HTTP origin',
        status: 503,
        fallback: false,
      },
    ])(
      '$title',
      async ({ status, fallback }) => {
        const http = new ModelServer(
          fallback ? [[message('http fallback')]] : [],
        );
        const websocket = new ModelServer([]);
        const upgrades: string[] = [];
        websocket.onUpgrade((request, socket) => {
          upgrades.push(request.url ?? '');
          const body = JSON.stringify({
            error: { code: 'server_is_overloaded', message: 'retry later' },
          });
          socket.end(
            `HTTP/1.1 ${status} Rejected\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        });
        try {
          await using provider = new NativeProvider({
            baseUrl: `http://127.0.0.1:${await http.port()}/http-root`,
            websocketBaseUrl: `http://127.0.0.1:${await websocket.port()}/ws-root?route=websocket`,
            supportsWebsockets: true,
            streamMaxRetries: 0,
            apiKey: 'synthetic-fallback',
          });
          const agent = new Agent({
            instructions: 'Answer with the provider response.',
            model: 'gpt-5',
            provider,
          });
          if (fallback) {
            expect((await agent.run('Use the fallback')).finalOutput).toBe(
              'http fallback',
            );
          } else {
            await expect(agent.run('Preserve overload')).rejects.toMatchObject({
              category: 'server_overloaded',
            });
          }
          expect(upgrades).toEqual(['/ws-root/responses?route=websocket']);
          expect(
            http.requestHeaders.map((headers) => headers.authorization),
          ).toEqual(fallback ? ['Bearer synthetic-fallback'] : []);
          http.assertExhausted();
          websocket.assertExhausted();
        } finally {
          await ModelServer.closeAll();
        }
      },
      15_000,
    );
  },
);
