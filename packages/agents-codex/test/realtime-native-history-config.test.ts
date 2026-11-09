import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { Agent, NativeProvider, tool, type NativeRealtimeEvent } from '../src';
import type { JsonObject } from '../src/runtime/binding';
import { ModelServer } from './native/fixtures/model-server';

type Frame = Record<string, any>;

// Only the independent provider protocol is scripted; public Session, binding,
// native configuration, reconciliation, and generation ownership execute normally.
class HistoryPeer {
  readonly frames: Frame[] = [];
  readonly models: (string | null)[] = [];
  readonly retrievals = new Map<string, JsonObject>();
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
          Object.assign(session, frame.session);
          this.send({
            type: 'session.updated',
            session: { ...session, id: 'history-fixture' },
          });
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
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
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
