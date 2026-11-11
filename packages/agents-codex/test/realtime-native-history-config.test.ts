import { crc32, deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  realtimeHandoff,
  tool,
  type NativeRealtimeEvent,
} from '../src';
import type { JsonObject } from '../src/runtime/binding';
import { ModelServer, call, message } from './native/fixtures/model-server';

type Frame = Record<string, any>;

function mergeSession(current: Frame, update: Frame) {
  for (const [key, value] of Object.entries(update)) {
    if (
      key !== 'turn_detection' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    )
      mergeSession(current[key], value);
    else current[key] = structuredClone(value);
  }
}

const PNG_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';

// One-bit grayscale keeps fixture construction near 2 MiB; decoding expands
// each pixel to one byte.
function solidPngImage(side: number): string {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 1;
  const scanlines = Buffer.alloc((Math.ceil(side / 8) + 1) * side);
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')}`;
}

// Only the independent provider protocol is scripted; public Session, binding,
// native configuration, reconciliation, and generation ownership execute normally.
class HistoryPeer {
  readonly frames: Frame[] = [];
  readonly models: (string | null)[] = [];
  readonly retrievals = new Map<string, JsonObject>();
  autoAckUpdates = true;
  readonly pendingUpdates: Frame[] = [];
  private socket?: WebSocket;
  private readonly server = new WebSocketServer({ noServer: true });
  constructor(model: ModelServer) {
    model.onUpgrade((request, transport, head) => {
      this.models.push(
        new URL(request.url!, 'http://fixture').searchParams.get('model'),
      );
      this.server.handleUpgrade(request, transport, head, (socket) =>
        this.server.emit('connection', socket),
      );
    });
    this.server.on('connection', (socket) => {
      this.socket = socket;
      const session: Frame = { model: this.models.at(-1) };
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        this.frames.push(frame);
        if (
          frame.type === 'conversation.item.retrieve' &&
          this.retrievals.has(frame.item_id)
        )
          this.send({
            type: 'conversation.item.retrieved',
            item: this.retrievals.get(frame.item_id)!,
          });
        if (frame.type === 'session.update') {
          mergeSession(session, frame.session);
          const acknowledgement = {
            type: 'session.updated',
            session: { ...structuredClone(session), id: 'history-fixture' },
          };
          if (this.autoAckUpdates) this.send(acknowledgement);
          else this.pendingUpdates.push(acknowledgement);
        }
      });
    });
  }
  send(frame: Frame) {
    if (!this.socket) throw new Error('Provider is not connected');
    this.socket.send(JSON.stringify(frame));
  }
  async frame(type: string, after = 0): Promise<Frame> {
    let found: Frame | undefined;
    await vi.waitFor(
      () => {
        found = this.frames.slice(after).find((frame) => frame.type === type);
        expect(found).toBeDefined();
      },
      { timeout: 10000 },
    );
    return found!;
  }
  async close() {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history-config',
    supportsWebsockets: false,
  });
}
function userItem(id: string, text: string): JsonObject {
  return {
    id,
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}
async function observe(
  peer: HistoryPeer,
  seen: NativeRealtimeEvent[],
  item: JsonObject,
) {
  let previousItemId: string | null = null;
  for (const event of seen)
    if (event.type === 'conversation_item' && event.status === 'done')
      previousItemId = event.itemId;
  peer.send({
    type: 'conversation.item.added',
    previous_item_id: previousItemId,
    item: { ...item, status: 'completed' },
  });
  peer.send({
    type: 'conversation.item.done',
    item: { ...item, status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(
      seen.some(
        (event) =>
          event.type === 'conversation_item' &&
          event.itemId === item.id &&
          event.status === 'done',
      ),
    ).toBe(true),
  );
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt.each(['model', 'instructions', 'tools'] as const)(
  'preserves borrowed backend %s controls after an accepted voice Agent graph',
  async (control) => {
    const calls: string[] = [];
    const original = tool({
      name: 'backend',
      parameters: z.object({}),
      execute: () => {
        calls.push('original');
        return 'original';
      },
    });
    const replacement = tool({
      name: 'backend',
      parameters: z.object({}),
      execute: () => {
        calls.push('replacement');
        return 'replacement';
      },
    });
    const model = new ModelServer(
      control === 'tools'
        ? [
            [call('backend', {}, { callId: 'backend-call' })],
            [message('backend complete')],
          ]
        : [[message('backend complete')]],
    );
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const opening = new Agent({
        provider,
        instructions: 'Backend source',
        tools: [original],
      });
      await using session = await opening.session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const voiceExecute = vi.fn(() => 'retained voice result');
      const target = new Agent({
        provider,
        tools: [
          tool({
            name: 'voice_lookup',
            parameters: z.object({}),
            execute: voiceExecute,
          }),
        ],
        name: 'Voice target',
        instructions: 'Voice base',
        realtime: { instructions: 'Voice-only instructions' },
      });
      await voice.updateAgent(target);
      if (control === 'model')
        await session.update({ model: 'fixture-backend-updated' });
      if (control === 'instructions')
        await session.update({ instructions: 'Updated backend source' });
      if (control === 'tools') {
        await session.update({ tools: [replacement] });
        await session.update({ tools: [replacement] });
      }
      expect(await voice.getActiveAgent()).toBe(target);
      expect(await session.getActiveAgent()).toBe(opening);
      expect(
        peer.frames.filter((frame) => frame.type === 'session.update').at(-1)
          ?.session.instructions,
      ).toBe('Voice-only instructions');
      peer.send({
        type: 'response.created',
        response: { id: 'retained-voice' },
      });
      const retainedCall = {
        type: 'function_call',
        id: 'retained-voice-item',
        call_id: 'retained-voice-call',
        name: 'voice_lookup',
        arguments: '{}',
        status: 'completed',
      };
      peer.send({
        type: 'response.output_item.done',
        response_id: 'retained-voice',
        output_index: 0,
        item: retainedCall,
      });
      peer.send({
        type: 'response.done',
        response: {
          id: 'retained-voice',
          status: 'completed',
          output: [retainedCall],
        },
      });
      await vi.waitFor(() => expect(voiceExecute).toHaveBeenCalledOnce(), {
        timeout: 10000,
      });
      await peer.frame('conversation.item.create');
      await voice.close();
      expect(
        (await (await session.submit('Continue the backend')).wait())
          .finalOutput,
      ).toBe('backend complete');
      if (control === 'model')
        expect(model.requests[0]?.model).toBe('fixture-backend-updated');
      if (control === 'instructions')
        expect(JSON.stringify(model.requests[0]?.input)).toContain(
          'Updated backend source',
        );
      if (control === 'tools') expect(calls).toEqual(['replacement']);
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  35_000,
);

nativeIt.each([
  'callback',
  'MCP initialization',
  'concurrent MCP initialization',
] as const)(
  'preserves backend tool replacement after rejected voice Agent graphs (%s)',
  async (rejection) => {
    const original = tool({
      name: 'backend',
      parameters: z.object({}),
      execute: () => 'original',
    });
    const execute = vi.fn(() => 'replacement');
    const replacement = tool({
      name: 'backend',
      parameters: z.object({}),
      execute,
    });
    const model = new ModelServer([
      [call('backend', {}, { callId: 'backend-after-rejections' })],
      [message('done')],
    ]);
    const peer = new HistoryPeer(model);
    let requests = 0;
    const initializing = Promise.withResolvers<void>();
    const releaseInitialization = Promise.withResolvers<void>();
    const unauthorized = createServer(async (_, response) => {
      requests++;
      initializing.resolve();
      if (rejection === 'concurrent MCP initialization')
        await releaseInitialization.promise;
      response.writeHead(401).end();
    });
    unauthorized.listen(0, '127.0.0.1');
    await once(unauthorized, 'listening');
    const address = unauthorized.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP fixture');
    try {
      await using provider = await providerFor(model);
      const opening = new Agent({
        provider,
        instructions: 'Backend source',
        tools: [original],
      });
      await using session = await opening.session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const rejected = new Agent({
        provider,
        instructions: 'Rejected voice',
        realtime: {
          instructions: () => {
            throw new Error('voice callback rejected');
          },
        },
      });
      const failed =
        rejection === 'callback'
          ? rejected
          : new Agent({
              provider,
              instructions: 'Failed native preparation',
              tools: [
                new HttpMCP({
                  name: 'unauthorized',
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  tools: ['lookup'],
                  approvalMode: 'preapproved',
                }),
              ],
            });
      if (rejection === 'concurrent MCP initialization') {
        const admission = expect(voice.updateAgent(failed)).rejects.toThrow();
        await initializing.promise;
        let settled = false;
        const backend = session.update({ tools: [replacement] }).finally(() => {
          settled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        releaseInitialization.resolve();
        await admission;
        await backend;
      } else {
        for (let attempt = 0; attempt < 3; attempt++)
          await expect(voice.updateAgent(failed)).rejects.toThrow(
            rejection === 'callback' ? 'voice callback rejected' : undefined,
          );
      }
      if (rejection !== 'callback') expect(requests).toBeGreaterThan(0);
      await session.update({ tools: [replacement] });
      await session.update({ tools: [replacement] });
      expect(await session.getActiveAgent()).toBe(opening);
      await voice.close();
      expect(
        (await (await session.submit('Continue the backend')).wait())
          .finalOutput,
      ).toBe('done');
      expect(execute).toHaveBeenCalledOnce();
      model.assertExhausted();
    } finally {
      releaseInitialization.resolve();
      unauthorized.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        unauthorized.close((error) => (error ? reject(error) : resolve())),
      );
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  35_000,
);

nativeIt.each([
  'instructions',
  'tool',
  'handoff',
  'connection instructions',
  'connection tool',
] as const)(
  'closes while an Agent %s configuration callback remains pending',
  async (callback) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string | boolean>();
    const pending = () => {
      entered.resolve();
      return release.promise;
    };
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Opening',
      }).session();
      let stalling = false;
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        instructions:
          callback === 'connection instructions'
            ? () =>
                stalling ? (pending() as Promise<string>) : 'Opening voice'
            : undefined,
        isToolEnabled:
          callback === 'connection tool'
            ? (pending as () => Promise<boolean>)
            : undefined,
      });
      stalling = true;
      const target = new Agent({
        provider,
        instructions: 'Target',
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => 'unused',
          }),
        ],
        realtime:
          callback === 'instructions'
            ? { instructions: pending as () => Promise<string> }
            : callback === 'tool'
              ? { toolEnabled: pending as () => Promise<boolean> }
              : undefined,
        handoffs:
          callback === 'handoff'
            ? [
                realtimeHandoff(
                  new Agent({
                    provider,
                    name: 'Support',
                    instructions: 'Support',
                  }),
                  {
                    name: 'support',
                    isEnabled: pending as () => Promise<boolean>,
                  },
                ),
              ]
            : [],
      });
      const updating = voice.updateAgent(target);
      void updating.catch(() => {});
      await entered.promise;
      const before = peer.frames.filter(
        (frame) => frame.type === 'session.update',
      ).length;
      let closed = false;
      const closing = voice.close().then(() => {
        closed = true;
      });
      try {
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
        await expect(updating).rejects.toThrow();
        if (callback === 'handoff')
          release.reject(new Error('late configuration failure'));
        else
          release.resolve(
            callback === 'instructions' ? 'late instructions' : true,
          );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          peer.frames.filter((frame) => frame.type === 'session.update'),
        ).toHaveLength(before);
        await closing;
      } finally {
        release.resolve(true);
        await closing.catch(() => {});
        await updating.catch(() => {});
      }
    } finally {
      release.resolve(true);
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'reclaims unpublished Agent graphs after repeated callback failures while preserving accepted response sources',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const execute = vi.fn(() => 'accepted result');
      const opening = new Agent({
        provider,
        name: 'Opening',
        instructions: 'Opening',
      });
      const accepted = new Agent({
        provider,
        name: 'Accepted',
        instructions: 'Accepted',
        tools: [tool({ name: 'lookup', parameters: z.object({}), execute })],
      });
      const rejected = new Agent({
        provider,
        name: 'Rejected',
        instructions: 'Rejected',
        tools: [
          tool({
            name: 'rejected_tool',
            parameters: z.object({}),
            execute: () => 'unreachable',
          }),
        ],
        realtime: {
          instructions: () => {
            throw new Error('candidate callback failed');
          },
        },
      });
      await using session = await opening.session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        await voice.updateAgent(accepted);
        const stores = [
          'voiceProfileGraphs',
          'profileCatalogs',
          'profileMcp',
          'profileStepMcp',
        ] as const;
        const footprint = () =>
          Object.fromEntries(
            stores.map((name) => [
              name,
              (session as unknown as Record<string, Map<unknown, unknown>>)[
                name
              ].size,
            ]),
          );
        const retained = footprint();
        const after = peer.frames.length;
        await voice.requestResponse();
        const create = await peer.frame('response.create', after);
        peer.send({
          type: 'response.created',
          response: {
            id: 'accepted-source',
            metadata: create.response?.metadata,
          },
        });
        // More than the native profile/source bound must remain recoverable.
        for (let attempt = 0; attempt < 1030; attempt++) {
          await expect(voice.updateAgent(rejected)).rejects.toThrow(
            'candidate callback failed',
          );
          expect(footprint()).toEqual(retained);
        }
        await expect(voice.getActiveAgent()).resolves.toBe(accepted);
        expect(
          peer.frames.filter((frame) => frame.type === 'session.update'),
        ).toHaveLength(2);
        const toolAfter = peer.frames.length;
        const item = {
          type: 'function_call',
          id: 'accepted-call-item',
          call_id: 'accepted-call',
          name: 'lookup',
          arguments: '{}',
          status: 'completed',
        };
        peer.send({
          type: 'response.output_item.done',
          response_id: 'accepted-source',
          output_index: 0,
          item,
        });
        peer.send({
          type: 'response.done',
          response: {
            id: 'accepted-source',
            status: 'completed',
            output: [item],
          },
        });
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), {
          timeout: 10000,
        });
        await peer.frame('response.create', toolAfter);
        const valid = new Agent({
          provider,
          name: 'Valid',
          instructions: 'Still updatable',
          realtime: { instructions: 'Still updatable' },
        });
        await voice.updateAgent(valid);
        await expect(voice.getActiveAgent()).resolves.toBe(valid);
        await expect(session.getActiveAgent()).resolves.toBe(opening);
        expect(
          peer.frames.filter((frame) => frame.type === 'session.update').at(-1)
            ?.session.instructions,
        ).toBe('Still updatable');
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  60000,
);
const defaultResponseCreate = {
  type: 'response.create',
  event_id: expect.any(String),
};
const generatedResponseMetadata = { codex_response_id: expect.any(String) };

