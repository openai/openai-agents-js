import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type NativeRealtimeAdapter,
  type NativeRealtimeAdapterContext,
} from '../src';
import { ModelServer } from './native/fixtures/model-server';

type Frame = Record<string, any>;
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

function merge(current: Frame, update: Frame) {
  for (const [key, value] of Object.entries(update)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    ) {
      merge(current[key], value);
    } else current[key] = structuredClone(value);
  }
}

nativeIt.each([false, true])(
  'runs native voice through custom I/O with exact routing and auth (translated model=%s)',
  async (translated) => {
    const model = new ModelServer([]);
    const server = new WebSocketServer({ noServer: true });
    const frames: Frame[] = [];
    const envelopes: Frame[] = [];
    const handshakes: {
      url: string | undefined;
      authorization: string | undefined;
      apiKey: string | string[] | undefined;
    }[] = [];
    let providerSocket: WebSocket | undefined;
    const encode = (frame: Frame) =>
      JSON.stringify(translated ? { modelMessage: frame } : frame);
    const decode = (raw: string): Frame => {
      const value = JSON.parse(raw);
      return translated ? value.modelMessage : value;
    };
    const send = (frame: Frame) => providerSocket!.send(encode(frame));
    model.onUpgrade((request, socket, head) => {
      handshakes.push({
        url: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers['api-key'],
      });
      server.handleUpgrade(request, socket, head, (connection) =>
        server.emit('connection', connection),
      );
    });
    server.on('connection', (connection) => {
      providerSocket = connection;
      const state: Frame = {};
      connection.on('message', (raw) => {
        envelopes.push(JSON.parse(raw.toString()));
        const frame = decode(raw.toString());
        frames.push(frame);
        if (frame.type === 'session.update') {
          merge(state, frame.session);
          send({
            type: 'session.updated',
            session: { ...structuredClone(state), id: 'custom-model-session' },
          });
        } else if (frame.type === 'response.create') {
          const id = `response-${frames.length}`;
          send({ type: 'response.created', response: { id } });
          send({
            type: 'response.output_audio_transcript.done',
            response_id: id,
            item_id: `answer-${id}`,
            transcript: 'Answer through the custom model.',
          });
          send({ type: 'response.done', response: { id } });
        }
      });
    });
    const contexts: NativeRealtimeAdapterContext[] = [];
    let closes = 0;
    const adapter: NativeRealtimeAdapter = {
      async connect(context) {
        contexts.push(context);
        const url = new URL(context.url);
        url.pathname = '/custom/voice';
        url.search = '?tenant=fixture&route=exact';
        const headers: Record<string, string> = {
          ...context.headers,
          'api-key': 'synthetic-custom-auth',
        };
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === 'authorization') delete headers[key];
        context.signal.throwIfAborted();
        const socket = new WebSocket(url, { headers });
        const stream = createWebSocketStream(socket, {
          encoding: 'utf8',
          readableObjectMode: true,
        });
        const abort = () => socket.terminate();
        context.signal.addEventListener('abort', abort, { once: true });
        try {
          await once(socket, 'open');
        } catch (error) {
          socket.terminate();
          stream.destroy();
          throw error;
        } finally {
          context.signal.removeEventListener('abort', abort);
        }
        return {
          incoming: (async function* () {
            for await (const raw of stream)
              yield JSON.stringify(decode(String(raw)));
          })(),
          send(frame) {
            return new Promise<void>((resolve, reject) => {
              socket.send(encode(JSON.parse(frame)), (error) =>
                error ? reject(error) : resolve(),
              );
            });
          },
          async close() {
            closes++;
            if (socket.readyState === WebSocket.CLOSED) return;
            const closed = once(socket, 'close');
            socket.close();
            await closed;
          },
        };
      },
    };
    const calls: string[] = [];
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      execute: ({ key }) => {
        calls.push(key);
        return 'native tool result';
      },
    });
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-parent-auth',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Use lookup.',
        tools: [lookup],
        provider,
      }).session();
      const voice = await session.realtime({ model: 'custom-model', adapter });
      try {
        expect(contexts).toHaveLength(1);
        expect(contexts[0].model).toBe('custom-model');
        expect(handshakes).toEqual([
          {
            url: '/custom/voice?tenant=fixture&route=exact',
            authorization: undefined,
            apiKey: 'synthetic-custom-auth',
          },
        ]);
        expect(
          frames
            .find((frame) => frame.type === 'session.update')
            ?.session.tools.some((entry: Frame) => entry.name === 'lookup'),
        ).toBe(true);
        await voice.update({ instructions: 'Keep the custom connection.' });
        expect(
          frames.filter((frame) => frame.type === 'session.update').at(-1)
            ?.session.instructions,
        ).toBe('Keep the custom connection.');
        await voice.sendAudio({
          data: new Uint8Array([0, 0, 1, 0]),
          format: 'pcm16',
        });
        await vi.waitFor(() =>
          expect(
            frames.some((frame) => frame.type === 'input_audio_buffer.append'),
          ).toBe(true),
        );
        const item = {
          type: 'function_call',
          id: 'tool-item',
          call_id: 'tool-call',
          name: 'lookup',
          arguments: '{"key":"record"}',
        };
        send({ type: 'response.created', response: { id: 'tool-response' } });
        send({
          type: 'response.output_item.done',
          response_id: 'tool-response',
          item,
        });
        send({
          type: 'response.done',
          response: { id: 'tool-response', output: [item] },
        });
        await vi.waitFor(
          () =>
            expect(
              frames.find((frame) => frame.item?.call_id === 'tool-call')?.item
                .output,
            ).toContain('native tool result'),
          { timeout: 10000 },
        );
        await vi.waitFor(
          () =>
            expect(JSON.stringify(voice.history)).toContain(
              'Answer through the custom model.',
            ),
          { timeout: 10000 },
        );
        expect(calls).toEqual(['record']);
        expect(model.requests).toHaveLength(0);
        expect(
          envelopes.every((frame) =>
            translated ? !!frame.modelMessage && !frame.type : !!frame.type,
          ),
        ).toBe(true);
      } finally {
        await voice.close();
      }
      expect(closes).toBe(1);
      expect(server.clients.size).toBe(0);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ModelServer.closeAll();
    }
  },
  30000,
);
