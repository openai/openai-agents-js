import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type NativeRealtimeEvent,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';

type Frame = Record<string, any>;
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-capability-contract',
    supportsWebsockets: false,
  });
}

nativeIt.each(['billing', 'support'] as const)(
  'offers two native destinations and transfers control to the selected %s Agent',
  async (selected) => {
    const effects: string[] = [];
    const model = new ModelServer([
      (request) => {
        expect(request.model).toBe('gpt-5.5');
        const wire = JSON.stringify(request);
        expect(wire).toContain('transfer_to_billing');
        expect(wire).toContain('transfer_to_support');
        return [call(`transfer_to_${selected}`, {}, { callId: 'route' })];
      },
      (request) => {
        expect(JSON.stringify(request)).toContain(
          `Only ${selected} owns the next answer.`,
        );
        return [call(`${selected}_lookup`, {}, { callId: 'destination' })];
      },
      (request) => {
        expect(JSON.stringify(request)).toContain(`${selected} result`);
        expect(JSON.stringify(request)).toContain('destination');
        return [message(`${selected} answered`)];
      },
      (request) => {
        expect(JSON.stringify(request)).toContain(
          `Only ${selected} owns the next answer.`,
        );
        return [message(`${selected} still owns the conversation`)];
      },
    ]);
    try {
      await using provider = await providerFor(model);
      const destinations = ['billing', 'support'].map(
        (name) =>
          new Agent({
            name,
            instructions: `Only ${name} owns the next answer.`,
            tools: [
              tool({
                name: `${name}_lookup`,
                parameters: z.object({}),
                execute: () => {
                  effects.push(name);
                  return `${name} result`;
                },
              }),
            ],
          }),
      );
      await using session = await new Agent({
        name: 'router',
        instructions: 'Select billing or support.',
        handoffs: destinations,
        provider,
        model: 'gpt-5.5',
      }).session();
      expect(
        (await (await session.submit(`Use ${selected}.`)).wait()).finalOutput,
      ).toBe(`${selected} answered`);
      expect(await session.getActiveAgent()).toBe(
        destinations.find((agent) => agent.name === selected),
      );
      expect(effects).toEqual([selected]);
      expect(
        (await (await session.submit('Who owns the next turn?')).wait())
          .finalOutput,
      ).toBe(`${selected} still owns the conversation`);
      expect(model.requestHeaders[0].authorization).toBe(
        'Bearer synthetic-capability-contract',
      );
      model.assertExhausted();
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);

// Script only the external provider protocol; native Session and Core execute.
function audioPeer(model: ModelServer) {
  const server = new WebSocketServer({ noServer: true });
  const frames: Frame[] = [];
  let socket: WebSocket | undefined;
  let responseCount = 0;
  const outputs = [Buffer.alloc(4800, 1), Buffer.alloc(4800, 2)];
  const send = (frame: Frame) => {
    if (!socket) throw new Error('Provider is not connected');
    socket.send(JSON.stringify(frame));
  };
  model.onUpgrade((request, transport, head) => {
    server.handleUpgrade(request, transport, head, (connection) =>
      server.emit('connection', connection, request),
    );
  });
  server.on('connection', (connection, request) => {
    socket = connection;
    let accepted: Frame = {
      model: new URL(request.url ?? '/', 'http://fixture').searchParams.get(
        'model',
      ),
    };
    connection.on('message', (raw) => {
      const frame: Frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === 'session.update') {
        accepted = { ...accepted, ...frame.session };
        send({
          type: 'session.updated',
          session: { ...accepted, id: 'capability-audio-session' },
        });
      } else if (frame.type === 'response.create') {
        const index = responseCount++;
        const id = `audio-response-${index + 1}`;
        send({ type: 'response.created', response: { id } });
        if (outputs[index])
          send({
            type: 'response.output_audio.delta',
            response_id: id,
            item_id: `audio-item-${index + 1}`,
            content_index: 0,
            output_index: 0,
            delta: outputs[index].toString('base64'),
          });
        // Keep the first response actively streaming until the caller interrupts.
        if (index > 0)
          send({ type: 'response.done', response: { id, output: [] } });
      } else if (frame.type === 'response.cancel') {
        send({
          type: 'response.done',
          response: { id: 'audio-response-1', status: 'cancelled', output: [] },
        });
      }
    });
  });
  return {
    frames,
    outputs,
    send,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

nativeIt(
  'keeps two audio inference turns, speech interruption and correlated native tools on one voice Session',
  async () => {
    const model = new ModelServer([]);
    const peer = audioPeer(model);
    const effects: string[] = [];
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Answer audio input and use the lookup tool.',
        provider,
        tools: [
          tool({
            name: 'voice_lookup',
            parameters: z.object({ key: z.string() }),
            execute: ({ key }) => {
              effects.push(key);
              return `found:${key}`;
            },
          }),
        ],
      }).session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        settings: { turnDetection: null },
      });
      const observed: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) observed.push(event);
      })();
      void reading.catch(() => {});
      try {
        const inputs = [
          new Uint8Array([1, 0, 2, 0]),
          new Uint8Array([3, 0, 4, 0]),
        ];
        await voice.sendAudio(
          { format: 'pcm16', data: inputs[0] },
          { commit: true },
        );
        await voice.requestResponse();
        await vi.waitFor(() =>
          expect(
            observed.some(
              (event) =>
                event.type === 'audio' &&
                event.responseId === 'audio-response-1',
            ),
          ).toBe(true),
        );
        await voice.interrupt('audio-response-1', {
          playback: {
            responseId: 'audio-response-1',
            itemId: 'audio-item-1',
            contentIndex: 0,
            audioEndMs: 20,
          },
        });
        await vi.waitFor(() => {
          expect(
            peer.frames.some((frame) => frame.type === 'response.cancel'),
          ).toBe(true);
          expect(peer.frames).toContainEqual(
            expect.objectContaining({
              type: 'conversation.item.truncate',
              item_id: 'audio-item-1',
              content_index: 0,
              audio_end_ms: 20,
            }),
          );
        });
        await voice.sendAudio(
          { format: 'pcm16', data: inputs[1] },
          { commit: true },
        );
        await voice.requestResponse();
        await vi.waitFor(() =>
          expect(
            observed.some(
              (event) =>
                event.type === 'response' &&
                event.responseId === 'audio-response-2' &&
                event.status === 'done',
            ),
          ).toBe(true),
        );
        expect(
          peer.frames
            .filter((frame) => frame.type === 'input_audio_buffer.append')
            .map((frame) => frame.audio),
        ).toEqual(inputs.map((input) => Buffer.from(input).toString('base64')));
        expect(
          peer.frames.filter(
            (frame) => frame.type === 'input_audio_buffer.commit',
          ),
        ).toHaveLength(2);
        for (const [index, expected] of peer.outputs.entries()) {
          const received = observed.filter(
            (event): event is Extract<NativeRealtimeEvent, { type: 'audio' }> =>
              event.type === 'audio' &&
              event.responseId === `audio-response-${index + 1}`,
          );
          expect(Buffer.concat(received.map((event) => event.data))).toEqual(
            expected,
          );
        }
        expect(observed).toContainEqual(
          expect.objectContaining({
            type: 'playback_interrupted',
            retiredResponseIds: expect.arrayContaining(['audio-response-1']),
          }),
        );
        const item = {
          id: 'voice-call-item-1',
          ...call(
            'voice_lookup',
            { key: 'record' },
            { callId: 'voice-call-1' },
          ),
        };
        peer.send({
          type: 'response.created',
          response: { id: 'tool-response' },
        });
        peer.send({
          type: 'response.output_item.done',
          response_id: 'tool-response',
          output_index: 0,
          item,
        });
        peer.send({
          type: 'response.done',
          response: { id: 'tool-response', output: [item] },
        });
        await vi.waitFor(
          () => {
            expect(effects).toEqual(['record']);
            expect(peer.frames).toContainEqual(
              expect.objectContaining({
                type: 'conversation.item.create',
                item: expect.objectContaining({
                  type: 'function_call_output',
                  call_id: 'voice-call-1',
                  output: 'found:record',
                }),
              }),
            );
          },
          { timeout: 10000 },
        );
        expect(model.requests).toEqual([]);
        model.assertExhausted();
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);