nativeIt.each([
  { raw: false, prompt: null },
  { raw: false, prompt: { id: 'runtime-prompt' } },
  { raw: true, prompt: null },
  { raw: true, prompt: { id: 'runtime-prompt' } },
])(
  'retains acknowledged runtime instructions and prompt across agent changes (raw=$raw, prompt=$prompt)',
  async ({ raw, prompt }) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const first = new Agent({ provider, instructions: 'Opening backend' });
      const second = new Agent({
        provider,
        instructions: 'New backend',
        realtime: {
          instructions: 'New voice default',
          prompt: { id: 'agent-prompt' },
        },
      });
      const instructions = vi.fn(async () => 'Opening connection instructions');
      await using session = await first.session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        instructions,
        settings: { prompt: { id: 'opening-prompt' } },
      });
      peer.autoAckUpdates = false;
      const after = peer.frames.length;
      let accepted = false;
      const updating = (
        raw
          ? voice.sendEvent({
              type: 'session.update',
              session: {
                instructions: 'Accepted runtime instructions',
                prompt,
              },
            })
          : voice.update({
              instructions: 'Accepted runtime instructions',
              prompt,
            })
      ).then(() => {
        accepted = true;
      });
      await peer.frame('session.update', after);
      expect(accepted).toBe(false);
      const followingInput = raw
        ? voice.sendEvent({ type: 'input_audio_buffer.append', audio: 'AAA=' })
        : undefined;
      expect(
        peer.frames
          .slice(after)
          .some((frame) => frame.type === 'input_audio_buffer.append'),
      ).toBe(false);
      const switching = voice.updateAgent(second);
      expect(instructions).toHaveBeenCalledOnce();
      peer.autoAckUpdates = true;
      const acknowledgement = peer.pendingUpdates.shift();
      expect(acknowledgement).toBeDefined();
      peer.send(acknowledgement!);
      await updating;
      await followingInput;
      await switching;
      if (raw) await peer.frame('input_audio_buffer.append', after);
      const updates = peer.frames
        .slice(after)
        .filter((frame) => frame.type === 'session.update');
      expect(updates).toHaveLength(2);
      expect(updates[1].session).toMatchObject({
        instructions: 'Accepted runtime instructions',
        prompt,
      });
      expect(instructions).toHaveBeenCalledOnce();
      await expect(session.getActiveAgent()).resolves.toBe(first);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'keeps the accepted prompt after a rejected raw update and subsequent agent refresh',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Opening',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        settings: { prompt: { id: 'accepted-prompt' } },
      });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      peer.autoAckUpdates = false;
      const after = peer.frames.length;
      const updating = voice.sendEvent({
        type: 'session.update',
        session: { prompt: { id: 'rejected-prompt' } },
      });
      const rejected = expect(updating).rejects.toThrow();
      const frame = await peer.frame('session.update', after);
      const switching = voice.updateAgent(
        new Agent({ provider, instructions: 'New agent' }),
      );
      void switching.catch(() => {});
      peer.autoAckUpdates = true;
      peer.send({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'fixture_prompt_rejected',
          message: 'Synthetic prompt rejection.',
          event_id: frame.event_id,
        },
      });
      await rejected;
      await switching;
      const updates = peer.frames
        .slice(after)
        .filter((entry) => entry.type === 'session.update');
      expect(updates).toHaveLength(2);
      expect(updates[1].session.prompt).toEqual({ id: 'accepted-prompt' });
      await voice.requestResponse();
      const created = await peer.frame('response.create', after);
      const response = {
        id: 'after-prompt-rejection',
        metadata: created.response?.metadata,
        status: 'completed',
        output: [],
      };
      peer.send({ type: 'response.created', response });
      peer.send({ type: 'response.done', response });
      await vi.waitFor(() => {
        expect(seen).toContainEqual({
          type: 'provider_request_error',
          code: 'fixture_prompt_rejected',
          eventId: frame.event_id,
        });
        expect(seen).toContainEqual(
          expect.objectContaining({
            type: 'response',
            status: 'done',
            responseId: response.id,
          }),
        );
      });
      expect(peer.models).toEqual(['fixture-realtime']);
      await voice.close();
      await reading;
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each([false, true])(
  'accepts a runtime update reentered from a profile instructions callback (raw=%s)',
  async (raw) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const first = new Agent({ provider, instructions: 'Opening' });
      const second = new Agent({
        provider,
        instructions: 'New backend',
        realtime: { instructions: 'Agent default' },
      });
      await using session = await first.session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        instructions: async ({ agent }) => {
          if (agent === second) {
            await publish();
          }
          return 'Callback instructions';
        },
      });
      const publish = () =>
        raw
          ? voice.sendEvent({
              type: 'session.update',
              session: {
                instructions: 'Reentered runtime instructions',
                prompt: null,
              },
            })
          : voice.update({
              instructions: 'Reentered runtime instructions',
              prompt: null,
            });
      const after = peer.frames.length;
      await voice.updateAgent(second);
      const updates = peer.frames
        .slice(after)
        .filter((frame) => frame.type === 'session.update');
      expect(updates).toHaveLength(2);
      expect(updates[1].session).toMatchObject({
        instructions: 'Reentered runtime instructions',
        prompt: null,
      });
      await expect(voice.getActiveAgent()).resolves.toBe(second);
      await expect(session.getActiveAgent()).resolves.toBe(first);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'binds connection policies to an updated voice agent without widening its tools or changing the Session',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    const application = { marker: 'connection-policy-context' };
    const instructionsSeen: unknown[] = [];
    const connectionToolsSeen: { agent: unknown; name: string }[] = [];
    const agentToolsSeen: unknown[] = [];
    try {
      await using provider = await providerFor(model);
      const first = new Agent<typeof application>({
        name: 'Opening',
        provider,
        instructions: 'Opening backend instructions',
      });
      const second = new Agent<typeof application>({
        name: 'Accepted',
        provider,
        instructions: 'Accepted backend instructions',
        tools: ['allowed', 'agent_hidden', 'connection_hidden'].map((name) =>
          tool({
            name,
            parameters: z.object({}).strict(),
            execute: () => name,
          }),
        ),
        realtime: {
          instructions: 'Agent voice defaults',
          toolEnabled: async (run, declaration) => {
            expect(run.context).toBe(application);
            agentToolsSeen.push(run.agent);
            return declaration.name !== 'agent_hidden';
          },
        },
      });
      await using session = await first.session({ context: application });
      const voice = await session.realtime({
        model: 'fixture-realtime',
        instructions: async (run) => {
          expect(run.context).toBe(application);
          instructionsSeen.push(run.agent);
          return `Connection voice for ${run.agent.name}`;
        },
        isToolEnabled: async (run, declaration) => {
          expect(run.context).toBe(application);
          connectionToolsSeen.push({
            agent: run.agent,
            name: declaration.name,
          });
          return declaration.name !== 'connection_hidden';
        },
      });
      try {
        const initial = await peer.frame('session.update');
        expect(initial.session.instructions).toBe(
          'Connection voice for Opening',
        );
        const after = peer.frames.length;
        await voice.updateAgent(second);
        const update = await peer.frame('session.update', after);
        expect(update.session.instructions).toBe(
          'Connection voice for Accepted',
        );
        expect(update.session.tools.map((entry: Frame) => entry.name)).toEqual([
          'background_agent',
          'remain_silent',
          'allowed',
        ]);
        expect(instructionsSeen).toHaveLength(2);
        expect(instructionsSeen[0]).toBe(first);
        expect(instructionsSeen[1]).toBe(second);
        expect(agentToolsSeen).toHaveLength(3);
        for (const agent of agentToolsSeen) expect(agent).toBe(second);
        expect(
          connectionToolsSeen
            .filter(({ agent }) => agent === second)
            .map(({ name }) => name)
            .sort(),
        ).toEqual(['agent_hidden', 'allowed', 'connection_hidden']);
        await expect(voice.getActiveAgent()).resolves.toBe(second);
        await expect(session.getActiveAgent()).resolves.toBe(first);
        expect(first.instructions).toBe('Opening backend instructions');
      } finally {
        await voice.close();
      }
      await expect(session.getActiveAgent()).resolves.toBe(first);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'switches a live voice agent while preserving the opening Session agent',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const first = new Agent({ provider, instructions: 'First agent' });
      const secondTool = tool({
        name: 'second_tool',
        description: 'Respond with the second agent',
        parameters: z.object({}).strict(),
        execute: () => 'second',
      });
      const second = new Agent({
        provider,
        instructions: 'Second backend agent',
        tools: [secondTool],
        realtime: { instructions: async () => 'Second voice agent' },
      });
      await using session = await first.session();
      const voice = await session.realtime({
        model: 'fixture-realtime',
        tools: [],
      });
      try {
        await expect(voice.getActiveAgent()).resolves.toBe(first);
        const after = peer.frames.length;
        await voice.updateAgent(second);
        const update = await peer.frame('session.update', after);
        expect(update.session.instructions).toBe('Second voice agent');
        expect(update.session.tools.map((tool: Frame) => tool.name)).toEqual([
          'background_agent',
          'remain_silent',
          'second_tool',
        ]);
        await expect(voice.getActiveAgent()).resolves.toBe(second);
        await expect(session.getActiveAgent()).resolves.toBe(first);
      } finally {
        await voice.close();
      }

      const after = peer.frames.length;
      await using reopened = await session.realtime({
        model: 'fixture-realtime',
      });
      await expect(reopened.getActiveAgent()).resolves.toBe(first);
      const update = await peer.frame('session.update', after);
      expect(update.session.instructions).toBe('First agent');
      expect(update.session.tools.map((tool: Frame) => tool.name)).toEqual([
        'background_agent',
        'remain_silent',
      ]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30_000,
);

nativeIt.each([true, false])(
  'observes raw provider frames before typed events when requested (%s)',
  async (includeRawProviderEvents) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    const rateLimits = {
      type: 'rate_limits.updated',
      event_id: 'rates',
      rate_limits: [],
    };
    const speech = {
      type: 'input_audio_buffer.speech_started',
      item_id: 'speech',
    };
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Listen.',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        includeRawProviderEvents,
      });
      peer.send(rateLimits);
      peer.send(speech);
      const frames: JsonObject[] = [];
      for await (const event of voice.events()) {
        if (event.type === 'raw_provider_event') frames.push(event.event);
        if (event.type === 'lifecycle' && event.status === 'speech_started')
          break;
      }
      if (includeRawProviderEvents) {
        expect(frames.map((frame) => frame.type)).toEqual([
          'session.updated',
          'rate_limits.updated',
          'input_audio_buffer.speech_started',
        ]);
        expect(frames.slice(-2)).toEqual([rateLimits, speech]);
      } else {
        expect(frames).toEqual([]);
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
);

