import type { NativeEventBatch } from '../fixtures/native-event-batches';
import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  manualTool,
  tool,
  type ActionRequested,
  type ChildInvocation,
  type ToolContext,
} from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle`)),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Reorder only real wire batches at the existing native boundary. Native has
// observed the retained start; JS has not. Keep exactly one pending native read
// when releasing the start, retaining complete arrays and original rejections.
async function holdChildStart(missingLookup: boolean) {
  const addon = await binding();
  const next = addon.NativeThread.prototype._next_session_events;
  const lookup = addon.NativeThread.prototype._child_turn;
  const lookupUnavailable = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const end = Promise.withResolvers<void>();
  const startCaptured = Promise.withResolvers<void>();
  const callbackDelivered = Promise.withResolvers<void>();
  const readerFailure = new Error(
    'Controlled child observation reader failure',
  );
  let released = false;
  onTestFinished(() => {
    released = true;
    release.resolve();
  });
  if (missingLookup) {
    // Explicit fault injection, not a real-native absence claim. Retain the
    // actual query/handle; simulate only the observed null-before-publication
    // condition until the exact ordered start can reach JS.
    vi.spyOn(addon.NativeThread.prototype, '_child_turn').mockImplementation(
      async function (this: NativeThread, childId: string) {
        const actual = await lookup.call(this, childId);
        if (!released) {
          lookupUnavailable.resolve();
          return null;
        }
        return actual;
      },
    );
  }
  let captured = false;
  let start: NativeEventBatch | undefined;
  let callback: NativeEventBatch | undefined;
  let pending:
    | Promise<
        | { kind: 'native'; raw: NativeEventBatch }
        | { kind: 'error'; error: unknown }
      >
    | undefined;
  vi.spyOn(
    addon.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(async function (this: NativeThread) {
    for (;;) {
      if (start && released) {
        const raw = start;
        start = undefined;
        return raw;
      }
      if (start && callback) {
        const raw = callback;
        callback = undefined;
        callbackDelivered.resolve();
        return raw;
      }
      pending ??= next.call(this).then(
        (raw) => ({ kind: 'native' as const, raw }),
        (error) => ({ kind: 'error' as const, error }),
      );
      const result = await Promise.race([
        pending,
        end.promise.then(() => ({ kind: 'end' as const })),
        ...(start && !released
          ? [release.promise.then(() => ({ kind: 'release' as const }))]
          : []),
      ]);
      if (result.kind === 'end') throw readerFailure;
      if (result.kind === 'release') continue;
      pending = undefined;
      if (result.kind === 'error') throw result.error;
      const event = JSON.parse(firstNativeBatchWire(result.raw));
      if (
        !captured &&
        event.subagent_id &&
        ['task_started', 'turn_started'].includes(event.msg.type)
      ) {
        captured = true;
        start = result.raw;
        startCaptured.resolve();
        continue;
      }
      if (
        !released &&
        event.subagent_id &&
        event.msg.type === 'dynamic_tool_call_request' &&
        event.msg.callId === 'child-lookup'
      ) {
        callback = result.raw;
        continue;
      }
      return result.raw;
    }
  });
  return {
    lookupUnavailable: lookupUnavailable.promise,
    startCaptured: startCaptured.promise,
    callbackDelivered: callbackDelivered.promise,
    release() {
      released = true;
      release.resolve();
    },
    endReader() {
      end.resolve();
    },
  };
}

it.each([
  'valid',
  'release',
  'cancel',
  'close',
  'reader-end',
  'manual-valid',
  'manual-missing',
] as const)(
  'owns a child callback whose ordered start is held until %s',
  async (mode) => {
    const missingLookup = !['valid', 'manual-valid'].includes(mode);
    const gate = await holdChildStart(missingLookup);
    const executor = await startPublicExecutor();
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id === rootId)
        return count === 1
          ? [
              call(
                'spawn_agent',
                { task_name: 'child', message: 'Look up the record.' },
                { namespace: 'collaboration', callId: 'spawn' },
              ),
            ]
          : [message('root done')];
      return count === 1
        ? [call('lookup', { key: 'record' }, { callId: 'child-lookup' })]
        : [message('child done')];
    };
    const server = new ModelServer(Array.from({ length: 4 }, () => respond));
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-child-publication',
      supportsWebsockets: false,
    });
    const context = { value: 'found' };
    const called = Promise.withResolvers<ToolContext<typeof context>>();
    let calls = 0;
    const agent = new Agent<typeof context>({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new NativeAgents(),
        mode.startsWith('manual-')
          ? manualTool({
              name: 'lookup',
              description: 'Look up a record.',
              parameters: z.object({ key: z.string() }),
              result: z.string(),
            })
          : tool({
              name: 'lookup',
              parameters: z.object({ key: z.string() }),
              execute(_, ctx: ToolContext<typeof context>) {
                calls++;
                called.resolve(ctx);
                return ctx.context.value;
              },
            }),
      ],
    });
    let session: Awaited<ReturnType<typeof agent.session>> | undefined;
    try {
      session = await agent.session({
        context,
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const root = await session.submit('begin');
      await within(gate.startCaptured, 'captured real child start');
      await within(gate.callbackDelivered, 'real child lookup delivery');
      expect((await within(root.wait(), 'root completion')).finalOutput).toBe(
        'root done',
      );
      if (!mode.startsWith('manual-')) {
        if (mode === 'valid') {
          // A valid native receipt must not wait for a duplicate JS start.
          await within(
            called.promise,
            'already-published native child callback',
          );
        } else {
          await within(
            gate.lookupUnavailable,
            'injected missing native lookup',
          );
          // Check the public effect after the missing-lookup branch was entered.
          expect(
            await Promise.race([
              called.promise.then(() => 'called'),
              new Promise<string>((resolve) =>
                setTimeout(() => resolve('held'), 50),
              ),
            ]),
          ).toBe('held');
        }
      }
      const children = [];
      for await (const child of session.subagents()) children.push(child);
      expect(children).toHaveLength(1);
      const child = children[0];
      expect(child.isLive).toBe(true);
      expect(child.turn).not.toBeNull();
      const turn = child.turn!;
      if (mode.startsWith('manual-')) {
        const request = await within(
          (async () => {
            for await (const event of session!.events()) {
              if (
                event.type === 'action_requested' &&
                event.subagentId === child.id
              )
                return event as ActionRequested;
            }
            throw new Error('Missing immediate child manual request');
          })(),
          'published child manual request',
        );
        expect(request.call).toMatchObject({
          sessionId: session.id,
          childId: child.id,
          turnId: turn.turnId,
          childIncarnation: turn.submissionId.split(':').at(-2),
          callId: 'child-lookup',
        });
        const replying = child.submit(request.reply('found'));
        if (mode === 'manual-valid') {
          // Preserve immediate replies, including the no-new-start shape used
          // by restored manual state: the actual native receipt is sufficient.
          expect(
            await within(replying, 'already-published child manual reply'),
          ).toBe(turn);
          gate.release();
        } else {
          await within(gate.lookupUnavailable, 'manual missing native lookup');
          expect(
            await Promise.race([
              replying.then(
                () => 'settled',
                () => 'rejected',
              ),
              new Promise<string>((resolve) =>
                setTimeout(() => resolve('held'), 50),
              ),
            ]),
          ).toBe('held');
          gate.release();
          expect(await within(replying, 'immediate child manual reply')).toBe(
            turn,
          );
        }
        expect(
          (await within(turn.wait(), 'manual child completion')).finalOutput,
        ).toBe('child done');
        expect(calls).toBe(0);
        server.assertExhausted();
      } else if (mode === 'release' || mode === 'valid') {
        gate.release();
        const observed = await within(
          called.promise,
          'released child callback',
        );
        expect(observed.context).toBe(context);
        expect(observed.submission).toMatchObject({
          sessionId: session.id,
          childId: child.id,
          turnId: turn.turnId,
        } satisfies Partial<ChildInvocation>);
        expect(observed.call).toMatchObject({
          sessionId: session.id,
          childId: child.id,
          turnId: turn.turnId,
          childIncarnation: turn.submissionId.split(':').at(-2),
          callId: 'child-lookup',
        });
        expect(
          (await within(turn.wait(), 'child completion')).finalOutput,
        ).toBe('child done');
        expect(calls).toBe(1);
        server.assertExhausted();
      } else {
        if (mode === 'cancel')
          expect(
            await within(child.tryCancel(turn), 'child cancellation'),
          ).toBe(true);
        else if (mode === 'close')
          await within(session.close(), 'close with unpublished child start');
        else gate.endReader();
        const outcome = await within(
          turn.wait().catch((error) => error),
          'retired child completion',
        );
        expect(outcome).toBeInstanceOf(Error);
        expect(calls).toBe(0);
      }
    } finally {
      gate.release();
      try {
        await session?.close().catch((error) => {
          if (mode !== 'reader-end') throw error;
        });
      } finally {
        await provider.close();
        await executor.close();
      }
    }
  },
  20000,
);
