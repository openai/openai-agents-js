import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import { Agent, NativeProvider, tool } from '../src';
import { ModelServer, call, message } from './native/fixtures/model-server';

// The independent provider speaks actual Realtime and Responses protocols;
// Session, its sole event reader, the binding and Core all execute normally.
function peer(model: ModelServer) {
  const server = new WebSocketServer({ noServer: true });
  let socket: WebSocket | undefined;
  let closing: Promise<void> | undefined;
  const frames: any[] = [];
  const upgrades: { url: string; headers: IncomingHttpHeaders }[] = [];
  model.onUpgrade((request, transport, head) => {
    upgrades.push({ url: request.url ?? '', headers: { ...request.headers } });
    server.handleUpgrade(request, transport, head, (connection) =>
      server.emit('connection', connection, request),
    );
  });
  server.on('connection', (connection) => {
    socket = connection;
    const accepted: Record<string, any> = {};
    const merge = (
      current: Record<string, any>,
      update: Record<string, any>,
    ) => {
      for (const [key, value] of Object.entries(update)) {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          current[key] &&
          typeof current[key] === 'object' &&
          !Array.isArray(current[key])
        )
          merge(current[key], value);
        else current[key] = structuredClone(value);
      }
    };
    connection.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === 'session.update') {
        merge(accepted, frame.session);
        send({
          type: 'session.updated',
          session: { ...structuredClone(accepted), id: 'fixture-session' },
        });
      }
      if (frame.type === 'response.create') {
        const id = `response-${frames.length}`;
        send({ type: 'response.created', response: { id } });
        if (
          frames.some(
            (prior) =>
              prior.type === 'conversation.item.create' &&
              prior.item?.type === 'function_call_output',
          )
        ) {
          send({
            type: 'response.output_audio_transcript.delta',
            response_id: id,
            item_id: 'frontend-answer',
            delta: 'Spoken frontend answer.',
          });
          send({
            type: 'response.output_audio_transcript.done',
            response_id: id,
            item_id: 'frontend-answer',
            transcript: 'Spoken frontend answer.',
          });
        }
        send({ type: 'response.done', response: { id } });
      }
    });
  });
  function send(frame: unknown) {
    if (!socket) throw new Error('provider not connected');
    socket.send(JSON.stringify(frame));
  }
  return {
    frames,
    upgrades,
    send,
    async connected() {
      await vi.waitFor(
        () =>
          expect(frames.some((frame) => frame.type === 'session.update')).toBe(
            true,
          ),
        { timeout: 10000 },
      );
    },
    handoff(text: string, id = 'handoff-1') {
      const responseId = `frontend-${id}`;
      const item = {
        id: `item-${id}`,
        type: 'function_call',
        name: 'background_agent',
        call_id: id,
        arguments: JSON.stringify({ input_transcript: text }),
      };
      send({ type: 'response.created', response: { id: responseId } });
      send({ type: 'conversation.item.done', item });
      send({
        type: 'response.done',
        response: { id: responseId, output: [item] },
      });
    },
    async output(id = 'handoff-1') {
      let output: any;
      await vi.waitFor(
        () => {
          output = frames.find(
            (frame) =>
              frame.type === 'conversation.item.create' &&
              frame.item?.type === 'function_call_output' &&
              frame.item.call_id === id,
          );
          expect(output).toBeDefined();
        },
        { timeout: 10000 },
      );
      return output.item.output as string;
    },
    close() {
      return (closing ??= (async () => {
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })());
    },
  };
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
nativeIt(
  'delegates through real native tools and accepted repair, keeps canonical history and caller Session usable',
  async () => {
    const calls: string[] = [];
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      execute: ({ key }) => {
        calls.push(key);
        return 'record-found';
      },
    });
    const model = new ModelServer([
      [call('lookup', { key: 'record' }, { callId: 'lookup-1' })],
      [message(JSON.stringify('UNACCEPTED_NATIVE_MARKER'))],
      [message(JSON.stringify('ACCEPTED_NATIVE_MARKER'))],
      [message(JSON.stringify('after voice'))],
    ]);
    const realtime = peer(model);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-native-voice',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Use lookup and answer.',
        tools: [lookup],
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent
        .withOutputType({
          mode: 'prompted',
          schema: z.string().refine((text) => !text.includes('UNACCEPTED')),
          maxRetries: 1,
        })
        .session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        voice: 'marin',
      });
      try {
        await realtime.connected();
        expect(realtime.upgrades[0].url).toContain('/v1/realtime');
        expect(realtime.upgrades[0].headers.authorization).toBe(
          'Bearer synthetic-native-voice',
        );
        expect(
          realtime.upgrades[0].headers['x-sdk-sentinel-grant'],
        ).toBeUndefined();
        await voice.sendText('voice input');
        realtime.handoff('Read record.');
        const output = await realtime.output();
        expect(output).toContain('ACCEPTED_NATIVE_MARKER');
        expect(JSON.stringify(realtime.frames)).not.toContain(
          'UNACCEPTED_NATIVE_MARKER',
        );
        expect(calls).toEqual(['record']);
        await vi.waitFor(
          () =>
            expect(JSON.stringify(voice.history)).toContain(
              'Spoken frontend answer.',
            ),
          { timeout: 10000 },
        );
      } finally {
        await voice.close();
      }
      expect(JSON.stringify(voice.history)).toContain(
        'Spoken frontend answer.',
      );
      const editor = vi.fn(() => undefined);
      expect(
        (
          await (
            await session.submit('continue', { prepareRequest: editor })
          ).wait()
        ).finalOutput,
      ).toBe('after voice');
      expect(editor).toHaveBeenCalledOnce();
      expect(
        model.requestHeaders.every(
          (headers) => headers['x-sdk-sentinel-grant'] === undefined,
        ),
      ).toBe(true);
      model.assertExhausted();
    } finally {
      await realtime.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'remote disconnect joins exact pending native tool cancellation without ending the caller Session',
  async () => {
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const wait = tool({
      name: 'wait_for_cancel',
      parameters: z.object({}),
      execute: async (_args, { signal }) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            cancelled.resolve();
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        return 'LATE_PRIVATE_TOOL_OUTPUT';
      },
    });
    const model = new ModelServer([
      [call('wait_for_cancel', {}, { callId: 'pending-tool' })],
      [message('Caller remains open.')],
    ]);
    const realtime = peer(model);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-native-disconnect',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Wait.',
        tools: [wait],
        model: 'gpt-5.5',
        provider,
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const events = (async () => {
        for await (const _event of voice.events()) {
          /* transport failure belongs to this consumer */
        }
      })();
      void events.catch(() => {});
      await realtime.connected();
      realtime.handoff('Wait until stopped.');
      await entered.promise;
      await realtime.close();
      await cancelled.promise;
      await expect(events).rejects.toThrow();
      await voice.close();
      expect(JSON.stringify(realtime.frames)).not.toContain(
        'LATE_PRIVATE_TOOL_OUTPUT',
      );
      expect(
        (await (await session.submit('continue')).wait()).finalOutput,
      ).toBe('Caller remains open.');
      model.assertExhausted();
    } finally {
      await realtime.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);