nativeIt.each(
  (['invalid_request_error', 'server_error'] as const).flatMap((errorType) =>
    [undefined, 'unrelated-event'].map(
      (eventId) => [errorType, eventId] as const,
    ),
  ),
)(
  'releases only the matching response create after provider rejection (%s, %s)',
  async (errorType, unrelatedId) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Listen.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      let failure: unknown;
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch((error: unknown) => {
        failure = error;
      });
      try {
        await voice.requestResponse();
        const first = await peer.frame('response.create');
        expect(first.event_id).toEqual(expect.any(String));
        const secondIndex = peer.frames.indexOf(first) + 1;
        peer.send({
          type: 'error',
          error: {
            type: errorType,
            code: 'small_provider_error',
            ...(unrelatedId === undefined ? {} : { event_id: unrelatedId }),
          },
        });
        await vi.waitFor(() =>
          expect(seen).toContainEqual({
            type: 'provider_request_error',
            code: 'small_provider_error',
            ...(unrelatedId === undefined ? {} : { eventId: unrelatedId }),
          }),
        );
        await voice.requestResponse();
        // The peer observes this writer barrier after the queued create command.
        await voice.sendEvent({ type: 'fixture.barrier' });
        await peer.frame('fixture.barrier', secondIndex);
        expect(
          peer.frames
            .slice(secondIndex)
            .some((frame) => frame.type === 'response.create'),
        ).toBe(false);
        peer.send({
          type: 'error',
          error: {
            type: errorType,
            code: 'invalid_value',
            event_id: first.event_id,
          },
        });
        const second = await peer.frame('response.create', secondIndex);
        expect(second.event_id).not.toEqual(first.event_id);
        const response = {
          id: 'after-rejection',
          status: 'completed',
          output: [],
        };
        peer.send({ type: 'response.created', response });
        peer.send({ type: 'response.done', response });
        await vi.waitFor(() => {
          expect(seen).toContainEqual({
            type: 'provider_request_error',
            code: 'invalid_value',
            eventId: first.event_id,
          });
          expect(seen).toContainEqual(
            expect.objectContaining({
              type: 'response',
              status: 'done',
              responseId: response.id,
            }),
          );
        });
        expect(failure).toBeUndefined();
        expect(peer.models).toEqual(['fixture-realtime']);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
);

nativeIt(
  'replaces the provider tool list through raw session updates',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const lookup = tool({
        name: 'native_lookup',
        description: 'Look up a value using the native agent.',
        parameters: z.object({ query: z.string() }),
        execute: () => 'Found',
      });
      await using session = await new Agent({
        provider,
        instructions: 'Use the configured tools.',
        tools: [lookup],
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const initial = await peer.frame('session.update');
      const nativeTool = initial.session.tools.find(
        (declaration: Frame) => declaration.name === 'native_lookup',
      ) as JsonObject;
      expect(nativeTool).toBeDefined();
      const hostedTool = {
        type: 'mcp',
        server_label: 'fixture',
        server_url: 'https://fixture.invalid/mcp',
        allowed_tools: ['read'],
        require_approval: 'always',
      };
      const tools = [hostedTool, nativeTool];
      const after = peer.frames.length;
      await expect(
        voice.sendEvent({
          type: 'session.update',
          event_id: 'raw-tool-replacement',
          session: { tools },
        }),
      ).resolves.toBeNull();
      expect(await peer.frame('session.update', after)).toMatchObject({
        event_id: 'raw-tool-replacement',
        session: { tools },
      });
      const next = peer.frames.length;
      await expect(
        voice.sendEvent({
          type: 'session.update',
          session: {
            tools: [{ ...nativeTool, parameters: { type: 'object' } }],
          },
        }),
      ).rejects.toThrow(/captured native declaration/);
      await voice.sendEvent({
        type: 'session.update',
        session: { instructions: 'Continue with the same tools.' },
      });
      expect(peer.frames.slice(next)).toEqual([
        expect.objectContaining({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: 'Continue with the same tools.',
          },
        }),
      ]);
      const beforeClear = peer.frames.length;
      await voice.sendEvent({ type: 'session.update', session: { tools: [] } });
      expect(
        (await peer.frame('session.update', beforeClear)).session.tools,
      ).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'accepts one acknowledged output for a linked application function call',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Use the application function.',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        settings: {
          turnDetection: { type: 'server_vad', interruptResponse: false },
        },
      });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        await voice.sendEvent({
          type: 'session.update',
          session: {
            tools: [{ type: 'function', name: 'lookup_application' }],
          },
        });
        await voice.sendEvent({ type: 'response.create' });
        const responseId = 'application-response';
        const call = {
          id: 'application-call-item',
          type: 'function_call',
          name: 'lookup_application',
          call_id: 'application-call',
          arguments: '{"key":"fixture"}',
          status: 'completed',
        };
        peer.retrievals.set(call.id, call);
        peer.send({
          type: 'response.created',
          response: { id: responseId },
        });
        peer.send({
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: 0,
          item: call,
        });
        peer.send({
          type: 'conversation.item.added',
          previous_item_id: null,
          item: call,
        });
        peer.send({ type: 'conversation.item.done', item: call });
        peer.send({
          type: 'response.done',
          response: { id: responseId, status: 'completed', output: [call] },
        });
        await vi.waitFor(() =>
          expect(seen).toContainEqual(
            expect.objectContaining({
              type: 'conversation_item',
              kind: 'function_call',
              status: 'done',
              itemId: call.id,
            }),
          ),
        );
        peer.send({
          type: 'input_audio_buffer.speech_started',
          item_id: 'next-user-audio',
          audio_start_ms: 0,
        });
        expect(await voice.retrieveConversationItem(call.id)).toEqual(call);
        const item = {
          id: 'application-output-item',
          type: 'function_call_output',
          call_id: call.call_id,
          output: 'found',
        };
        const after = peer.frames.length;
        const creating = voice.sendEvent({
          type: 'conversation.item.create',
          item,
        });
        void creating.catch(() => {});
        const created = await peer.frame('conversation.item.create', after);
        expect(created.item).toMatchObject(item);
        peer.send({
          type: 'conversation.item.added',
          previous_item_id: call.id,
          item: created.item,
        });
        await expect(creating).resolves.toBeNull();
        await expect(
          voice.sendEvent({
            type: 'conversation.item.create',
            item: { ...item, id: 'duplicate-application-output' },
          }),
        ).rejects.toThrow();
        expect(seen.filter((event) => event.type === 'function_call')).toEqual(
          [],
        );
        expect(
          peer.frames.filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(1);
        expect(
          seen.filter(
            (event) =>
              event.type === 'conversation_item' &&
              event.itemId === call.id &&
              event.status === 'done',
          ),
        ).toHaveLength(1);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'forwards unknown raw provider events while rejecting malformed known controls before writing',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep provider controls isolated.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const event: JsonObject = {
        type: 'fixture.future_control',
        event_id: 'future-control-1',
        custom: {
          nested: [null, true, 7, { text: 'unchanged', values: ['a', 'b'] }],
        },
      };
      await expect(voice.sendEvent(event)).resolves.toBeNull();
      expect(await peer.frame(event.type as string)).toEqual(event);
      const after = peer.frames.length;
      await expect(
        voice.sendEvent({
          type: 'response.create',
          event_id: 'malformed-known-control',
          response: { output_modalities: 'text' },
        }),
      ).rejects.toThrow();
      // An acknowledged update follows every earlier write on this connection.
      await voice.update({ instructions: 'Continue after validation.' });
      expect(peer.frames.slice(after).map((frame) => frame.type)).toEqual([
        'session.update',
      ]);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'preserves raw per-response tool choice without changing the next default response',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Use the accepted Session tools by default.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const event: JsonObject = {
        type: 'response.create',
        response: { tool_choice: 'none' },
      };
      await voice.sendEvent(event);
      const create = await peer.frame('response.create');
      expect(create).toEqual({
        ...defaultResponseCreate,
        response: { tool_choice: 'none', metadata: generatedResponseMetadata },
      });
      peer.send({
        type: 'response.created',
        response: {
          id: 'raw-tool-choice-response',
          metadata: create.response.metadata,
        },
      });
      peer.send({
        type: 'response.done',
        response: {
          id: 'raw-tool-choice-response',
          status: 'completed',
          output: [],
        },
      });
      const after = peer.frames.length;
      await voice.requestResponse();
      expect(await peer.frame('response.create', after)).toEqual(
        defaultResponseCreate,
      );
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'keeps concurrent detached responses outside default history and cancellation',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    const checkOutput = vi.fn(() => ({ tripwireTriggered: false }));
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Listen.',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        includeRawProviderEvents: true,
        outputGuardrails: [{ name: 'check-output', callback: checkOutput }],
      });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })();
      async function observeResponse(
        responseId: string,
        status: string,
        detached: boolean,
      ) {
        await vi.waitFor(() =>
          expect(seen).toContainEqual(
            expect.objectContaining({
              type: 'response',
              responseId,
              status,
              ...(detached ? { outOfBand: true } : {}),
            }),
          ),
        );
      }
      try {
        await voice.requestResponse();
        await peer.frame('response.create');
        peer.send({ type: 'response.created', response: { id: 'linked' } });
        await observeResponse('linked', 'created', false);

        for (const responseId of ['detached-a', 'detached-b']) {
          const cursor = peer.frames.length;
          await voice.sendEvent({
            type: 'response.create',
            event_id: responseId,
            response: {
              conversation: 'none',
              input: [{ type: 'item_reference', id: 'previous-mcp-list' }],
              tools: [
                {
                  type: 'mcp',
                  server_label: 'docs',
                  connector_id: 'connector_fixture',
                },
              ],
              tool_choice: { type: 'mcp', server_label: 'docs' },
            },
          });
          const created = await peer.frame('response.create', cursor);
          expect(created.event_id).toBe(responseId);
          expect(created.response.tool_choice).toEqual({
            type: 'mcp',
            server_label: 'docs',
          });
          peer.send({
            type: 'response.created',
            response: { id: responseId, conversation_id: null },
          });
          await observeResponse(responseId, 'created', true);
        }

        const item = {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          id: 'detached-item',
          content: [{ type: 'output_text', text: 'Private result' }],
        };
        peer.send({
          type: 'response.output_text.done',
          response_id: 'detached-a',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: 'Private result',
        });
        peer.send({
          type: 'response.output_item.done',
          response_id: 'detached-a',
          item,
        });
        peer.send({
          type: 'response.done',
          response: { id: 'detached-a', status: 'completed', output: [item] },
        });
        await observeResponse('detached-a', 'done', true);
        await vi.waitFor(() =>
          expect(checkOutput).toHaveBeenCalledWith(
            expect.objectContaining({
              responseId: 'detached-a',
              itemId: item.id,
              outOfBand: true,
              text: 'Private result',
            }),
          ),
        );
        expect(seen).toContainEqual(
          expect.objectContaining({
            type: 'raw_provider_event',
            event: expect.objectContaining({ item }),
          }),
        );
        expect(voice.providerHistory()).toEqual([]);

        await voice.sendEvent({
          type: 'response.cancel',
          response_id: 'detached-b',
        });
        expect((await peer.frame('response.cancel')).response_id).toBe(
          'detached-b',
        );
        peer.send({ type: 'response.cancelled', response_id: 'detached-b' });
        await observeResponse('detached-b', 'cancelled', true);
        const cursor = peer.frames.length;
        await voice.interrupt();
        expect((await peer.frame('response.cancel', cursor)).response_id).toBe(
          'linked',
        );
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
);

