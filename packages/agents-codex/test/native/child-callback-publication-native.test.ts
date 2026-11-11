import { AsyncLocalStorage } from 'node:async_hooks';
import type { NativeEventBatch } from '../fixtures/native-event-batches';
import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  TraceContext,
  TurnNotSubmitted,
  manualTool,
  telemetry,
  tool,
  toolRef,
  type ActionRequested,
  type ChildInvocation,
  type ToolContext,
} from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ChildCallbacks } from '../../src/runtime/child-callbacks';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

beforeAll(async () => {
  await telemetry.configure({ traceProcessors: [{ onEvent() {} }] });
});

afterAll(async () => {
  await telemetry.shutdown();
});

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
async function holdChildStart(
  missingLookup: boolean,
  beforeCallback?: () => Promise<void>,
) {
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
        if (beforeCallback) await beforeCallback();
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
  'trace-storage',
  'builtin-trace-storage',
  'missing-trace-admission',
  'keyed-trace-miss',
  'conflicting-trace-admissions',
  'joined-trace-cancel',
  'release',
  'cancel',
  'close',
  'reader-end',
  'manual-valid',
  'manual-missing',
] as const)(
  'owns a child callback whose ordered start is held until %s',
  async (mode) => {
    const builtinStorage = mode === 'builtin-trace-storage';
    const missingAdmission = mode === 'missing-trace-admission';
    const keyedMiss = mode === 'keyed-trace-miss';
    const conflicts = mode === 'conflicting-trace-admissions';
    const joinedCancel = mode === 'joined-trace-cancel';
    const traceStorage =
      mode === 'trace-storage' ||
      builtinStorage ||
      keyedMiss ||
      conflicts ||
      joinedCancel;
    const observeStorage = traceStorage || missingAdmission;
    const missingLookup =
      !observeStorage && !['valid', 'manual-valid'].includes(mode);
    let captureKeyedTurn: (() => Promise<void>) | undefined;
    const gate = await holdChildStart(
      missingLookup,
      keyedMiss ? () => captureKeyedTurn!() : undefined,
    );
    const addon = await binding();
    const owners = vi.spyOn(ChildCallbacks.prototype, 'owner');
    const registry = () => owners.mock.calls.at(-1)?.[3].callbackTraceStorages;
    const retain = addon._retain_callback_dispatch_context;
    const dispatch =
      conflicts || joinedCancel
        ? vi.spyOn(addon, '_retain_callback_dispatch_context')
        : undefined;
    const nativeReleases: (() => void)[] = [];
    if (joinedCancel) {
      dispatch!.mockImplementation((handle, key, release) =>
        retain(handle, key, () => {
          nativeReleases.push(release);
        }),
      );
    }
    const storageAtSubmit = new Map<string, unknown>();
    if (conflicts) {
      const submit = addon.NativeThread.prototype._submit;
      vi.spyOn(addon.NativeThread.prototype, '_submit').mockImplementation(
        function (this: NativeThread, wire) {
          const key = dispatch?.mock.calls.at(-1)?.[1];
          const entry = key === undefined ? undefined : registry()?.get(key);
          if (key !== undefined && entry)
            storageAtSubmit.set(key, entry.storage);
          return submit.call(this, wire);
        },
      );
    }
    let missed: { key: string; handle: string } | undefined;
    const releaseTraceSpan = vi.spyOn(addon, 'release_trace_span');
    if (keyedMiss) {
      const startTraceSpan = addon.start_trace_span;
      vi.spyOn(addon, 'start_trace_span').mockImplementation((options) => {
        const raw = startTraceSpan(options);
        if (JSON.parse(options).kind === 'callback') {
          const span = JSON.parse(raw);
          const key = span.callback_storage_key;
          if (typeof key === 'string' && registry()?.delete(key))
            missed = { key, handle: span.handle };
        }
        return raw;
      });
    }
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
    const server = new ModelServer(
      Array.from({ length: keyedMiss ? 3 : 4 }, () => respond),
    );
    const config = await server.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-child-publication',
      supportsWebsockets: false,
    });
    const context = { value: 'found' };
    const called = Promise.withResolvers<ToolContext<typeof context>>();
    const aborted = Promise.withResolvers<void>();
    const releaseCallback = Promise.withResolvers<void>();
    const openingStorage = new AsyncLocalStorage<telemetry.TraceSpan>();
    const openingRuns = vi.spyOn(openingStorage, 'run');
    const submissionStorage = new AsyncLocalStorage<telemetry.TraceSpan>();
    const snapshot = () => ({
      span: telemetry.getCurrentSpan(),
      workflow: telemetry.getCurrentTrace(),
      opening: openingStorage.getStore(),
      submission: submissionStorage.getStore(),
    });
    const storageSnapshots: ReturnType<typeof snapshot>[] = [];
    const fallbackParent = new TraceContext({
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    let fallbackEntrySpan: telemetry.TraceSpan | undefined;
    let submissionSpan: telemetry.TraceSpan | undefined;
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
                if (joinedCancel)
                  ctx.signal.addEventListener(
                    'abort',
                    () => aborted.resolve(),
                    {
                      once: true,
                    },
                  );
                if (missingAdmission) {
                  // A W3C parent supplies native ancestry without admitting a JS span.
                  fallbackEntrySpan = telemetry.getCurrentSpan();
                  return telemetry.withSpan(
                    { name: 'fallback probe' },
                    async () => {
                      storageSnapshots.push(snapshot());
                      called.resolve(ctx);
                      await releaseCallback.promise;
                      storageSnapshots.push(snapshot());
                      return ctx.context.value;
                    },
                  );
                }
                if (traceStorage) storageSnapshots.push(snapshot());
                called.resolve(ctx);
                if (traceStorage)
                  return releaseCallback.promise.then(() => {
                    storageSnapshots.push(snapshot());
                    return ctx.context.value;
                  });
                return ctx.context.value;
              },
            }),
      ],
    });
    let session: Awaited<ReturnType<typeof agent.session>> | undefined;
    let keyedWait: Promise<unknown> | undefined;
    try {
      if (observeStorage) telemetry.setTraceContextStorage(openingStorage);
      session = await agent.session({
        context,
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const opened = session;
      if (keyedMiss) {
        captureKeyedTurn = async () => {
          const children = await within(
            Array.fromAsync(opened.subagents()),
            'capture child before callback delivery',
          );
          expect(children).toHaveLength(1);
          expect(children[0]?.turn).not.toBeNull();
          keyedWait = children[0]!
            .turn!.wait()
            .catch((error: unknown) => error);
        };
      }
      if (observeStorage)
        telemetry.setTraceContextStorage(
          traceStorage && !builtinStorage ? submissionStorage : undefined,
        );
      const root = traceStorage
        ? await telemetry.withSpan({ name: 'standalone' }, (span) => {
            submissionSpan = span;
            return opened.submit('begin');
          })
        : await opened.submit(
            'begin',
            missingAdmission ? { parentTrace: fallbackParent } : undefined,
          );
      await within(gate.startCaptured, 'captured real child start');
      await within(gate.callbackDelivered, 'real child lookup delivery');
      expect((await within(root.wait(), 'root completion')).finalOutput).toBe(
        'root done',
      );
      if (keyedMiss) {
        gate.release();
        const outcome = await within(keyedWait!, 'keyed miss');
        expect(outcome).toBeInstanceOf(Error);
        expect(outcome).toMatchObject({
          message: 'Native child callback trace ownership unavailable',
        });
        expect(missed?.key).toBeTruthy();
        expect(releaseTraceSpan).toHaveBeenCalledWith(missed?.handle);
        expect(() => addon.retain_trace_context(missed!.handle)).toThrow();
        expect(
          openingRuns.mock.calls.filter(([span]) => span?.kind === 'callback'),
        ).toEqual([]);
        expect(calls).toBe(0);
        server.assertExhausted();
        return;
      }
      if (!mode.startsWith('manual-')) {
        if (!missingLookup) {
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
      expect(child.turn).not.toBeNull();
      const turn = child.turn!;
      expect(child.isLive).toBe(true);
      if (conflicts) {
        const entries = registry()!;
        const liveKey = dispatch!.mock.calls[0]![1];
        const liveEntry = entries.get(liveKey);
        expect(liveEntry?.storage).toBe(submissionStorage);
        expect(liveEntry?.entered).toBe(1);
        const rejected: string[] = [];
        const retainedSpans: telemetry.TraceSpan[] = [
          submissionSpan!,
          storageSnapshots[0]!.span!,
        ];
        for (let index = 0; index < 5; index++) {
          const fresh = new AsyncLocalStorage<telemetry.TraceSpan>();
          telemetry.setTraceContextStorage(fresh);
          const result = await telemetry
            .withSpan({ name: `conflict ${index}` }, (span) => {
              retainedSpans.push(span);
              expect(fresh.getStore()).toBe(span);
              return opened.submit('conflicting native trace', {
                parentTrace: fallbackParent,
              });
            })
            .catch((error: unknown) => error);
          expect(result).toBeInstanceOf(TurnNotSubmitted);
          expect(result).toMatchObject({
            reason: { type: 'trace_context_conflict' },
          });
          const rejectedKey = dispatch!.mock.calls.at(-1)![1];
          expect(storageAtSubmit.get(rejectedKey)).toBe(fresh);
          rejected.push(rejectedKey);
        }
        expect(new Set([liveKey, ...rejected]).size).toBe(6);
        await vi.waitFor(() => {
          expect([...entries.keys()]).toEqual([liveKey]);
          expect(entries.get(liveKey)).toBe(liveEntry);
        });
        expect(retainedSpans).toHaveLength(7);
      }
      if (joinedCancel) {
        gate.release();
        const entries = registry()!;
        const key = dispatch!.mock.calls[0]![1];
        const entry = entries.get(key);
        expect(entry?.entered).toBe(1);
        const callbackSpan = storageSnapshots[0]?.span;
        expect(callbackSpan).toBeDefined();
        const waited = turn.wait().catch((error: unknown) => error);
        let joined = false;
        const cancellation = child
          .tryCancel(turn)
          .finally(() => (joined = true));
        void cancellation.catch(() => {});
        await within(aborted.promise, 'exact cancellation signal');
        expect(joined).toBe(false);
        expect(entries.get(key)).toBe(entry);
        releaseCallback.resolve();
        expect(await within(cancellation, 'exact callback join')).toBe(true);
        expect(await within(waited, 'cancelled child')).toBeInstanceOf(Error);
        expect(storageSnapshots[0]?.submission).toBe(callbackSpan);
        expect(storageSnapshots[1]?.submission).toBe(callbackSpan);
        expect(entry?.entered).toBe(0);
        // Exact turn cancellation leaves the live child available for new work.
        expect(entries.get(key)).toBe(entry);
        const later = await within(
          child.submit('continue on the same child'),
          'new child submission',
        );
        expect(
          (await within(later.wait(), 'next child turn')).finalOutput,
        ).toBe('child done');
        expect(nativeReleases).toHaveLength(0);
        await within(opened.close(), 'physical child stop');
        await vi.waitFor(() => expect(nativeReleases).toHaveLength(1));
        // Deliver the real native notice separately from Session-wide cleanup.
        expect(entries.get(key)).toBe(entry);
        nativeReleases[0]!();
        expect(entries.has(key)).toBe(false);
        expect(owners.mock.calls.at(-1)?.[3].callbackTraceStorages).toBe(
          entries,
        );
        expect(submissionSpan).toBeDefined();
        expect(storageSnapshots[1]?.span).toBe(callbackSpan);
        server.assertExhausted();
        return;
      }
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
      } else if (mode === 'release' || !missingLookup) {
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
        releaseCallback.resolve();
        expect(
          (await within(turn.wait(), 'child completion')).finalOutput,
        ).toBe('child done');
        expect(calls).toBe(1);
        if (traceStorage) {
          const callbackSpan = storageSnapshots[0]?.span;
          const nativeParent = observed.traceContext?.toHeaders().traceparent;
          expect(nativeParent).toBeDefined();
          expect(submissionSpan).toBeDefined();
          expect(nativeParent!.slice(3, 35)).toBe(
            submissionSpan!.context.traceId,
          );
          expect(callbackSpan?.context).toMatchObject({
            traceId: submissionSpan!.context.traceId,
            parentSpanId: nativeParent!.slice(36, 52),
          });
          expect(storageSnapshots).toHaveLength(2);
          for (const observation of storageSnapshots) {
            expect(observation.span).toBe(callbackSpan);
            expect(observation.submission).toBe(
              builtinStorage ? undefined : callbackSpan,
            );
            expect(observation.opening).toBeUndefined();
            expect(observation.workflow).toBeUndefined();
          }
        }
        if (missingAdmission) {
          expect(fallbackEntrySpan).toBeUndefined();
          expect(
            observed.traceContext?.toHeaders().traceparent.slice(3, 35),
          ).toBe(fallbackParent.toHeaders().traceparent.slice(3, 35));
          const probe = storageSnapshots[0]?.span;
          expect(probe).toBeDefined();
          expect(storageSnapshots).toEqual([
            {
              span: probe,
              opening: probe,
              submission: undefined,
              workflow: undefined,
            },
            {
              span: probe,
              opening: probe,
              submission: undefined,
              workflow: undefined,
            },
          ]);
        }
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
      releaseCallback.resolve();
      if (observeStorage) telemetry.setTraceContextStorage();
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

it.each(['trace entry', 'queued guardrail', 'graceful tree stop'] as const)(
  'skips child step callbacks after admission expires at %s',
  async (mode) => {
    const addon = await binding();
    const { NativeThread } = addon;
    const treeStop = mode === 'graceful tree stop';
    const check = NativeThread.prototype._check_step;
    const owners = vi.spyOn(ChildCallbacks.prototype, 'owner');
    const refused = Promise.withResolvers<string>();
    let admitted: { native: NativeThread; wire: string } | undefined;
    let expired = false;
    vi.spyOn(NativeThread.prototype, '_check_step').mockImplementation(
      function (this: NativeThread, wire) {
        if (wire === admitted?.wire && expired) {
          refused.resolve(wire);
          return false;
        }
        const active = check.call(this, wire);
        if (active && JSON.parse(wire).instance)
          admitted ??= { native: this, wire };
        return active;
      },
    );
    const heldCallback = Promise.withResolvers<NonNullable<typeof admitted>>();
    const releaseCallback = Promise.withResolvers<void>();
    const settling = Promise.withResolvers<void>();
    const releaseStop = Promise.withResolvers<void>();
    const stopSettled = Promise.withResolvers<void>();
    if (treeStop) {
      const requestStop = NativeThread.prototype._request_graph_stop;
      vi.spyOn(
        NativeThread.prototype,
        '_request_graph_stop',
      ).mockImplementation(function (this: NativeThread, scope, mode) {
        const receipt = requestStop.call(this, scope, mode);
        const settle = receipt.settle.bind(receipt);
        vi.spyOn(receipt, 'settle').mockImplementation(async () => {
          settling.resolve();
          await releaseStop.promise;
          await settle();
          stopSettled.resolve();
        });
        return receipt;
      });
    }
    const retain = addon._retain_callback_dispatch_context;
    const nativeReleased = Promise.withResolvers<string>();
    const nativeReleases: string[] = [];
    const dispatch = vi
      .spyOn(addon, '_retain_callback_dispatch_context')
      .mockImplementation((handle, key, release) =>
        retain(handle, key, () => {
          release();
          nativeReleases.push(key);
          nativeReleased.resolve(key);
        }),
      );
    const storage = new AsyncLocalStorage<telemetry.TraceSpan>();
    const run = storage.run.bind(storage);
    vi.spyOn(storage, 'run').mockImplementation((span, callback, ...args) => {
      if (admitted && span?.kind === 'callback') {
        // The two fault cases change only the check spy's answer.
        if (mode === 'trace entry') expired = true;
        if (treeStop) {
          heldCallback.resolve(admitted);
          return releaseCallback.promise.then(() =>
            run(span, callback, ...args),
          );
        }
      }
      return run(span, callback, ...args);
    });
    const entries: string[] = [];
    const beforeStep = (): undefined => {
      entries.push('beforeStep');
      // The parallel guardrail is queued while beforeStep runs synchronously.
      if (mode === 'queued guardrail') expired = true;
    };
    const spawn = call(
      'spawn_agent',
      { task_name: 'guarded', message: 'child input', fork_turns: 'none' },
      { namespace: 'collaboration', callId: 'spawn-guarded' },
    );
    const server = new ModelServer(
      treeStop ? [[spawn]] : [[spawn], [message('root done')]],
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-child-guardrail',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents({ maxChildren: 1, beforeStep })],
      inputGuardrails: [
        {
          name: 'child-input',
          runInParallel: true,
          callback: () => ({ tripwireTriggered: false }),
          childCallback() {
            entries.push('guardrail');
            return { tripwireTriggered: false };
          },
        },
      ],
    });
    const executor = await startPublicExecutor();
    let session: Awaited<ReturnType<typeof agent.session>> | undefined;
    try {
      const opened = (session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      }));
      telemetry.setTraceContextStorage(storage);
      const root = await telemetry.withSpan({ name: 'submission' }, () =>
        opened.submit('begin'),
      );
      let wire: string;
      if (treeStop) {
        const held = await within(heldCallback.promise, 'child callback hold');
        await opened.interrupt({ scope: 'all', mode: 'graceful' });
        await within(settling.promise, 'graceful stop settlement entry');
        expect(check.call(held.native, held.wire)).toBe(true);
        wire = held.wire;
      } else {
        expect((await within(root.wait(), 'root completion')).finalOutput).toBe(
          'root done',
        );
        wire = await within(refused.promise, 'child step refusal');
      }
      const step = JSON.parse(wire);
      const owner = owners.mock.results.find(
        ({ type, value }) =>
          type === 'return' &&
          value.childId === step.thread &&
          value.incarnation === step.instance &&
          value.turnId === step.turn_id,
      );
      expect(owner?.type).toBe('return');
      const registry = owner!.value.observationProducer.callbackTraceStorages;
      const key = dispatch.mock.calls[0]?.[1];
      if (treeStop) {
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(registry.get(key!)?.storage).toBe(storage);
        expect(nativeReleases).toEqual([]);
      }
      releaseCallback.resolve();
      await within(
        Promise.allSettled([...owner!.value.tasks]),
        'child callback cleanup',
      );
      if (treeStop) expect(entries).toEqual([]);
      expect(owner!.value.failure).toBeUndefined();
      expect(owner!.value.controller.signal.aborted).toBe(false);
      const [child] = await within(
        Array.fromAsync(opened.subagents()),
        'child lookup',
      );
      expect(child?.turn).toBeTruthy();
      const outcome = child!.turn!.wait().catch((error: unknown) => error);
      if (treeStop) {
        releaseStop.resolve();
        await within(stopSettled.promise, 'graceful stop settlement');
      }
      await within(opened.close(), 'Session close');
      expect(await within(outcome, 'closed child turn')).toBeInstanceOf(Error);
      expect(entries).toEqual(
        mode === 'queued guardrail' ? ['beforeStep'] : [],
      );
      if (treeStop) {
        expect(
          await within(nativeReleased.promise, 'native storage release'),
        ).toBe(key);
        expect(nativeReleases).toEqual([key]);
        expect(registry.has(key!)).toBe(false);
      }
      server.assertExhausted();
    } finally {
      releaseCallback.resolve();
      releaseStop.resolve();
      telemetry.setTraceContextStorage();
      try {
        if (session) await within(session.close(), 'Session cleanup');
      } finally {
        await within(executor.close(), 'executor cleanup');
      }
    }
  },
  20000,
);

it('keeps the child trace storage until a parallel input guardrail returns on close', async () => {
  const addon = await binding();
  const owners = vi.spyOn(ChildCallbacks.prototype, 'owner');
  const retain = addon._retain_callback_dispatch_context;
  const nativeReleased = Promise.withResolvers<string>();
  const dispatch = vi
    .spyOn(addon, '_retain_callback_dispatch_context')
    .mockImplementation((handle, key, release) =>
      retain(handle, key, () => {
        release();
        nativeReleased.resolve(key);
      }),
    );
  const entered = Promise.withResolvers<string>();
  const aborted = Promise.withResolvers<void>();
  const childRequest = Promise.withResolvers<string>();
  const releaseGuard = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  let rootId: string | undefined;
  let rootRequests = 0;
  const respond = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId) {
      if (rootRequests++ === 0)
        return [
          call(
            'spawn_agent',
            {
              task_name: 'guarded',
              message: 'child input',
              fork_turns: 'none',
            },
            { namespace: 'collaboration', callId: 'spawn-guarded' },
          ),
        ];
      return [message('root done')];
    }
    childRequest.resolve(id);
    await releaseModel.promise;
    return { status: 503, body: 'fixture cleanup' };
  };
  const server = new ModelServer([respond, respond, respond]);
  const executor = await startPublicExecutor();
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-child-guardrail',
    supportsWebsockets: false,
  });
  const openingStorage = new AsyncLocalStorage<telemetry.TraceSpan>();
  const submissionStorage = new AsyncLocalStorage<telemetry.TraceSpan>();
  const snapshot = () => ({
    span: telemetry.getCurrentSpan(),
    submission: submissionStorage.getStore(),
    opening: openingStorage.getStore(),
  });
  const snapshots: ReturnType<typeof snapshot>[] = [];
  let invocations = 0;
  const agent = new Agent({
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider,
    tools: [new NativeAgents({ maxChildren: 1 })],
    inputGuardrails: [
      {
        name: 'held-child-input',
        runInParallel: true,
        callback: () => ({ tripwireTriggered: false }),
        async childCallback({ child, signal }) {
          invocations++;
          signal.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
          snapshots.push(snapshot());
          entered.resolve(child.childId);
          await releaseGuard.promise;
          snapshots.push(snapshot());
          return { tripwireTriggered: false };
        },
      },
    ],
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    telemetry.setTraceContextStorage(openingStorage);
    const opened = (session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    }));
    telemetry.setTraceContextStorage(submissionStorage);
    let traceId: string | undefined;
    const root = await telemetry.withSpan({ name: 'submission' }, (span) => {
      traceId = span.context.traceId;
      return opened.submit('begin', {
        beforeStep: ({ stepIndex }) =>
          stepIndex === 0 ? [toolRef('spawn_agent', 'collaboration')] : [],
      });
    });
    const childId = await within(entered.promise, 'parallel guardrail entry');
    expect(await within(childRequest.promise, 'child model request')).toBe(
      childId,
    );
    expect((await within(root.wait(), 'root completion')).finalOutput).toBe(
      'root done',
    );
    expect(server.completedFrames).toHaveLength(2);
    const callbackSpan = snapshots[0]?.span;
    expect(callbackSpan?.kind).toBe('callback');
    expect(callbackSpan?.context.traceId).toBe(traceId);
    const expectedSnapshot = {
      span: callbackSpan,
      submission: callbackSpan,
      opening: undefined,
    };
    expect(snapshots).toEqual([expectedSnapshot]);
    expect(invocations).toBe(1);

    const registry = owners.mock.calls.find(([id]) => id === childId)![3]
      .callbackTraceStorages;
    expect(dispatch).toHaveBeenCalledTimes(1);
    const key = dispatch.mock.calls[0]![1];
    const entry = registry.get(key);
    expect(entry?.storage).toBe(submissionStorage);
    const deleteEntry = registry.delete;
    const snapshotsAtDeletion: number[] = [];
    vi.spyOn(registry, 'delete').mockImplementation((deletedKey) => {
      if (deletedKey === key) snapshotsAtDeletion.push(snapshots.length);
      return deleteEntry.call(registry, deletedKey);
    });
    let closed = false;
    const closing = opened.close().finally(() => (closed = true));
    void closing.catch(() => {});
    await within(aborted.promise, 'child guardrail cancellation');
    expect(await within(nativeReleased.promise, 'native storage release')).toBe(
      key,
    );
    expect(closed).toBe(false);
    expect(snapshots).toEqual([expectedSnapshot]);
    expect(registry.get(key)).toBe(entry);
    expect(entry).toMatchObject({ entered: 1, nativeReleased: true });
    expect(snapshotsAtDeletion).toEqual([]);

    releaseGuard.resolve();
    await within(closing, 'joined Session close');
    expect(snapshots).toEqual([expectedSnapshot, expectedSnapshot]);
    expect(invocations).toBe(1);
    expect(registry.has(key)).toBe(false);
    expect(snapshotsAtDeletion).toEqual([2]);
    server.assertExhausted();
  } finally {
    releaseGuard.resolve();
    releaseModel.resolve();
    telemetry.setTraceContextStorage();
    try {
      await session?.close();
    } finally {
      await executor.close();
    }
  }
}, 20000);
