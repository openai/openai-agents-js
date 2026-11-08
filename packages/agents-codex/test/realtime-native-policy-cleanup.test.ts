import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { Agent, NativeProvider, backgroundResult, tool } from '../src';
import { ModelServer, message } from './native/fixtures/model-server';

type Frame = Record<string, any>;

// This peer scripts provider frames only. Session, policy admission, callback
// cancellation and native root settlement all use the real binding.
class PolicyPeer {
  readonly frames: Frame[] = [];
  private readonly server = new WebSocketServer({ noServer: true });
  private socket?: WebSocket;
  readonly disconnected = Promise.withResolvers<void>();
  constructor(model: ModelServer) {
    model.onUpgrade((request, transport, head) => {
      this.server.handleUpgrade(request, transport, head, (connection) =>
        this.server.emit('connection', connection, request),
      );
    });
    this.server.on('connection', (connection) => {
      this.socket = connection;
      connection.once('close', () => this.disconnected.resolve());
      const accepted: Frame = {};
      connection.on('message', (raw) => {
        const frame: Frame = JSON.parse(raw.toString());
        this.frames.push(frame);
        if (frame.type === 'session.update') {
          merge(accepted, frame.session);
          this.send({
            type: 'session.updated',
            session: { ...structuredClone(accepted), id: 'policy-session' },
          });
        } else if (frame.type === 'response.create') {
          const id = `continuation-${this.frames.length}`;
          this.send({ type: 'response.created', response: { id } });
          this.send({ type: 'response.done', response: { id, output: [] } });
        }
      });
    });
  }
  private send(frame: Frame): void {
    if (!this.socket) throw new Error('Provider is not connected');
    this.socket.send(JSON.stringify(frame));
  }
  call(name: string, args: Frame, callId: string): string {
    const responseId = `response-${callId}`;
    const item = {
      id: `item-${callId}`,
      type: 'function_call',
      name,
      call_id: callId,
      arguments: JSON.stringify(args),
    };
    this.send({ type: 'response.created', response: { id: responseId } });
    this.send({
      type: 'response.output_item.done',
      response_id: responseId,
      output_index: 0,
      item,
    });
    this.send({
      type: 'response.done',
      response: { id: responseId, output: [item] },
    });
    return responseId;
  }
  async output(callId: string): Promise<string> {
    let result: Frame | undefined;
    await vi.waitFor(
      () => {
        result = this.frames.find(
          (frame) =>
            frame.type === 'conversation.item.create' &&
            frame.item?.type === 'function_call_output' &&
            frame.item.call_id === callId,
        );
        expect(result).toBeDefined();
      },
      { timeout: 10000 },
    );
    return result!.item.output;
  }
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
function merge(current: Frame, update: Frame): void {
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
}
async function providerFor(model: ModelServer): Promise<NativeProvider> {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-policy',
    supportsWebsockets: false,
  });
}
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt.each(['deny', 'replaceArguments'] as const)(
  'runs native Realtime function input policy %s before execution',
  async (action) => {
    const execute = vi.fn(({ value }: { value: string }) => value);
    const before = vi.fn(() =>
      action === 'deny'
        ? { action: 'deny' as const, reason: 'Unavailable' }
        : {
            action: 'replaceArguments' as const,
            arguments: { value: 'approved' },
          },
    );
    const selected = tool({
      name: 'checked',
      parameters: z.object({ value: z.string() }),
      before,
      execute,
    });
    const model = new ModelServer([]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Help.',
        model: 'gpt-5.5',
        provider,
        tools: [selected],
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      try {
        peer.call('checked', { value: 'original' }, 'checked-call');
        const output = await peer.output('checked-call');
        expect(before).toHaveBeenCalledOnce();
        if (action === 'deny') {
          expect(execute).not.toHaveBeenCalled();
          expect(output).toContain('Unavailable');
        } else {
          expect(execute).toHaveBeenCalledOnce();
          expect(execute.mock.calls[0][0]).toEqual({ value: 'approved' });
          expect(output).toContain('approved');
        }
        expect(model.requests).toHaveLength(0);
      } finally {
        await voice.close();
      }
      model.assertExhausted();
    } finally {
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);

for (const phase of ['before', 'execute'] as const) {
  nativeIt.each(['interrupt', 'close'] as const)(
    'joins the last Realtime ' +
      phase +
      ' callback cleanup beyond 100ms during %s',
    async (operation) => {
      const entered = Promise.withResolvers<void>();
      const cleaning = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cleaned = vi.fn();
      const held = async (signal: AbortSignal): Promise<void> => {
        entered.resolve();
        try {
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        } finally {
          cleaning.resolve();
          await release.promise;
          cleaned();
        }
      };
      const execute = vi.fn(
        async (_args: unknown, { signal }: { signal: AbortSignal }) => {
          if (phase === 'execute') await held(signal);
          return 'LATE_CALLBACK_MARKER';
        },
      );
      const selected = tool({
        name: 'held',
        parameters: z.object({}),
        execute,
        ...(phase === 'before'
          ? {
              before: async ({ signal }: { signal: AbortSignal }) => {
                await held(signal);
                return { action: 'allow' as const };
              },
            }
          : {}),
      });
      const model = new ModelServer([[message('Caller remains open.')]]);
      const peer = new PolicyPeer(model);
      try {
        await using provider = await providerFor(model);
        await using session = await new Agent({
          instructions: 'Help.',
          model: 'gpt-5.5',
          provider,
          tools: [selected],
        }).session();
        const voice = await session.realtime({ model: 'fixture-realtime' });
        try {
          const responseId = peer.call('held', {}, 'held-call');
          await entered.promise;
          let settled = false;
          const stopping = (
            operation === 'close' ? voice.close() : voice.interrupt(responseId)
          ).finally(() => {
            settled = true;
          });
          void stopping.catch(() => {});
          await cleaning.promise;
          await delay(200);
          expect(settled).toBe(false);
          expect(cleaned).not.toHaveBeenCalled();
          release.resolve();
          await stopping;
          expect(cleaned).toHaveBeenCalledOnce();
          if (phase === 'before') expect(execute).not.toHaveBeenCalled();
          expect(
            (await (await session.submit('continue')).wait()).finalOutput,
          ).toBe('Caller remains open.');
        } finally {
          release.resolve();
          await voice.close();
        }
        await peer.disconnected.promise;
        expect(
          peer.frames.filter(
            (frame) =>
              frame.type === 'conversation.item.create' &&
              frame.item?.type === 'function_call_output' &&
              frame.item.call_id === 'held-call',
          ),
        ).toEqual([]);
        model.assertExhausted();
      } finally {
        release.resolve();
        await peer.close();
        await ModelServer.closeAll();
      }
    },
    30000,
  );
}

nativeIt.each([false, true])(
  'runs overlapping public response tools on one native root and preserves background=%s',
  async (background) => {
    const enteredA = vi.fn();
    const enteredB = vi.fn();
    const stoppedA = vi.fn();
    const releaseA = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    let signalB: AbortSignal | undefined;
    const a = tool({
      name: 'wait_a',
      parameters: z.object({}),
      execute: async (_args, { signal }) => {
        enteredA();
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
            void releaseA.promise.then(resolve);
          });
        } finally {
          stoppedA();
        }
        return 'FORBIDDEN_A_LATE_OUTPUT';
      },
    });
    const b = tool({
      name: 'wait_b',
      parameters: z.object({}),
      execute: async (_args, { signal }) => {
        signalB = signal;
        enteredB();
        await releaseB.promise;
        return background ? backgroundResult('B accepted') : 'B accepted';
      },
    });
    const model = new ModelServer([[message('Caller remains open.')]]);
    const peer = new PolicyPeer(model);
    try {
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use the declared tools.',
        model: 'gpt-5.5',
        provider,
        tools: [a, b],
      }).session();
      const voice = await session.realtime({ model: 'fixture-realtime' });
      const observations = session.events();
      const roots = new Set<string>();
      const rootDone = (async () => {
        for await (const event of observations) {
          if (event.type === 'turn_started') roots.add(event.turnId!);
          if (event.type === 'turn_finished') return;
        }
      })();
      void rootDone.catch(() => {});
      try {
        const responseA = peer.call('wait_a', {}, 'overlap-a');
        await vi.waitFor(() => expect(enteredA).toHaveBeenCalledOnce(), {
          timeout: 10000,
        });
        peer.call('wait_b', {}, 'overlap-b');
        // B must enter while A has not returned. A sequential new root fails this.
        await vi.waitFor(() => expect(enteredB).toHaveBeenCalledOnce(), {
          timeout: 10000,
        });
        expect(stoppedA).not.toHaveBeenCalled();
        await voice.interrupt(responseA);
        await vi.waitFor(() => expect(stoppedA).toHaveBeenCalledOnce());
        expect(signalB!.aborted).toBe(false);
        const followups = peer.frames.filter(
          (frame) => frame.type === 'response.create',
        ).length;
        releaseB.resolve();
        expect(await peer.output('overlap-b')).toContain('B accepted');
        await rootDone;
        // A settings ACK fences the local provider writer after batch completion.
        await voice.update({ instructions: 'Completed native tools.' });
        expect(roots.size).toBe(1);
        expect(
          peer.frames.filter((frame) => frame.type === 'response.create'),
        ).toHaveLength(followups + (background ? 0 : 1));
        expect(model.requests).toHaveLength(0);
      } finally {
        releaseA.resolve();
        releaseB.resolve();
        await observations.return?.();
        await voice.close();
      }
      await peer.disconnected.promise;
      expect(
        peer.frames.filter(
          (frame) =>
            frame.type === 'conversation.item.create' &&
            frame.item?.type === 'function_call_output' &&
            frame.item.call_id === 'overlap-a',
        ),
      ).toEqual([]);
      expect(
        (await (await session.submit('continue')).wait()).finalOutput,
      ).toBe('Caller remains open.');
      model.assertExhausted();
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await peer.close();
      await ModelServer.closeAll();
    }
  },
  30000,
);