nativeIt(
  'validates raw prompt and voice settings and preserves prompt references and null',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Use the accepted Session instructions by default.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const invalid: [JsonObject, RegExp][] = [
        [{ prompt: { id: ' ' } }, /raw Realtime response prompt/],
        [{ audio: { output: { voice: ' ' } } }, /raw Realtime response audio/],
        [
          { audio: { output: { voice: { id: '' } } } },
          /raw Realtime response audio/,
        ],
      ];
      for (const [index, [response, error]] of invalid.entries()) {
        const eventId = `invalid-response-settings-${index}`;
        await expect(
          voice.sendEvent({
            type: 'response.create',
            event_id: eventId,
            response,
          }),
        ).rejects.toThrow(error);
        expect(peer.frames.some((frame) => frame.event_id === eventId)).toBe(
          false,
        );
      }
      const prompts: (JsonObject | null)[] = [
        { id: 'pmpt_fixture' },
        {
          id: 'pmpt_fixture',
          version: '2',
          variables: {
            recipient: 'Sam',
            tone: { type: 'input_text', text: 'brief' },
          },
        },
        null,
      ];
      for (const [index, prompt] of prompts.entries()) {
        const event: JsonObject = {
          type: 'response.create',
          event_id: `response-prompt-${index}`,
          response: { prompt },
        };
        const after = peer.frames.length;
        await voice.sendEvent(event);
        const create = await peer.frame('response.create', after);
        expect(create).toEqual({
          ...event,
          response: { prompt, metadata: generatedResponseMetadata },
        });
        const responseId = `prompt-response-${index}`;
        peer.send({
          type: 'response.created',
          response: { id: responseId, metadata: create.response.metadata },
        });
        peer.send({
          type: 'response.done',
          response: { id: responseId, status: 'completed', output: [] },
        });
      }
      const after = peer.frames.length;
      await voice.requestResponse();
      expect(await peer.frame('response.create', after)).toEqual(
        defaultResponseCreate,
      );
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt.each(['pcm16', 'g711_ulaw', 'g711_alaw'] as const)(
  'retains raw per-response %s audio options and restores the default response codec',
  async (format) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Use PCM16 unless a response overrides its output.',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        settings: { outputFormat: 'pcm16', outputVoice: 'marin' },
        historyStoreAudio: true,
        includeRawProviderEvents: true,
      });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const output: JsonObject = {
          voice: format === 'g711_ulaw' ? { id: 'voice_fixture' } : 'ash',
          format:
            format === 'pcm16'
              ? { type: 'audio/pcm', rate: 24000 }
              : { type: format === 'g711_ulaw' ? 'audio/pcmu' : 'audio/pcma' },
        };
        const event: JsonObject = {
          type: 'response.create',
          event_id: `response-audio-${format}`,
          response: { audio: { output } },
        };
        await voice.sendEvent(event);
        const create = await peer.frame('response.create');
        expect(create).toEqual({
          ...event,
          response: { audio: { output }, metadata: generatedResponseMetadata },
        });
        const responseId = `override-${format}`;
        peer.send({
          type: 'response.created',
          response: { id: responseId, metadata: create.response.metadata },
        });
        const embeddedId = `embedded-${format}`;
        const embedded = Buffer.alloc(64, 7);
        const completedItem = {
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: 0,
          item: {
            id: embeddedId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_audio', audio: embedded.toString('base64') },
            ],
          },
        };
        peer.send(completedItem);
        const retainedItem = () =>
          voice.providerHistory().find((item) => item.id === embeddedId);
        await vi.waitFor(() => {
          expect(retainedItem()).toMatchObject({
            content: completedItem.item.content,
          });
          expect(seen).toContainEqual({
            type: 'raw_provider_event',
            event: completedItem,
          });
        });
        peer.send({
          type: 'conversation.item.truncated',
          item_id: embeddedId,
          content_index: 0,
          audio_end_ms: 1,
        });
        const bytesAtOneMs = format === 'pcm16' ? 48 : 8;
        await vi.waitFor(() =>
          expect(retainedItem()).toMatchObject({
            content: [
              {
                type: 'output_audio',
                audio: embedded.subarray(0, bytesAtOneMs).toString('base64'),
              },
            ],
          }),
        );
        const data = Buffer.from([1, 2, 3, 4]);
        peer.send({
          type: 'response.output_audio.delta',
          response_id: responseId,
          item_id: `audio-${format}`,
          content_index: 0,
          output_index: 0,
          delta: data.toString('base64'),
        });
        await vi.waitFor(() =>
          expect(
            seen.find(
              (entry) =>
                entry.type === 'audio' && entry.responseId === responseId,
            ),
          ).toMatchObject({
            type: 'audio',
            responseId,
            itemId: `audio-${format}`,
            format,
            sampleRate: format === 'pcm16' ? 24000 : 8000,
            channels: 1,
            data: new Uint8Array(data),
          }),
        );
        peer.send({
          type: 'response.done',
          response: { id: responseId, status: 'completed', output: [] },
        });
        const after = peer.frames.length;
        await voice.requestResponse();
        expect(await peer.frame('response.create', after)).toEqual(
          defaultResponseCreate,
        );
        const defaultId = `default-after-${format}`;
        peer.send({
          type: 'response.created',
          response: { id: defaultId },
        });
        peer.send({
          type: 'response.output_audio.delta',
          response_id: defaultId,
          item_id: `default-audio-${format}`,
          content_index: 0,
          output_index: 0,
          delta: data.toString('base64'),
        });
        await vi.waitFor(() =>
          expect(
            seen.find(
              (entry) =>
                entry.type === 'audio' && entry.responseId === defaultId,
            ),
          ).toMatchObject({
            type: 'audio',
            responseId: defaultId,
            format: 'pcm16',
            sampleRate: 24000,
            channels: 1,
            data: new Uint8Array(data),
          }),
        );
        expect(
          peer.frames.filter((frame) => frame.type === 'session.update'),
        ).toHaveLength(1);
        expect(model.requests).toEqual([]);
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

nativeIt.each(['user', 'assistant', 'system'] as const)(
  'retrieves an unobserved %s application item before deleting it with the caller event ID',
  async (role) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Delete only the requested application item.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const item: JsonObject = {
          ...userItem('application-item-before-attachment', 'Earlier input.'),
          role,
          content: [
            {
              type: role === 'assistant' ? 'output_text' : 'input_text',
              text: 'Earlier input.',
            },
          ],
          status: 'completed',
        };
        peer.retrievals.set(item.id as string, item);
        const event: JsonObject = {
          type: 'conversation.item.delete',
          item_id: item.id,
          event_id: 'delete-application-item',
        };
        const after = peer.frames.length;
        let settled = false;
        const deleting = voice.sendEvent(event).then((result) => {
          settled = true;
          return result;
        });
        void deleting.catch(() => {});
        const lookup = await peer.frame('conversation.item.retrieve', after);
        expect(lookup.item_id).toBe(item.id);
        expect(lookup.event_id).not.toBe(event.event_id);
        const deletion = await peer.frame('conversation.item.delete', after);
        expect(deletion).toEqual(event);
        expect(peer.frames.slice(after).map((frame) => frame.type)).toEqual([
          'conversation.item.retrieve',
          'conversation.item.delete',
        ]);
        expect(settled).toBe(false);
        peer.send({
          type: 'conversation.item.deleted',
          event_id: 'provider-deletion-receipt',
          item_id: item.id,
        });
        await expect(deleting).resolves.toBeNull();
        await vi.waitFor(() =>
          expect(seen).toContainEqual({
            type: 'conversation_item_deleted',
            itemId: item.id,
          }),
        );
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'reports one detached application function call without native execution or linked history',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const execute = vi.fn(() => 'Native execution must remain isolated.');
      const external = tool({
        name: 'external',
        description: 'An available native function.',
        parameters: z.object({}),
        execute,
      });
      await using session = await new Agent({
        provider,
        instructions: 'Keep detached work outside the native conversation.',
        tools: [external],
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const event: JsonObject = {
          type: 'response.create',
          event_id: 'detached-tool-override',
          response: {
            conversation: 'none',
            input: [],
            tools: [
              {
                type: 'function',
                name: 'external',
                parameters: { type: 'object' },
              },
            ],
            tool_choice: { type: 'function', name: 'external' },
          },
        };
        await voice.sendEvent(event);
        expect(await peer.frame('response.create')).toEqual(event);
        const responseId = 'detached-tool-response';
        const item = {
          id: 'detached-tool-item',
          type: 'function_call',
          name: 'external',
          call_id: 'detached-tool-call',
          arguments: '{"key":"fixture"}',
          status: 'completed',
        };
        peer.send({
          type: 'response.created',
          response: { id: responseId, conversation_id: null },
        });
        peer.send({
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: 0,
          item,
        });
        peer.send({
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: 0,
          item,
        });
        peer.send({
          type: 'response.done',
          response: { id: responseId, status: 'completed', output: [item] },
        });
        // This ordinary provider item follows the detached completion on the
        // reader, and the acknowledged update fences earlier writer effects.
        await observe(peer, seen, userItem('after-detached-tool', 'Continue.'));
        await voice.update({ instructions: 'Continue with the native owner.' });
        expect(
          seen.filter((entry) => entry.type === 'detached_function_call'),
        ).toEqual([
          {
            type: 'detached_function_call',
            responseId,
            itemId: item.id,
            callId: item.call_id,
            name: item.name,
            arguments: '{"key":"fixture"}',
          },
        ]);
        expect(
          seen.filter(
            (entry) =>
              entry.type === 'conversation_item' && entry.itemId === item.id,
          ),
        ).toEqual([]);
        expect(voice.history.some((entry) => entry.id === item.id)).toBe(false);
        expect(execute).not.toHaveBeenCalled();
        expect(seen.filter((entry) => entry.type === 'function_call')).toEqual(
          [],
        );
        expect(
          peer.frames.filter(
            (frame) =>
              frame.type === 'conversation.item.create' &&
              frame.item?.type === 'function_call_output',
          ),
        ).toEqual([]);
        expect(
          peer.frames.filter((frame) => frame.type === 'response.create'),
        ).toEqual([event]);
        const continuation = {
          type: 'response.create',
          response: {
            conversation: 'none',
            input: [
              {
                type: 'function_call_output',
                call_id: item.call_id,
                output: 'found',
              },
            ],
          },
        } satisfies JsonObject;
        const after = peer.frames.length;
        await voice.sendEvent(continuation);
        expect(await peer.frame('response.create', after)).toEqual({
          ...continuation,
          event_id: expect.any(String),
          response: {
            ...continuation.response,
            tools: [],
            tool_choice: 'none',
          },
        });
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'replays a bulk caller-owned function pair in predecessor order without native execution',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const execute = vi.fn(() => 'Do not execute imported history.');
      const external = tool({
        name: 'external',
        description: 'A native function also named by caller-owned history.',
        parameters: z.object({}),
        execute,
      });
      await using session = await new Agent({
        provider,
        instructions: 'Retain caller-owned historical tool results.',
        tools: [external],
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const original = userItem('before-replay', 'Earlier input.');
        await observe(peer, seen, original);
        const call: JsonObject = {
          id: 'imported-call-item',
          type: 'function_call',
          call_id: 'imported-call',
          name: 'external',
          arguments: '{}',
          status: 'completed',
        };
        const output: JsonObject = {
          id: 'imported-output-item',
          type: 'function_call_output',
          call_id: 'imported-call',
          output: 'An already completed caller-owned result.',
          status: 'completed',
        };
        const desired = [original, call, output];
        for (const item of desired)
          peer.retrievals.set(item.id as string, item);
        const start = peer.frames.length;
        let after = start;
        let settled = false;
        const updating = voice.updateHistory(desired).then(() => {
          settled = true;
        });
        void updating.catch(() => {});
        let previous = original.id;
        for (const item of [call, output]) {
          const creation = await Promise.race([
            peer.frame('conversation.item.create', after),
            updating.then(() => {
              throw new Error(
                'Historical reconciliation completed before its required create',
              );
            }),
          ]);
          after = peer.frames.length;
          expect(creation.item).toEqual(item);
          expect(creation.previous_item_id).toBe(previous);
          expect(settled).toBe(false);
          peer.send({
            type: 'conversation.item.created',
            previous_item_id: previous,
            item,
          });
          peer.send({ type: 'conversation.item.done', item });
          previous = item.id;
        }
        await updating;
        expect(await voice.retrieveConversationHistory()).toEqual(desired);
        await voice.update({
          instructions: 'Continue after imported history.',
        });
        expect(execute).not.toHaveBeenCalled();
        expect(seen.filter((entry) => entry.type === 'function_call')).toEqual(
          [],
        );
        expect(
          peer.frames
            .slice(start)
            .filter((frame) => frame.type === 'conversation.item.create')
            .map((frame) => frame.item),
        ).toEqual([call, output]);
        expect(
          peer.frames
            .slice(start)
            .some(
              (frame) =>
                frame.type === 'response.create' ||
                frame.type === 'conversation.item.delete',
            ),
        ).toBe(false);
        expect(model.requests).toEqual([]);
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

nativeIt(
  'retires detached audio playback without truncating a provider conversation item',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Listen for the next user turn.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        await voice.sendEvent({
          type: 'response.create',
          response: {
            conversation: 'none',
            input: [],
            output_modalities: ['audio'],
          },
        });
        await peer.frame('response.create');
        const responseId = 'detached-audio-response';
        const itemId = 'detached-audio-item';
        peer.send({
          type: 'response.created',
          response: { id: responseId, conversation_id: null },
        });
        peer.send({
          type: 'response.output_audio.delta',
          response_id: responseId,
          item_id: itemId,
          content_index: 0,
          output_index: 0,
          delta: Buffer.alloc(4800).toString('base64'),
        });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'audio' &&
                event.responseId === responseId &&
                event.itemId === itemId,
            ),
          ).toBe(true),
        );
        const playback = {
          responseId,
          itemId,
          contentIndex: 0,
          audioEndMs: 50,
        };
        const after = peer.frames.length;
        await expect(
          voice.sendEvent({
            type: 'conversation.item.truncate',
            item_id: itemId,
            content_index: playback.contentIndex,
            audio_end_ms: playback.audioEndMs,
          }),
        ).rejects.toThrow();
        expect(peer.frames).toHaveLength(after);

        await voice.interrupt(responseId, { playback });
        // An acknowledged update observes every earlier write on this connection.
        await voice.update({
          instructions: 'Continue listening after detached audio.',
        });
        await peer.frame('session.update', after);
        const written = peer.frames.slice(after);
        expect(
          written.filter((frame) => frame.type === 'response.cancel'),
        ).toEqual([{ type: 'response.cancel', response_id: responseId }]);
        expect(
          written.some((frame) => frame.type === 'conversation.item.truncate'),
        ).toBe(false);
        await vi.waitFor(() =>
          expect(seen).toContainEqual({
            type: 'playback_interrupted',
            responseId,
            playback,
            retiredResponseIds: [responseId],
            cancelledResponseId: responseId,
          }),
        );
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'SIP snapshot matches connection configuration including captured tools, handoffs, and settings',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      const lookup = tool({
        name: 'lookup',
        description: 'Look up a record.',
        parameters: z.object({ key: z.string() }),
        execute: ({ key }) => key,
      });
      const target = new Agent({
        provider,
        instructions: 'Handle escalations.',
        name: 'support',
      });
      await using session = await new Agent({
        provider,
        instructions: 'Use the captured instructions.',
        tools: [lookup],
        handoffs: [target],
      }).session();
      const options = {
        model: 'fixture-realtime',
        voice: 'marin',
        settings: {
          transcription: null,
          turnDetection: null,
          outputSpeed: 1.1,
          maxOutputTokens: 512,
        },
      };
      const config = await session.buildRealtimeSipConfig(options);
      expect(peer.frames).toEqual([]);
      expect(peer.models).toEqual([]);
      expect(config.instructions).toContain('Use the captured instructions.');
      expect(config.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            name: 'lookup',
            parameters: expect.objectContaining({
              properties: expect.objectContaining({ key: expect.anything() }),
            }),
          }),
        ]),
      );
      expect(config.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'transfer_to_support' }),
        ]),
      );
      await using _voice = await session.realtime(options);
      const update = await peer.frame('session.update');
      const expected = { model: peer.models[0], ...update.session };
      delete expected.id;
      expect(config).toEqual(expected);
      expect(config.id).toBeUndefined();
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt.each([
  [{ threshold: 0.5 }, { threshold: 0.5 }],
  [{ prefixPaddingMs: 100 }, { prefix_padding_ms: 100 }],
  [{ silenceDurationMs: 300 }, { silence_duration_ms: 300 }],
])(
  'preserves supported SIP VAD tuning without voice admission: %o',
  async (tuning, expected) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Help.',
      }).session();
      const config = await session.buildRealtimeSipConfig({
        settings: { turnDetection: { type: 'server_vad', ...tuning } },
      });
      expect(config).toMatchObject({
        audio: {
          input: { turn_detection: { type: 'server_vad', ...expected } },
        },
      });
      expect(peer.frames).toEqual([]);
      expect(peer.models).toEqual([]);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt.each(['server_vad', 'semantic_vad'] as const)(
  'preserves %s model versions for SIP, text startup, and live updates',
  async (type) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Reply with text.',
      }).session();
      const options = {
        model: 'fixture-realtime',
        outputModality: 'text' as const,
        settings: { turnDetection: { type, modelVersion: 'fixture-vad-v1' } },
      };
      const config = await session.buildRealtimeSipConfig(options);
      expect(config).toMatchObject({
        output_modalities: ['text'],
        audio: {
          input: {
            turn_detection: { type, model_version: 'fixture-vad-v1' },
          },
        },
      });
      expect(peer.frames).toEqual([]);
      expect(peer.models).toEqual([]);
      await using voice = await session.realtime(options);
      const initial = await peer.frame('session.update');
      const expected = { model: peer.models[0], ...initial.session };
      delete expected.id;
      expect(config).toEqual(expected);
      const after = peer.frames.length;
      await voice.update({
        turnDetection: { type, modelVersion: 'fixture-vad-v2' },
      });
      const update = await peer.frame('session.update', after);
      expect(update.session).toMatchObject({
        audio: {
          input: {
            turn_detection: { type, model_version: 'fixture-vad-v2' },
          },
        },
      });
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'sends one-response overrides without changing the next default response',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Use the accepted Session instructions.',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
      });
      await voice.requestResponse({
        instructions: 'Answer this response briefly.',
        outputModality: 'text',
        maxOutputTokens: 32,
      });
      const first = await peer.frame('response.create');
      expect(first).toEqual({
        ...defaultResponseCreate,
        response: {
          instructions: 'Answer this response briefly.',
          output_modalities: ['text'],
          max_output_tokens: 32,
          metadata: generatedResponseMetadata,
        },
      });
      peer.send({
        type: 'response.created',
        response: {
          id: 'override-response',
          metadata: first.response.metadata,
        },
      });
      peer.send({
        type: 'response.done',
        response: { id: 'override-response' },
      });
      const after = peer.frames.length;
      await voice.requestResponse();
      expect(await peer.frame('response.create', after)).toEqual(
        defaultResponseCreate,
      );
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'retrieves complete provider media and reconciles only the changed message suffix after exact ACKs',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep the audit.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })();
      void reading.catch(() => {});
      try {
        const first: JsonObject = {
          id: 'old1',
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_audio', audio: 'AQACAA==', transcript: 'hello' },
            { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
          ],
        };
        const second = userItem('old2', 'Replace this suffix.');
        const replacement = {
          id: 'new3',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Corrected answer.' }],
        };
        await observe(peer, seen, first);
        await observe(peer, seen, second);
        const audit = voice.history.map((entry) => entry.id);
        let after = peer.frames.length;
        const retrieved = voice.retrieveConversationItem('old1');
        void retrieved.catch(() => {});
        expect(
          (await peer.frame('conversation.item.retrieve', after)).item_id,
        ).toBe('old1');
        peer.send({ type: 'conversation.item.retrieved', item: first });
        expect(await retrieved).toEqual(first);
        after = peer.frames.length;
        const history = voice.retrieveConversationHistory();
        void history.catch(() => {});
        for (const item of [first, second]) {
          const request = await peer.frame('conversation.item.retrieve', after);
          after = peer.frames.length;
          expect(request.item_id).toBe(item.id);
          peer.send({ type: 'conversation.item.retrieved', item });
        }
        expect(await history).toEqual([first, second]);
        let settled = false;
        const updating = voice.updateHistory([first, replacement]).then(() => {
          settled = true;
        });
        void updating.catch(() => {});
        for (const item of [first, second]) {
          const request = await peer.frame('conversation.item.retrieve', after);
          after = peer.frames.length;
          expect(request.item_id).toBe(item.id);
          peer.send({ type: 'conversation.item.retrieved', item });
        }
        const deletion = await peer.frame('conversation.item.delete', after);
        after = peer.frames.length;
        expect(deletion.item_id).toBe('old2');
        expect(settled).toBe(false);
        expect(
          peer.frames
            .slice(after)
            .some((frame) => frame.type === 'conversation.item.create'),
        ).toBe(false);
        peer.send({ type: 'conversation.item.deleted', item_id: 'old2' });
        const creation = await peer.frame('conversation.item.create', after);
        expect(creation.previous_item_id).toBe('old1');
        expect(creation.item).toEqual(replacement);
        expect(settled).toBe(false);
        peer.send({
          type: 'conversation.item.created',
          item: replacement,
          previous_item_id: 'old1',
        });
        await updating;
        expect(
          voice.history
            .filter((entry) => audit.includes(entry.id))
            .map((entry) => entry.id),
        ).toEqual(audit);
        expect(model.requests).toEqual([]);
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

nativeIt.each(['retrieve', 'delete', 'create'] as const)(
  'fails history reconciliation on provider %s error without reporting success',
  async (phase) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep audit records.',
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const original = userItem('old1', 'Original.');
        await observe(peer, seen, original);
        let after = peer.frames.length;
        let settled = false;
        const updating = voice
          .updateHistory([userItem('new2', 'Replacement.')])
          .then(() => {
            settled = true;
          });
        void updating.catch(() => {});
        let request = await peer.frame('conversation.item.retrieve', after);
        if (phase !== 'retrieve') {
          after = peer.frames.length;
          peer.send({ type: 'conversation.item.retrieved', item: original });
          request = await peer.frame('conversation.item.delete', after);
        }
        if (phase === 'create') {
          after = peer.frames.length;
          peer.send({ type: 'conversation.item.deleted', item_id: 'old1' });
          request = await peer.frame('conversation.item.create', after);
        }
        expect(settled).toBe(false);
        peer.send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'fixture_rejected',
            message: `${phase} rejected`,
            event_id: request.event_id,
          },
        });
        await expect(updating).rejects.toThrow();
        expect(settled).toBe(false);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close().catch(() => {});
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  25000,
);

nativeIt.each(['item', 'history', 'update'] as const)(
  'closing cancels pending %s history work and a new generation does not revive the old owner',
  async (operation) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep audit records.',
      }).session();
      const oldVoice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of oldVoice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const item = userItem('old1', 'Original.');
        await observe(peer, seen, item);
        const after = peer.frames.length;
        const pending =
          operation === 'item'
            ? oldVoice.retrieveConversationItem('old1')
            : operation === 'history'
              ? oldVoice.retrieveConversationHistory()
              : oldVoice.updateHistory([]);
        void pending.catch(() => {});
        await peer.frame('conversation.item.retrieve', after);
        await oldVoice.close();
        await expect(pending).rejects.toThrow();
        await using current = await session.realtime({
          model: 'fixture-realtime',
        });
        const currentStart = peer.frames.length;
        await expect(
          oldVoice.retrieveConversationItem('old1'),
        ).rejects.toThrow();
        await expect(oldVoice.retrieveConversationHistory()).rejects.toThrow();
        await expect(oldVoice.updateHistory([])).rejects.toThrow();
        expect(peer.frames.length).toBe(currentStart);
        expect(await current.retrieveConversationHistory()).toEqual([]);
        expect(model.requests).toEqual([]);
      } finally {
        await oldVoice.close().catch(() => {});
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  25000,
);

nativeIt(
  'rejects invalid replacement rows before destructive provider edits',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep tool authority native.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const after = peer.frames.length;
      await expect(
        voice.updateHistory([
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Missing provider identity.' },
            ],
          },
        ]),
      ).rejects.toThrow();
      await expect(
        voice.updateHistory([
          {
            id: 'invented-tool',
            type: 'function_call',
            name: 'unissued',
            call_id: 'forged',
            arguments: '{}',
          },
        ]),
      ).rejects.toThrow();
      expect(
        peer.frames
          .slice(after)
          .some((frame) =>
            ['conversation.item.delete', 'conversation.item.create'].includes(
              frame.type,
            ),
          ),
      ).toBe(false);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt.each([
  {
    role: 'assistant',
    content: [
      {
        type: 'input_audio',
        audio: 'AQACAA==',
        transcript: 'invalid assistant input audio',
      },
    ],
  },
  {
    role: 'system',
    content: [{ type: 'input_image', image_url: PNG_IMAGE }],
  },
])(
  'rejects invalid role/media replacements before deleting observed messages: %o',
  async (replacement) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep existing messages.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const original = userItem(
          'original',
          'Keep this until the full plan is valid.',
        );
        await observe(peer, seen, original);
        peer.retrievals.set('original', original);
        const after = peer.frames.length;
        await expect(
          voice.updateHistory([
            { id: 'original', type: 'message', ...replacement },
          ]),
        ).rejects.toThrow();
        expect(
          peer.frames
            .slice(after)
            .filter((frame) =>
              ['conversation.item.delete', 'conversation.item.create'].includes(
                frame.type,
              ),
            ),
        ).toEqual([]);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'preserves full user audio when reordering an observed message suffix',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep media intact.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const audio = {
          id: 'audio-first',
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_audio', audio: 'AQACAA==', transcript: 'hello' },
          ],
        };
        const text = userItem('text-second', 'Move this before the recording.');
        for (const item of [audio, text]) {
          await observe(peer, seen, item);
          peer.retrievals.set(item.id as string, item);
        }
        const after = peer.frames.length;
        const updating = voice.updateHistory([text, audio]);
        void updating.catch(() => {});
        const deletion = await peer.frame('conversation.item.delete', after);
        expect(deletion.item_id).toBe(audio.id);
        peer.send({ type: 'conversation.item.deleted', item_id: audio.id });
        const creation = await peer.frame('conversation.item.create', after);
        expect(creation.previous_item_id).toBe(text.id);
        expect(creation.item).toEqual(audio);
        peer.send({
          type: 'conversation.item.created',
          item: audio,
          previous_item_id: text.id,
        });
        await updating;
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'records external message deletion and stops retrieving its retired provider ID while keeping the owner live',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep the canonical audit.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const item = userItem(
          'externally-deleted',
          'The provider will delete this message.',
        );
        await observe(peer, seen, item);
        const priorAuditIds = voice.history.map((entry) => entry.id);
        peer.send({ type: 'conversation.item.deleted', item_id: item.id });
        await vi.waitFor(() => {
          expect(
            seen.some(
              (event) =>
                event.type === 'conversation_item_deleted' &&
                event.itemId === item.id,
            ),
          ).toBe(true);
          expect(
            voice.history.some(
              (entry) =>
                entry.kind === 'provider_item_deleted' &&
                entry.providerItemId === item.id,
            ),
          ).toBe(true);
        });
        expect(
          voice.history
            .filter((entry) => priorAuditIds.includes(entry.id))
            .map((entry) => entry.id),
        ).toEqual(priorAuditIds);
        const afterDeletion = peer.frames.length;
        await expect(voice.retrieveConversationHistory()).resolves.toEqual([]);
        await expect(
          voice.retrieveConversationItem('externally-deleted'),
        ).rejects.toThrow();
        expect(peer.frames.slice(afterDeletion)).toEqual([]);
        const pendingItem = userItem(
          'externally-deleted-before-create-ack',
          'Delete this while its create acknowledgement is pending.',
        );
        const updating = voice.updateHistory([pendingItem]);
        void updating.catch(() => {});
        const pendingCreate = await peer.frame(
          'conversation.item.create',
          afterDeletion,
        );
        expect(pendingCreate.item).toEqual(pendingItem);
        peer.send({
          type: 'conversation.item.deleted',
          item_id: pendingItem.id,
        });
        await expect(updating).rejects.toThrow();
        peer.send({
          type: 'conversation.item.added',
          item: pendingItem,
          previous_item_id: null,
        });
        // The configuration acknowledgement follows the late create receipt on
        // the provider socket, so completion establishes a public processing barrier.
        await voice.update({ toolChoice: 'none' });
        const afterDrain = peer.frames.length;
        await expect(voice.retrieveConversationHistory()).resolves.toEqual([]);
        await expect(
          voice.retrieveConversationItem(
            'externally-deleted-before-create-ack',
          ),
        ).rejects.toThrow();
        await expect(voice.updateHistory([])).resolves.toBeUndefined();
        expect(peer.frames.slice(afterDrain)).toEqual([]);
        await voice.sendMessage('The connection remains usable.', {
          triggerResponse: false,
        });
        const created = await peer.frame(
          'conversation.item.create',
          afterDrain,
        );
        expect(created.item.content).toEqual([
          { type: 'input_text', text: 'The connection remains usable.' },
        ]);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'rejects conflicting text in a same-ID create acknowledgement before sending remaining history actions',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Preserve requested message content.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const first = userItem('expected-first', 'Requested first text.');
      const second = userItem('must-not-create', 'Requested second text.');
      const after = peer.frames.length;
      const updating = voice.updateHistory([first, second]);
      void updating.catch(() => {});
      const created = await peer.frame('conversation.item.create', after);
      expect(created.item).toEqual(first);
      peer.send({
        type: 'conversation.item.added',
        item: userItem('expected-first', 'Conflicting provider text.'),
        previous_item_id: null,
      });
      await expect(updating).rejects.toThrow();
      await voice.update({ toolChoice: 'none' });
      expect(
        peer.frames
          .slice(after)
          .filter((frame) => frame.type === 'conversation.item.create')
          .map((frame) => frame.item.id),
      ).toEqual(['expected-first']);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'accepts create acknowledgements with null audio and omitted image data while preserving requested media on the wire',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Preserve requested media.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const audio = {
        id: 'created-audio',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_audio', audio: 'AQACAA==', transcript: 'hello' },
        ],
      };
      const image = {
        id: 'created-image',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: PNG_IMAGE }],
      };
      peer.retrievals.set(audio.id, audio);
      peer.retrievals.set(image.id, image);
      let after = peer.frames.length;
      const updating = voice.updateHistory([audio, image]);
      void updating.catch(() => {});
      const audioCreate = await peer.frame('conversation.item.create', after);
      expect(audioCreate.item).toEqual(audio);
      after = peer.frames.length;
      peer.send({
        type: 'conversation.item.added',
        item: {
          ...audio,
          content: [{ type: 'input_audio', audio: null, transcript: null }],
        },
        previous_item_id: null,
      });
      const imageCreate = await peer.frame('conversation.item.create', after);
      expect(imageCreate.previous_item_id).toBe(audio.id);
      expect(imageCreate.item).toEqual(image);
      peer.send({
        type: 'conversation.item.added',
        item: { ...image, content: [{ type: 'input_image' }] },
        previous_item_id: audio.id,
      });
      await updating;
      await expect(voice.retrieveConversationHistory()).resolves.toEqual([
        audio,
        image,
      ]);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt.each([4097, 4096])(
  'bounds decompressed image dimensions before history writes (side=%s)',
  async (side) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep the original until replacement is valid.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const original = userItem(
          'original',
          'Preserve this on preflight failure.',
        );
        await observe(peer, seen, original);
        peer.retrievals.set('original', original);
        const image = {
          id: 'replacement-image',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: solidPngImage(side) }],
        };
        const after = peer.frames.length;
        const updating = voice.updateHistory([image]);
        void updating.catch(() => {});
        if (side > 4096) {
          await expect(updating).rejects.toThrow();
          expect(
            peer.frames
              .slice(after)
              .filter((frame) =>
                [
                  'conversation.item.delete',
                  'conversation.item.create',
                ].includes(frame.type),
              ),
          ).toEqual([]);
        } else {
          expect(
            (await peer.frame('conversation.item.delete', after)).item_id,
          ).toBe(original.id);
          peer.send({
            type: 'conversation.item.deleted',
            item_id: original.id,
          });
          expect(
            (await peer.frame('conversation.item.create', after)).item,
          ).toEqual(image);
          peer.send({
            type: 'conversation.item.added',
            item: image,
            previous_item_id: null,
          });
          await updating;
        }
        expect(model.requests).toEqual([]);
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

nativeIt.each(['missing', 'empty'] as const)(
  'quarantines the physical read after a %s-ID malformed retrieval until its matching late receipt drains',
  async (malformed) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep retrieval ownership exact.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const original = userItem('live-read', 'Original item.');
        await observe(peer, seen, original);
        let after = peer.frames.length;
        const first = voice.retrieveConversationItem('live-read');
        void first.catch(() => {});
        expect(
          (await peer.frame('conversation.item.retrieve', after)).item_id,
        ).toBe('live-read');
        peer.send({
          type: 'conversation.item.retrieved',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Malformed first receipt.' }],
            ...(malformed === 'empty' ? { id: '' } : {}),
          },
        });
        await expect(first).rejects.toThrow();
        after = peer.frames.length;
        await expect(
          voice.retrieveConversationItem('live-read'),
        ).rejects.toThrow();
        expect(peer.frames.slice(after)).toEqual([]);
        peer.send({
          type: 'conversation.item.retrieved',
          item: userItem('live-read', 'Late first payload.'),
        });
        await voice.update({ toolChoice: 'none' });
        after = peer.frames.length;
        const second = voice.retrieveConversationItem('live-read');
        void second.catch(() => {});
        expect(
          (await peer.frame('conversation.item.retrieve', after)).item_id,
        ).toBe('live-read');
        const fresh = userItem('live-read', 'Fresh second payload.');
        peer.send({ type: 'conversation.item.retrieved', item: fresh });
        await expect(second).resolves.toEqual(fresh);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  25000,
);

nativeIt(
  'ignores a tombstoned malformed Added before parsing while an unrelated physical read is pending',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep retrieval ownership exact.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        await observe(
          peer,
          seen,
          userItem('live-read', 'Read this live item.'),
        );
        peer.send({ type: 'conversation.item.deleted', item_id: 'root' });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'conversation_item_deleted' &&
                event.itemId === 'root',
            ),
          ).toBe(true),
        );
        const after = peer.frames.length;
        let settled = false;
        const pending = voice
          .retrieveConversationItem('live-read')
          .finally(() => {
            settled = true;
          });
        void pending.catch(() => {});
        expect(
          (await peer.frame('conversation.item.retrieve', after)).item_id,
        ).toBe('live-read');
        peer.send({
          type: 'conversation.item.added',
          item: userItem('root', 'Malformed reserved ID, already tombstoned.'),
          previous_item_id: null,
        });
        await voice.update({ toolChoice: 'none' });
        expect(settled).toBe(false);
        const result = userItem(
          'live-read',
          'The original pending host receives this payload.',
        );
        peer.send({ type: 'conversation.item.retrieved', item: result });
        await expect(pending).resolves.toEqual(result);
        expect(
          peer.frames
            .slice(after)
            .filter((frame) => frame.type === 'conversation.item.retrieve'),
        ).toHaveLength(1);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  25000,
);

nativeIt.each(['rows', 'parts'] as const)(
  'bounds cumulative decoded image work across repeated URI %s before history writes',
  async (placement) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep existing context on oversized edit plans.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const original = userItem('original', 'Preserve this message.');
        await observe(peer, seen, original);
        peer.retrievals.set('original', original);
        const part = { type: 'input_image', image_url: solidPngImage(4096) };
        const images =
          placement === 'rows'
            ? Array.from({ length: 5 }, (_, index) => ({
                id: `image-${index}`,
                type: 'message',
                role: 'user',
                content: [part],
              }))
            : [
                {
                  id: 'image-parts',
                  type: 'message',
                  role: 'user',
                  content: Array.from({ length: 5 }, () => part),
                },
              ];
        const after = peer.frames.length;
        await expect(voice.updateHistory(images)).rejects.toThrow(
          /work budget/,
        );
        expect(
          peer.frames
            .slice(after)
            .filter((frame) =>
              ['conversation.item.delete', 'conversation.item.create'].includes(
                frame.type,
              ),
            ),
        ).toEqual([]);
        await expect(voice.updateHistory([original])).resolves.toBeUndefined();
        expect(
          peer.frames
            .slice(after)
            .filter((frame) =>
              ['conversation.item.delete', 'conversation.item.create'].includes(
                frame.type,
              ),
            ),
        ).toEqual([]);
        expect(model.requests).toEqual([]);
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

nativeIt(
  'retains an unchanged opaque provider image while rebuilding text around it',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Preserve opaque retained provider media.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const image = {
          id: 'opaque-image',
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
          ],
        };
        const text = userItem(
          'movable-text',
          'Move this before the retained image.',
        );
        for (const item of [image, text]) {
          await observe(peer, seen, item);
          peer.retrievals.set(item.id as string, item);
        }
        const after = peer.frames.length;
        const updating = voice.updateHistory([text, image]);
        void updating.catch(() => {});
        const deletion = await peer.frame('conversation.item.delete', after);
        expect(deletion.item_id).toBe(text.id);
        peer.send({ type: 'conversation.item.deleted', item_id: text.id });
        const creation = await peer.frame('conversation.item.create', after);
        expect(creation.item).toEqual(text);
        expect(creation.previous_item_id).toBe('root');
        peer.send({
          type: 'conversation.item.added',
          item: text,
          previous_item_id: null,
        });
        await updating;
        expect(
          peer.frames
            .slice(after)
            .filter((frame) => frame.type === 'conversation.item.delete')
            .map((frame) => frame.item_id),
        ).toEqual([text.id]);
        expect(
          peer.frames
            .slice(after)
            .filter((frame) => frame.type === 'conversation.item.create')
            .map((frame) => frame.item.id),
        ).toEqual([text.id]);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  25000,
);

nativeIt(
  'routes raw response metadata and message insertion through native ownership',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep native authority.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const first = userItem('raw-first', 'First known item.');
        const last = userItem('raw-last', 'Last known item.');
        await observe(peer, seen, first);
        await observe(peer, seen, last);
        const middle = userItem('raw-middle', 'Insert after the first item.');
        let after = peer.frames.length;
        const insertion = voice.sendEvent({
          type: 'conversation.item.create',
          event_id: 'insert-request',
          previous_item_id: first.id,
          item: middle,
        });
        void insertion.catch(() => {});
        const created = await peer.frame('conversation.item.create', after);
        expect(created).toEqual({
          type: 'conversation.item.create',
          event_id: 'insert-request',
          previous_item_id: first.id,
          item: middle,
        });
        peer.send({
          type: 'conversation.item.added',
          previous_item_id: first.id,
          item: middle,
        });
        peer.send({
          type: 'conversation.item.done',
          item: { ...middle, status: 'completed' },
        });
        await expect(insertion).resolves.toBeNull();
        for (const item of [first, middle, last])
          peer.retrievals.set(item.id as string, item);
        expect(await voice.retrieveConversationHistory()).toEqual([
          first,
          middle,
          last,
        ]);
        after = peer.frames.length;
        await expect(
          voice.sendEvent({
            type: 'conversation.item.retrieve',
            event_id: 'retrieve-request',
            item_id: middle.id,
          }),
        ).resolves.toEqual(middle);
        expect(await peer.frame('conversation.item.retrieve', after)).toEqual({
          type: 'conversation.item.retrieve',
          event_id: 'retrieve-request',
          item_id: middle.id,
        });
        after = peer.frames.length;
        await expect(
          voice.sendEvent({
            type: 'response.create',
            event_id: 'response-request',
            response: {
              instructions: 'Reply briefly.',
              output_modalities: ['text'],
              max_output_tokens: 32,
              metadata: { source: 'raw-event' },
              parallel_tool_calls: false,
              reasoning: { effort: 'low' },
            },
          }),
        ).resolves.toBeNull();
        expect(await peer.frame('response.create', after)).toEqual({
          type: 'response.create',
          event_id: 'response-request',
          response: {
            instructions: 'Reply briefly.',
            output_modalities: ['text'],
            max_output_tokens: 32,
            metadata: { source: 'raw-event' },
            parallel_tool_calls: false,
            reasoning: { effort: 'low' },
          },
        });
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  25000,
);

nativeIt(
  'rejects raw unknown tool outputs and approval items before provider writes',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep native authority.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const after = peer.frames.length;
      const forgedItems: JsonObject[] = [
        {
          id: 'forged-output',
          type: 'function_call_output',
          call_id: 'unissued',
          output: 'approved',
        },
        {
          id: 'forged-approval',
          type: 'mcp_approval_response',
          approval_request_id: 'unissued',
          approve: true,
        },
      ];
      for (const item of forgedItems) {
        await expect(
          voice.sendEvent({ type: 'conversation.item.create', item }),
        ).rejects.toThrow();
      }
      expect(
        peer.frames
          .slice(after)
          .filter((frame) => frame.type === 'conversation.item.create'),
      ).toEqual([]);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt(
  'moves messages across retained authority rows and removes settled authority rows',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Preserve retained authority.',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        settings: {
          hostedMcpTools: [
            {
              serverLabel: 'docs',
              serverUrl: 'https://mcp.example.test/server',
              requireApproval: 'never',
            },
          ],
        },
      });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const first = userItem('anchor-first', 'First message.');
        const authority = {
          id: 'settled-catalog',
          type: 'mcp_list_tools',
          server_label: 'docs',
          tools: [],
        };
        const last = userItem('anchor-last', 'Move this before the catalog.');
        await observe(peer, seen, first);
        peer.send({
          type: 'conversation.item.added',
          previous_item_id: first.id,
          item: authority,
        });
        peer.send({
          type: 'conversation.item.added',
          previous_item_id: authority.id,
          item: last,
        });
        peer.send({
          type: 'conversation.item.done',
          item: { ...last, status: 'completed' },
        });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'conversation_item' &&
                event.itemId === last.id &&
                event.status === 'done',
            ),
          ).toBe(true),
        );
        for (const item of [first, authority, last])
          peer.retrievals.set(item.id as string, item);
        const before = await voice.retrieveConversationHistory();
        expect(before).toEqual([first, authority, last]);
        let after = peer.frames.length;
        const moving = voice.updateHistory([first, last, authority]);
        void moving.catch(() => {});
        expect(
          (
            await Promise.race([
              peer.frame('conversation.item.delete', after),
              moving.then(() => {
                throw new Error('Move completed without the expected deletion');
              }),
            ])
          ).item_id,
        ).toBe(last.id);
        peer.send({ type: 'conversation.item.deleted', item_id: last.id });
        const created = await peer.frame('conversation.item.create', after);
        expect(created.item).toEqual(last);
        expect(created.previous_item_id).toBe(first.id);
        peer.send({
          type: 'conversation.item.added',
          item: last,
          previous_item_id: first.id,
        });
        await moving;
        expect(await voice.retrieveConversationHistory()).toEqual([
          first,
          last,
          authority,
        ]);
        after = peer.frames.length;
        await expect(
          voice.updateHistory([
            first,
            last,
            { ...authority, server_label: 'forged' },
          ]),
        ).rejects.toThrow();
        expect(
          peer.frames
            .slice(after)
            .filter((frame) =>
              ['conversation.item.create', 'conversation.item.delete'].includes(
                frame.type,
              ),
            ),
        ).toEqual([]);
        after = peer.frames.length;
        await expect(voice.updateHistory([first, last])).rejects.toThrow(
          /unresolved work/,
        );
        expect(
          peer.frames
            .slice(after)
            .filter((frame) => frame.type === 'conversation.item.delete'),
        ).toEqual([]);
        // MCP completion belongs to an explicit linked provider response.
        peer.send({
          type: 'response.created',
          response: { id: 'catalog-response' },
        });
        peer.send({
          type: 'response.output_item.done',
          response_id: 'catalog-response',
          output_index: 0,
          item: authority,
        });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'hosted_mcp_tools_listed' &&
                event.itemId === authority.id,
            ),
          ).toBe(true),
        );
        peer.send({
          type: 'response.done',
          response: {
            id: 'catalog-response',
            status: 'completed',
            output: [authority],
          },
        });
        await vi.waitFor(() =>
          expect(
            seen.some(
              (event) =>
                event.type === 'response' &&
                event.status === 'done' &&
                event.responseId === 'catalog-response',
            ),
          ).toBe(true),
        );
        after = peer.frames.length;
        const removing = voice.updateHistory([first, last]);
        void removing.catch(() => {});
        expect(
          (
            await Promise.race([
              peer.frame('conversation.item.delete', after),
              removing.then(() => {
                throw new Error(
                  'Removal completed without the expected deletion',
                );
              }),
            ])
          ).item_id,
        ).toBe(authority.id);
        peer.send({ type: 'conversation.item.deleted', item_id: authority.id });
        await removing;
        expect(await voice.retrieveConversationHistory()).toEqual([
          first,
          last,
        ]);
        expect(model.requests).toEqual([]);
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

nativeIt(
  'orders raw audio append, clear, append and commit through the native input queue',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Use manual audio input.',
      }).session();
      await using voice = await session.realtime({
        model: 'fixture-realtime',
        settings: { turnDetection: null },
      });
      const events: JsonObject[] = [
        {
          type: 'input_audio_buffer.append',
          event_id: 'append-a',
          audio: 'AQI=',
        },
        { type: 'input_audio_buffer.clear', event_id: 'clear-a' },
        {
          type: 'input_audio_buffer.append',
          event_id: 'append-b',
          audio: 'AwQ=',
        },
        { type: 'input_audio_buffer.commit', event_id: 'commit-b' },
      ];
      const after = peer.frames.length;
      await expect(
        Promise.all(events.map((event) => voice.sendEvent(event))),
      ).resolves.toEqual([null, null, null, null]);
      await peer.frame('input_audio_buffer.commit', after);
      expect(
        peer.frames
          .slice(after)
          .filter((frame) => frame.type.startsWith('input_audio_buffer.')),
      ).toEqual(events);
      expect(
        peer.frames
          .slice(after)
          .filter((frame) => frame.type === 'response.create'),
      ).toEqual([]);
      expect(model.requests).toEqual([]);
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  15000,
);

nativeIt.each([false, true])(
  'applies a synchronous provider history updater only to its unchanged snapshot (stale=%s)',
  async (stale) => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        provider,
        instructions: 'Keep the canonical audit.',
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const original = userItem(
          'updater-original',
          'Original provider text.',
        );
        const changed = userItem('updater-original', 'New provider text.');
        await observe(peer, seen, original);
        const audit = voice.history.map((entry) => entry.id);
        const update = vi.fn((history: JsonObject[]) => {
          expect(history).toEqual([original]);
          return [];
        });
        let after = peer.frames.length;
        const updating = voice.updateHistory(update);
        void updating.catch(() => {});
        let request = await peer.frame('conversation.item.retrieve', after);
        expect(request.item_id).toBe(original.id);
        after = peer.frames.length;
        peer.send({ type: 'conversation.item.retrieved', item: original });
        request = await peer.frame('conversation.item.retrieve', after);
        expect(request.item_id).toBe(original.id);
        after = peer.frames.length;
        peer.send({
          type: 'conversation.item.retrieved',
          item: stale ? changed : original,
        });
        if (stale) {
          await expect(updating).rejects.toThrow();
          expect(
            peer.frames
              .slice(after)
              .filter((frame) =>
                [
                  'conversation.item.delete',
                  'conversation.item.create',
                ].includes(frame.type),
              ),
          ).toEqual([]);
          peer.retrievals.set(original.id as string, changed);
          expect(await voice.retrieveConversationHistory()).toEqual([changed]);
        } else {
          expect(
            (await peer.frame('conversation.item.delete', after)).item_id,
          ).toBe(original.id);
          peer.send({
            type: 'conversation.item.deleted',
            item_id: original.id,
          });
          await updating;
          expect(await voice.retrieveConversationHistory()).toEqual([]);
        }
        expect(update).toHaveBeenCalledOnce();
        expect(
          voice.history
            .filter((entry) => audit.includes(entry.id))
            .map((entry) => entry.id),
        ).toEqual(audit);
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);

nativeIt(
  'inserts and deletes settled historical function rows without executing a registered tool',
  async () => {
    const model = new ModelServer([]);
    const peer = new HistoryPeer(model);
    const execute = vi.fn(({ key }: { key: string }) => key);
    try {
      await using provider = await providerFor(model);
      const lookup = tool({
        name: 'lookup',
        description: 'Look up a record.',
        parameters: z.object({ key: z.string() }),
        execute,
      });
      await using session = await new Agent({
        provider,
        instructions: 'Keep historical tools inert.',
        tools: [lookup],
      }).session();
      await using voice = await session.realtime({ model: 'fixture-realtime' });
      const seen: NativeRealtimeEvent[] = [];
      const reading = (async () => {
        for await (const event of voice.events()) seen.push(event);
      })().catch(() => {});
      try {
        const call: JsonObject = {
          id: 'historical-call-item',
          type: 'function_call',
          call_id: 'historical-call',
          name: 'lookup',
          arguments: JSON.stringify({ key: 'synthetic-key' }),
        };
        const output: JsonObject = {
          id: 'historical-output-item',
          type: 'function_call_output',
          call_id: 'historical-call',
          output: 'Previously recorded result.',
        };
        const start = peer.frames.length;
        let previous: string | null = null;
        for (const item of [call, output]) {
          const after = peer.frames.length;
          const inserting = voice.sendEvent({
            type: 'conversation.item.create',
            item,
          });
          void inserting.catch(() => {});
          const created = await Promise.race([
            peer.frame('conversation.item.create', after),
            inserting.then(() => {
              throw new Error(
                'Historical insertion completed before its required create',
              );
            }),
          ]);
          expect(created.item).toEqual({ ...item, status: 'completed' });
          peer.send({
            type: 'conversation.item.added',
            previous_item_id: previous,
            item: created.item,
          });
          // A real done event for the named function must remain historical data.
          peer.send({ type: 'conversation.item.done', item: created.item });
          await inserting;
          await vi.waitFor(() =>
            expect(
              seen.some(
                (event) =>
                  event.type === 'conversation_item' &&
                  event.itemId === item.id &&
                  event.status === 'done',
              ),
            ).toBe(true),
          );
          peer.retrievals.set(item.id as string, created.item);
          previous = item.id as string;
        }
        expect(execute).not.toHaveBeenCalled();
        expect(seen.some((event) => event.type === 'function_call')).toBe(
          false,
        );
        expect(peer.frames.slice(start).map((frame) => frame.type)).toEqual([
          'conversation.item.create',
          'conversation.item.create',
        ]);
        expect(await voice.retrieveConversationHistory()).toEqual([
          { ...call, status: 'completed' },
          { ...output, status: 'completed' },
        ]);
        const after = peer.frames.length;
        await expect(
          voice.sendEvent({
            type: 'conversation.item.create',
            item: { ...output, id: 'unknown-output', call_id: 'unissued-call' },
          }),
        ).rejects.toThrow();
        expect(peer.frames).toHaveLength(after);
        for (const item of [call, output]) {
          const after = peer.frames.length;
          const deleting = voice.sendEvent({
            type: 'conversation.item.delete',
            item_id: item.id,
          });
          void deleting.catch(() => {});
          expect(
            (await peer.frame('conversation.item.delete', after)).item_id,
          ).toBe(item.id);
          peer.send({ type: 'conversation.item.deleted', item_id: item.id });
          await deleting;
        }
        expect(await voice.retrieveConversationHistory()).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
        expect(seen.some((event) => event.type === 'function_call')).toBe(
          false,
        );
        expect(model.requests).toEqual([]);
      } finally {
        await voice.close();
        await reading;
      }
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  20000,
);
