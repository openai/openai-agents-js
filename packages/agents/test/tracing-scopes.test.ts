import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  let id = 0;
  const starts: Record<string, unknown>[] = [];
  const contexts = new Map<string, Record<string, unknown>>();
  const released = new Set<string>();
  const aliases = new Set<string>();
  const aliasedHandles = new Set<string>();
  const native = {
    configure_telemetry: vi.fn(async (_wire: string) => {}),
    start_trace_span: vi.fn((json: string) => {
      const options = JSON.parse(json);
      if (options.parent && released.has(options.parent))
        throw new Error('Unknown or released native tracing context');
      starts.push(options);
      const handle = `span-${++id}`;
      const parent = contexts.get(options.parent);
      const linked = options.detached ? undefined : parent;
      const restrictions = [
        parent,
        contexts.get(options.restrictions_parent),
        ...(options.restrictions_parents ?? []).map((token: string) =>
          contexts.get(token),
        ),
      ].filter(Boolean);
      const context = {
        handle,
        trace_id:
          linked?.trace_id ??
          options.trace_id?.replace(/^trace_/, '').toLowerCase() ??
          String(id).padStart(32, '0'),
        span_id: String(id).padStart(16, '0'),
        parent_span_id: linked?.span_id ?? null,
        workflow_span_id:
          options.kind === 'workflow'
            ? String(id).padStart(16, '0')
            : (linked?.workflow_span_id ?? null),
        disabled:
          options.disabled ||
          restrictions.some((item) => item?.disabled) ||
          false,
        include_sensitive_data: restrictions.some(
          (item) => item?.include_sensitive_data === false,
        )
          ? false
          : (options.include_sensitive_data ??
            parent?.include_sensitive_data ??
            false),
      };
      contexts.set(handle, context);
      return JSON.stringify(context);
    }),
    end_trace_span: vi.fn(),
    release_trace_span: vi.fn((handle: string) => {
      released.add(handle);
    }),
    retain_trace_context: vi.fn((handle: string) => {
      if (!contexts.has(handle) || released.has(handle))
        throw new Error('Unknown or released native tracing context');
      const token = `lease-${++id}`;
      contexts.set(token, contexts.get(handle)!);
      if (handle.startsWith('span-') && !aliasedHandles.has(handle)) {
        aliases.add(token);
        aliasedHandles.add(handle);
      }
      return token;
    }),
    release_trace_context: vi.fn((token: string) => {
      released.add(token);
    }),
    register_trace_credentials: vi.fn(() => 'credential-1'),
    release_trace_credentials: vi.fn(),
    set_trace_routes: vi.fn((_wire: string) => 0),
    drain_trace_events: vi.fn(async () =>
      JSON.stringify({ events: [], through_sequence: 0 }),
    ),
    ack_trace_events: vi.fn(),
    force_flush_telemetry: vi.fn(async () =>
      JSON.stringify({
        status: 'partial',
        dropped_records: 2,
        failed_deliveries: 1,
        barrier: 8,
      }),
    ),
    shutdown_telemetry: vi.fn(async () => {}),
  };
  return { native, starts, contexts, aliases };
});
vi.mock('../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../src/runtime/binding')>()),
  binding: async () => harness.native,
}));
import {
  configure,
  forceFlush,
  getCurrentSpan,
  getCurrentTrace,
  shutdown,
  startSpan,
  startTrace,
  TraceExportCredentials,
  withSpan,
  withTrace,
} from '../src/runtime/telemetry';

import {
  captureTracing,
  withoutTracing,
  withNativeCallbackContext,
} from '../src/runtime/tracing-context';

beforeEach(async () => {
  vi.clearAllMocks();
  harness.starts.length = 0;
  await configure({
    traces: { kind: 'otlp-http', endpoint: 'http://127.0.0.1:1/v1/traces' },
  });
  vi.clearAllMocks();
});
afterEach(() => {
  expect(getCurrentSpan()).toBeUndefined();
});

describe('native tracing host ownership (REQ423-425)', () => {
  it('restores nested scopes after rejection and keeps concurrent promises isolated', async () => {
    await Promise.all(
      ['first', 'second'].map((name) =>
        withTrace({ name }, async (trace) => {
          await Promise.resolve();
          expect(getCurrentTrace()).toBe(trace);
          expect(getCurrentSpan()).toBe(trace);
          await expect(
            withSpan({ name: 'child' }, async (span) => {
              expect(getCurrentSpan()).toBe(span);
              expect(span.context.parentSpanId).toBe(trace.context.spanId);
              await Promise.resolve();
              throw new Error('private callback value');
            }),
          ).rejects.toThrow('private callback value');
          expect(getCurrentSpan()).toBe(trace);
        }),
      ),
    );
    expect(harness.native.end_trace_span).toHaveBeenCalledTimes(4);
    expect(harness.native.release_trace_span).toHaveBeenCalledTimes(4);
    expect(
      JSON.stringify(harness.native.end_trace_span.mock.calls),
    ).not.toContain('private callback value');
  });

  it('uses explicit linkage and retains ambient restrictions for detached scopes', async () => {
    const explicit = await startTrace({ name: 'explicit' });
    await withTrace({ name: 'ambient', disabled: true }, async () => {
      await withSpan(
        { parent: explicit, detached: true, includeSensitiveData: true },
        () => {},
      );
      expect(harness.starts.at(-1)).toMatchObject({
        detached: true,
        include_sensitive_data: true,
      });
      expect(harness.starts.at(-1)?.parent).toMatch(/^lease-/);
      expect(harness.starts.at(-1)?.restrictions_parent).toMatch(/^lease-/);
    });
    explicit.close();
    expect(
      harness.native.release_trace_context.mock.calls.filter(
        ([token]) => !harness.aliases.has(token),
      ).length,
    ).toBe(
      harness.native.retain_trace_context.mock.results.filter(
        (result) =>
          result.type === 'return' && !harness.aliases.has(result.value),
      ).length,
    );
  });

  it('captures context and metadata before the caller leaves its scope', async () => {
    let captured: ReturnType<typeof captureTracing>;
    const metadata = { nested: { value: 'original' } };
    await withTrace({ name: 'workflow' }, async (workflow) => {
      captured = captureTracing({ metadata });
      metadata.nested.value = 'changed';
      const operation = await captured!.ready;
      expect(operation.context.parentSpanId).toBe(workflow.context.spanId);
    });
    expect(
      harness.starts.find((options) => options.kind === 'operation')?.metadata,
    ).toEqual({ nested: { value: 'original' } });
    const token = await captured!.context();
    expect(token).toMatch(/^lease-/);
    captured!.finish();
    await Promise.resolve();
    expect(harness.native.release_trace_context).toHaveBeenCalledWith(token);
  });

  it('ends handles idempotently and preserves native identity readback', async () => {
    const span = await startSpan({
      traceId: `trace_${'A'.repeat(32)}`,
      groupId: 'group',
      metadata: { attempt: 1 },
    });
    expect(span.context.traceId).toHaveLength(32);
    expect(harness.starts[0]).toMatchObject({
      trace_id: `trace_${'A'.repeat(32)}`,
      group_id: 'group',
      metadata: { attempt: 1 },
    });
    span.end();
    span.end();
    span.close();
    span.close();
    expect(harness.native.end_trace_span).toHaveBeenCalledTimes(1);
    expect(harness.native.release_trace_span).toHaveBeenCalledTimes(1);
  });

  it('borrows native callback ancestry without releasing the native owner token', async () => {
    const parent = await startTrace();
    const token = parent.retain();
    await expect(
      withNativeCallbackContext(token, async () => {
        expect(getCurrentSpan()?.context.parentSpanId).toBe(
          parent.context.spanId,
        );
        throw new Error('tool failed');
      }),
    ).rejects.toThrow('tool failed');
    expect(harness.native.release_trace_context).not.toHaveBeenCalledWith(
      token,
    );
    expect(
      JSON.parse(harness.native.end_trace_span.mock.calls[0][1]),
    ).toMatchObject({ status: 'error', category: 'callback_error' });
    parent.releaseContext(token);
    parent.close();
  });

  it.each(['reader', 'unrelated ambient'])(
    'restores the owning workflow in callbacks from %s',
    async (entry) => {
      let capture: ReturnType<typeof captureTracing>;
      let workflow: Awaited<ReturnType<typeof startTrace>>;
      await withTrace({}, async (trace) => {
        workflow = trace;
        capture = captureTracing();
        await capture!.ready;
      });
      const token = await capture!.context();
      const invoke = () =>
        withNativeCallbackContext(
          token,
          async () => {
            expect(getCurrentTrace()).toBe(workflow);
            expect(getCurrentSpan()?.context.traceId).toBe(
              workflow.context.traceId,
            );
            await withSpan({}, () => expect(getCurrentTrace()).toBe(workflow));
          },
          undefined,
          () => capture?.workflow,
        );
      try {
        if (entry === 'reader') await withoutTracing(invoke);
        else await withTrace({}, invoke);
      } finally {
        capture!.finish();
      }
    },
  );

  it('does not attach an unrelated workflow to a native-only callback', async () => {
    const nativeOnly = await startSpan();
    const token = nativeOnly.retain();
    try {
      await withTrace({}, async () => {
        const unrelated = captureTracing()!;
        await unrelated.ready;
        try {
          await withNativeCallbackContext(
            token,
            async () => {
              expect(getCurrentSpan()?.context.traceId).toBe(
                nativeOnly.context.traceId,
              );
              expect(getCurrentTrace()).toBeUndefined();
              await withSpan({}, () =>
                expect(getCurrentTrace()).toBeUndefined(),
              );
            },
            undefined,
            () => unrelated.workflow,
          );
        } finally {
          unrelated.finish();
        }
      });
    } finally {
      nativeOnly.releaseContext(token);
      nativeOnly.close();
    }
  });
});

describe('native export controls (REQ427, REQ429)', () => {
  it('keeps credential references outside metadata and releases them explicitly', async () => {
    const credentials = new TraceExportCredentials({
      headers: { Authorization: 'synthetic' },
    });
    await withTrace({ exportCredential: credentials }, () => {});
    expect(harness.starts[0]).toMatchObject({
      credential_ref: 'credential-1',
      metadata: {},
    });
    expect(JSON.stringify(harness.starts)).not.toContain('synthetic');
    credentials.close();
    credentials.close();
    expect(harness.native.release_trace_credentials).toHaveBeenCalledTimes(1);
  });

  it('returns loss-aware nonterminal flush results and keeps shutdown separate', async () => {
    await expect(forceFlush({ timeoutMs: 75 })).resolves.toEqual({
      status: 'partial',
      droppedRecords: 2,
      failedDeliveries: 1,
      barrier: 8,
    });
    expect(harness.native.force_flush_telemetry).toHaveBeenCalledWith(75);
    expect(harness.native.shutdown_telemetry).not.toHaveBeenCalled();
    await withTrace({}, () => {});
    await shutdown({ timeoutMs: 100 });
    expect(harness.native.shutdown_telemetry).toHaveBeenCalledWith(100);
  });
});

it('delivers immutable processor snapshots in order and contains processor failures (REQ426)', async () => {
  const telemetry = await import('../src/runtime/telemetry');
  const received: string[] = [];
  const first = {
    onEvent: vi.fn(
      async (event: import('../src/runtime/telemetry').TraceEvent) => {
        received.push(`${event.lifecycle}:first`);
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event.attributes)).toBe(true);
        if (event.lifecycle === 'start') throw new Error('processor rejected');
      },
    ),
  };
  const second = {
    onEvent: vi.fn((event: import('../src/runtime/telemetry').TraceEvent) => {
      received.push(`${event.lifecycle}:second`);
    }),
  };
  await telemetry.addTraceProcessor(first);
  await telemetry.addTraceProcessor(second);
  const routes = harness.native.set_trace_routes.mock.calls.map(
    ([wire]) => JSON.parse(wire).processor_ids[0],
  );
  harness.native.drain_trace_events.mockResolvedValueOnce(
    JSON.stringify({
      events: ['start', 'end'].map((lifecycle, index) => ({
        sequence: index + 1,
        lifecycle,
        processor_ids: routes,
        trace_id: 'a'.repeat(32),
        span_id: '1'.repeat(16),
        parent_span_id: null,
        attributes: { nested: { safe: true } },
      })),
      through_sequence: 2,
    }),
  );
  await telemetry.forceFlush();
  await vi.waitFor(() =>
    expect(harness.native.ack_trace_events).toHaveBeenCalledWith(2, 1),
  );
  expect(received).toEqual([
    'start:first',
    'start:second',
    'end:first',
    'end:second',
  ]);
  await telemetry.setTraceProcessors([]);
  expect(
    JSON.parse(harness.native.set_trace_routes.mock.calls.at(-1)![0]),
  ).toEqual({ processor_ids: [], replace: true });
  await telemetry.forceFlush();
});

it('preserves opening restrictions when a new root selects another ambient or explicit parent', async () => {
  const opening = captureTracing({
    disabled: true,
    includeSensitiveData: false,
  })!;
  const openingSpan = await opening.ready;
  await withTrace({ includeSensitiveData: true }, async (ambient) => {
    const explicit = await startTrace({
      detached: true,
      includeSensitiveData: true,
    });
    const ambientRoot = captureTracing(undefined, opening)!;
    const ambientSpan = await ambientRoot.ready;
    expect(ambientSpan.context.parentSpanId).toBe(ambient.context.spanId);
    expect(ambientSpan.context.disabled).toBe(true);
    expect(ambientSpan.context.includeSensitiveData).toBe(false);
    const explicitRoot = captureTracing(
      { parent: explicit, includeSensitiveData: true },
      opening,
    )!;
    const explicitSpan = await explicitRoot.ready;
    expect(explicitSpan.context.parentSpanId).toBe(explicit.context.spanId);
    expect(explicitSpan.context.disabled).toBe(true);
    expect(explicitSpan.context.includeSensitiveData).toBe(false);
    expect(harness.starts.at(-1)?.restrictions_parents).toHaveLength(1);
    ambientRoot.finish();
    explicitRoot.finish();
    explicit.close();
  });
  expect(openingSpan.context.disabled).toBe(true);
  opening.finish();
  await Promise.resolve();
});

// Controlled admission receipts establish host ownership, not native execution.
async function rootFixture(
  submit: (wire: string) => Promise<string>,
  options: import('../src/runtime/session').SessionOptions = {},
  threadOptions: import('../src/runtime/options').ThreadOptions = {},
  events?: ReturnType<typeof Promise.withResolvers<string>>[],
  nativeOverrides: Partial<import('../src/runtime/binding').NativeThread> = {},
  tools: readonly import('../src/runtime/tools').SessionTool[] = [],
  oneShot?: import('../src/runtime/session').OneShotOptions,
) {
  const { Session } = await import('../src/runtime/session');
  const { captureTools } = await import('../src/runtime/tools');
  let eventIndex = 0;
  for (const event of events ?? []) void event.promise.catch(() => {});
  const session = new Session(
    {
      _close_report: async () => null,
    } as unknown as import('../src/runtime/binding').Engine,
    {
      id: 'trace-fixture',
      _submit: submit,
      _next_session_event: () => events![eventIndex++].promise,
      _close_report: async () => {
        for (const event of events ?? [])
          event.reject(new Error('reader closed'));
        return null;
      },
      _finish_child_event_reader: () => {},
      _stop_sampling_for_close: () => {},
      ...nativeOverrides,
    } as unknown as import('../src/runtime/binding').NativeThread,
    captureTools(tools),
    options,
    threadOptions,
    undefined,
    undefined,
    undefined,
    oneShot,
  );
  if (events) await session._start();
  return session;
}

it.each([
  { shared: false, callback: 'step' },
  { shared: true, callback: 'step' },
  { shared: true, callback: 'tool' },
  { shared: true, callback: 'manual' },
])(
  'restores a late first child $callback callback (shared trace ID: $shared)',
  async ({ shared, callback }) => {
    const { tool } = await import('../src/runtime/tools');
    const { manualTool } = await import('../src/runtime/manual');
    const { z } = await import('zod');
    const { NativeAgents } = await import('../src/runtime/native-agents');
    const events = Array.from({ length: 3 }, () =>
      Promise.withResolvers<string>(),
    );
    const submitted: Record<string, unknown>[] = [];
    const replied = Promise.withResolvers<void>();
    const interceptions = Promise.withResolvers<string>();
    let original: Awaited<ReturnType<typeof startTrace>> | undefined;
    let observed: Awaited<ReturnType<typeof startTrace>> | undefined;
    const child = {
      session_id: 'trace-fixture',
      child_id: 'child',
      incarnation: '1',
      turn_id: 'child-turn',
      instance_id: 'instance',
    } as import('../native/index.js')._NativeChildTurn;
    const observe = async () => {
      observed = getCurrentTrace();
      const explicit = await startSpan({ parent: observed });
      expect(explicit.context.parentSpanId).toBe(observed?.context.spanId);
      explicit.close();
      await withSpan({}, () => expect(getCurrentTrace()).toBe(observed));
      return undefined;
    };
    const manual = manualTool({
      name: 'probe',
      description: 'manual tracing probe',
      parameters: z.object({}).superRefine(() => {
        expect(getCurrentTrace()).toBe(original);
        expect(getCurrentSpan()).toBeDefined();
      }),
      result: z.string(),
    });
    const probe =
      callback === 'manual'
        ? manual
        : tool({
            name: 'probe',
            parameters: z.object({}),
            execute: async () => {
              await observe();
              return 'done';
            },
          });
    const session = await rootFixture(
      async (wire) => {
        submitted.push(JSON.parse(wire));
        return JSON.stringify({
          status: 'started',
          turn_id: `root-${submitted.length}`,
        });
      },
      {
        nativeAgents: new NativeAgents({
          beforeStep: observe,
        }),
      },
      {},
      events,
      {
        _child_turn: async () => child,
        _enable_native_interception: () => true,
        _configure_native_interception: () => true,
        _next_native_interception: () => interceptions.promise,
        _revoke_native_interception: () => {
          interceptions.resolve('null');
        },
        _finish_native_interception_reader: () => {},
        _manual_tool_current: () => true,
        _configure_manual_tools: () => {},
        _manual_checkpoint_config_supported: async () => false,
        _pending_manual_tools: () => '[]',
        _check_python_tool: () => {},
        _respond_python_tool: async () => {
          replied.resolve();
          return true;
        },
        _check_step: () => true,
        _reply_child_step: () => {
          replied.resolve();
          return true;
        },
      },
      [probe],
      callback === 'manual'
        ? {
            input: 'run',
            onRequiredAction: async (action) => {
              await observe();
              const request = manual.match(action)!;
              return request.reply('done');
            },
          }
        : undefined,
    );
    let childToken: string | undefined;
    try {
      const first = await withTrace(
        { traceId: shared ? '1'.repeat(32) : undefined },
        async (workflow) => {
          original = workflow;
          return session.submit('original root');
        },
      );
      // Native child work retains its own borrowed carrier before the root ends.
      const operation = harness.contexts.get(
        submitted[0].tracing_context as string,
      )!;
      childToken = harness.native.retain_trace_context(
        operation.handle as string,
      );
      events[0].resolve(
        JSON.stringify({
          id: 'root-1',
          msg: {
            type: 'task_complete',
            last_agent_message: 'done',
          },
        }),
      );
      await first.wait();
      await withTrace({ traceId: shared ? '1'.repeat(32) : undefined }, () =>
        session.submit('unrelated later root'),
      );
      // No child owner was observed until after the unrelated root was admitted.
      events[1].resolve(
        JSON.stringify({
          id: 'child-turn',
          subagent_id: 'child',
          subagent_incarnation: '1',
          subagent_instance_id: 'instance',
          msg:
            callback === 'step'
              ? {
                  type: '_sdk_select_step',
                  thread: 'child',
                  turn_id: 'child-turn',
                  generation: '0',
                  request_id: 'step-1',
                  tracing_context: childToken,
                }
              : {
                  type: 'dynamic_tool_call_request',
                  _sdk_code_origin: null,
                  _sdk_model: 'fixture',
                  _sdk_python_tool: {
                    thread: 'child',
                    instance: '1',
                    generation: '0',
                    slot: 0,
                    ...(callback === 'manual' ? { manual_grant: 'grant' } : {}),
                  },
                  tool: 'probe',
                  namespace: null,
                  callId: 'call-1',
                  turnId: 'child-turn',
                  arguments: {},
                  tracing_context: childToken,
                },
        }),
      );
      await replied.promise;
      expect(observed).toBe(original);
    } finally {
      await session.close();
      if (childToken) harness.native.release_trace_context(childToken);
    }
  },
);

it.each([
  { method: 'steer', traced: true },
  { method: 'steerExact', traced: true },
  { method: 'steer', traced: false },
  { method: 'steerExact', traced: false },
] as const)(
  'keeps the admitted owner for $method with tracing=$traced',
  async ({ method, traced }) => {
    const submissions: Record<string, unknown>[] = [];
    const session = await rootFixture(async (wire) => {
      const input = JSON.parse(wire);
      submissions.push(input);
      return JSON.stringify(
        input.mode === 'steer'
          ? { status: 'steered', turn_id: 'turn-1', input_id: 'input-1' }
          : { status: 'started', turn_id: 'turn-1' },
      );
    });
    try {
      const turn = traced
        ? await withTrace({ disabled: true, includeSensitiveData: false }, () =>
            session.submit('root'),
          )
        : await session.submit('root');
      await withTrace({ includeSensitiveData: true }, async () => {
        if (method === 'steerExact') {
          const receipt = await turn.steerExact('detail', 'turn-1');
          expect(receipt).toMatchObject({
            turnId: 'turn-1',
            inputId: 'input-1',
            submissionId: turn.submissionId,
          });
        } else await turn.steer('detail');
      });
      expect(submissions).toHaveLength(2);
      expect(submissions[1].expected_turn_id).toBe('turn-1');
      expect(submissions[1].exact_steering).toBe(
        method === 'steerExact' ? true : undefined,
      );
      expect(submissions[1].tracing_context).toBe(
        submissions[0].tracing_context,
      );
      if (traced) {
        expect(submissions[1].tracing_context).toMatch(/^lease-/);
        expect(
          harness.contexts.get(submissions[1].tracing_context as string),
        ).toMatchObject({ disabled: true, include_sensitive_data: false });
      } else expect(submissions[1]).not.toHaveProperty('tracing_context');
    } finally {
      await session.close();
    }
  },
);

it('captures queued root parents before dispatch and releases abandoned roots on close', async () => {
  const admitted: Record<string, unknown>[] = [];
  const session = await rootFixture(async (wire) => {
    admitted.push(JSON.parse(wire));
    return JSON.stringify({ status: 'started', turn_id: 'turn-1' });
  });
  let firstContext: string | undefined;
  let queuedContext: string | undefined;
  await withTrace({ name: 'first-workflow' }, async (workflow) => {
    await session.submit('active');
    firstContext = workflow.context.spanId;
  });
  await withTrace({ name: 'queued-workflow' }, async (workflow) => {
    await session.enqueue('queued');
    queuedContext = workflow.context.spanId;
  });
  expect(admitted).toHaveLength(1);
  expect(admitted[0].tracing_context).toMatch(/^lease-/);
  const operations = harness.starts.filter((span) => span.kind === 'operation');
  expect(operations).toHaveLength(2);
  expect(harness.contexts.get(operations[0].parent as string)?.span_id).toBe(
    firstContext,
  );
  expect(harness.contexts.get(operations[1].parent as string)?.span_id).toBe(
    queuedContext,
  );
  await session.close();
  await Promise.resolve();
  expect(harness.native.release_trace_span).toHaveBeenCalledTimes(4);
  expect(
    harness.native.release_trace_context.mock.calls.filter(
      ([token]) => !harness.aliases.has(token),
    ).length,
  ).toBe(
    harness.native.retain_trace_context.mock.results.filter(
      (result) =>
        result.type === 'return' && !harness.aliases.has(result.value),
    ).length,
  );
});

it('releases a rejected admission without starting native work under a later scope', async () => {
  const session = await rootFixture(async () =>
    JSON.stringify({ status: 'not_submitted', reason: 'busy' }),
  );
  await withTrace({}, async () => {
    await expect(
      session.submit('rejected', { ifBusy: 'reject' }),
    ).rejects.toThrow();
  });
  await session.close();
  await Promise.resolve();
  expect(
    harness.native.release_trace_context.mock.calls.filter(
      ([token]) => !harness.aliases.has(token),
    ).length,
  ).toBe(
    harness.native.retain_trace_context.mock.results.filter(
      (result) =>
        result.type === 'return' && !harness.aliases.has(result.value),
    ).length,
  );
});

it('rejects excessive live or retiring processor descriptors before changing native routes', async () => {
  const telemetry = await import('../src/runtime/telemetry');
  const processor = { onEvent: () => {} };
  await telemetry.setTraceProcessors(
    Array.from({ length: 64 }, () => processor),
  );
  const admitted = harness.native.set_trace_routes.mock.calls.length;
  await expect(telemetry.addTraceProcessor(processor)).rejects.toThrow(
    /at most 64/,
  );
  expect(harness.native.set_trace_routes).toHaveBeenCalledTimes(admitted);
  await telemetry.setTraceProcessors([]);
});

it('captures initial custom processors before configure awaits and enables a custom-only pipeline', async () => {
  const original = { onEvent: vi.fn() };
  const replacement = { onEvent: vi.fn() };
  const initial = [original];
  const configured = configure({ traceProcessors: initial });
  initial[0] = replacement;
  await configured;
  expect(
    JSON.parse(harness.native.configure_telemetry.mock.calls.at(-1)![0]),
  ).toMatchObject({
    'otel.trace_exporter': 'none',
    'otel.trace_processors': true,
  });
  const route = JSON.parse(
    harness.native.set_trace_routes.mock.calls.at(-1)![0],
  );
  harness.native.drain_trace_events.mockResolvedValueOnce(
    JSON.stringify({
      events: [
        {
          sequence: 500,
          lifecycle: 'start',
          processor_ids: route.processor_ids,
          trace_id: '1'.repeat(32),
          span_id: '2'.repeat(16),
          parent_span_id: null,
        },
      ],
      through_sequence: 500,
    }),
  );
  await forceFlush();
  await vi.waitFor(() => expect(original.onEvent).toHaveBeenCalledOnce());
  expect(replacement.onEvent).not.toHaveBeenCalled();
  await (await import('../src/runtime/telemetry')).setTraceProcessors([]);
});

it('rejects invalid initial processors before claiming native telemetry', async () => {
  await expect(
    configure({
      traceProcessors: Array.from({ length: 65 }, () => ({
        onEvent: () => {},
      })),
    }),
  ).rejects.toThrow('traceProcessors');
  expect(harness.native.configure_telemetry).not.toHaveBeenCalled();
});

const invalidTimeouts = [
  0,
  -1,
  1.5,
  60_001,
  4_294_967_297,
  -4_294_967_295,
  NaN,
  Infinity,
  -Infinity,
  '100',
  null,
  true,
  {},
  1n,
];
it.each(invalidTimeouts)(
  'rejects explicit invalid timeout %s before native flush or shutdown',
  async (value) => {
    await expect(
      forceFlush({ timeoutMs: value as number }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      shutdown({ timeoutMs: value as number }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(harness.native.force_flush_telemetry).not.toHaveBeenCalled();
    expect(harness.native.shutdown_telemetry).not.toHaveBeenCalled();
  },
);
it('preserves omitted budgets and both inclusive timeout bounds', async () => {
  for (const timeoutMs of [undefined, 1, 60_000]) {
    await forceFlush({ timeoutMs });
    expect(harness.native.force_flush_telemetry).toHaveBeenLastCalledWith(
      timeoutMs ?? 10_000,
    );
    await shutdown({ timeoutMs });
    expect(harness.native.shutdown_telemetry).toHaveBeenLastCalledWith(
      timeoutMs,
    );
  }
});

it.each([
  'success',
  'admission failure',
  'native failure',
  'close before transfer',
  'close after transfer',
] as const)(
  'keeps the admitted tracing owner through retained steering: %s',
  async (outcome) => {
    const defaultCredential = new TraceExportCredentials({
      headers: { authorization: 'synthetic-default' },
    });
    const rootCredential = new TraceExportCredentials({
      headers: { authorization: 'synthetic-root' },
    });
    const opening = captureTracing({
      name: 'session.default',
      includeSensitiveData: true,
      exportCredential: defaultCredential,
    })!;
    await opening.ready;
    const starts: Record<string, unknown>[] = [];
    const events = Array.from({ length: 4 }, () =>
      Promise.withResolvers<string>(),
    );
    let rootId = 'root-1';
    const session = await rootFixture(
      async (wire) => {
        const input = JSON.parse(wire);
        if (input.mode === 'steer')
          return JSON.stringify({ status: 'steered', turn_id: rootId });
        starts.push(input);
        if (input.mode === 'continue_if_idle') {
          expect(input.expected_previous_turn_id).toBe(rootId);
          expect(input.input).toEqual([]);
          if (outcome === 'admission failure')
            return JSON.stringify({
              status: 'not_submitted',
              reason: 'retained admission failed',
            });
        }
        rootId = `root-${starts.length}`;
        return JSON.stringify({ status: 'started', turn_id: rootId });
      },
      {
        tracingCapture: opening,
        onClose: async () => {
          opening.finish();
        },
      },
      { _managed_instructions: true },
      events,
    );
    try {
      const turn = await withTrace(
        { name: 'selected.workflow', includeSensitiveData: true },
        () =>
          session.submit('first', {
            tracing: {
              name: 'retained.operation',
              disabled: true,
              includeSensitiveData: false,
              exportCredential: rootCredential,
            },
          }),
      );
      await session.submit('steering input');
      const token = starts[0].tracing_context as string;
      const context = harness.contexts.get(token)!;
      expect(context).toMatchObject({
        disabled: true,
        include_sensitive_data: false,
      });
      const handle = context.handle as string;
      const ends = () =>
        harness.native.end_trace_span.mock.calls.filter(
          ([id]) => id === handle,
        );
      const releases = () =>
        harness.native.release_trace_span.mock.calls.filter(
          ([id]) => id === handle,
        );
      const settled = turn.wait();
      void settled.catch(() => {});
      if (outcome === 'close before transfer') await session.close();
      else {
        events[0].resolve(
          JSON.stringify({
            id: 'root-1',
            msg: { type: 'task_complete', last_agent_message: 'intermediate' },
            sdk_unsampled_steering: true,
          }),
        );
        await vi.waitFor(() => expect(starts).toHaveLength(2));
        expect(starts[1].tracing_context === token).toBe(true);
        if (outcome !== 'admission failure') {
          expect(ends()).toHaveLength(0);
          expect(releases()).toHaveLength(0);
          // A second retained transition must still have the same sole owner.
          events[1].resolve(
            JSON.stringify({
              id: 'root-2',
              msg: {
                type: 'task_complete',
                last_agent_message: 'intermediate',
              },
              sdk_unsampled_steering: true,
            }),
          );
          await vi.waitFor(() => expect(starts).toHaveLength(3));
          expect(starts[2].tracing_context === token).toBe(true);
          expect(ends()).toHaveLength(0);
          if (outcome === 'close after transfer') await session.close();
          else
            events[2].resolve(
              JSON.stringify({
                id: 'root-3',
                msg: {
                  type: 'task_complete',
                  last_agent_message: 'final',
                  ...(outcome === 'native failure'
                    ? { error: { message: 'retained native failed' } }
                    : {}),
                },
              }),
            );
        }
      }
      if (outcome === 'success')
        expect((await settled).finalOutput).toBe('final');
      else await expect(settled).rejects.toThrow();
      await vi.waitFor(() => expect(releases()).toHaveLength(1));
      expect(ends()).toHaveLength(1);
    } finally {
      await session.close();
      rootCredential.close();
      defaultCredential.close();
    }
    await Promise.resolve();
    expect(
      harness.native.release_trace_context.mock.calls.filter(
        ([token]) => !harness.aliases.has(token),
      ).length,
    ).toBe(
      harness.native.retain_trace_context.mock.results.filter(
        (result) =>
          result.type === 'return' && !harness.aliases.has(result.value),
      ).length,
    );
  },
);

it.each([false, true])(
  'keeps nested workflows distinct on one trace (disabled: %s)',
  async (disabled) => {
    await withTrace({ traceId: '2'.repeat(32), disabled }, async (a) => {
      const token = a.retain();
      try {
        await withTrace({ traceId: a.context.traceId }, async (b) => {
          expect(getCurrentTrace()).toBe(b);
          await withNativeCallbackContext(
            token,
            async () => {
              expect(getCurrentTrace()).toBe(a);
              await withSpan({}, () => expect(getCurrentTrace()).toBe(a));
            },
            undefined,
            (traceId, workflowSpanId) =>
              [a, b].find(
                (workflow) =>
                  workflow.context.traceId === traceId &&
                  workflow.context.spanId === workflowSpanId,
              ),
          );
          expect(getCurrentTrace()).toBe(b);
          await withSpan({ parent: null }, () =>
            expect(getCurrentTrace()).toBeUndefined(),
          );
        });
      } finally {
        a.releaseContext(token);
      }
    });
  },
);

it.each(['mismatched', 'missing'])(
  'does not infer a workflow from a shared trace when identity is %s',
  async (identity) => {
    await withTrace({ traceId: '3'.repeat(32) }, async (a) => {
      const token = a.retain();
      try {
        if (identity === 'missing')
          delete harness.contexts.get(token)!.workflow_span_id;
        await withTrace({ traceId: a.context.traceId }, async (b) => {
          await withNativeCallbackContext(
            token,
            async () => {
              expect(getCurrentTrace()).toBeUndefined();
              await withSpan({}, () =>
                expect(getCurrentTrace()).toBeUndefined(),
              );
            },
            undefined,
            () => b,
          );
        });
      } finally {
        a.releaseContext(token);
      }
    });
  },
);

it('captures tracing and writable roots together before queued admission', async () => {
  const events = Array.from({ length: 3 }, () =>
    Promise.withResolvers<string>(),
  );
  const admitted: Record<string, unknown>[] = [];
  const session = await rootFixture(
    async (wire) => {
      admitted.push(JSON.parse(wire));
      return JSON.stringify({
        status: 'started',
        turn_id: `root-${admitted.length}`,
      });
    },
    {},
    {},
    events,
  );
  try {
    const roots = ['/original'];
    const active = session.submit('first', {
      writableRoots: roots,
      tracing: { disabled: true },
    });
    roots[0] = '/changed';
    const first = await active;
    const nextRoots = ['/queued'];
    const queued = session.enqueue('next', undefined, {
      writableRoots: nextRoots,
      tracing: { includeSensitiveData: false },
    });
    nextRoots[0] = '/changed-again';
    const next = await queued;
    expect(admitted).toHaveLength(1);
    events[0].resolve(
      JSON.stringify({
        id: 'root-1',
        msg: { type: 'task_complete', last_agent_message: 'done' },
      }),
    );
    await first.wait();
    await expect.poll(() => admitted.length).toBe(2);
    await expect.poll(() => next.turnId).toBe('root-2');
    expect(admitted[0].writable_roots).toEqual(['file:///original']);
    expect(admitted[1].writable_roots).toEqual(['file:///queued']);
    expect(
      harness.contexts.get(admitted[0].tracing_context as string)?.disabled,
    ).toBe(true);
    expect(
      harness.contexts.get(admitted[1].tracing_context as string)
        ?.include_sensitive_data,
    ).toBe(false);
  } finally {
    await session.close();
  }
});

it.each([false, true])(
  'keeps ended workflow context usable (detached capture: %s)',
  async (detached) => {
    let capture: ReturnType<typeof captureTracing>;
    let workflow: Awaited<ReturnType<typeof startTrace>>;
    await withTrace({}, (value) => {
      workflow = value;
      capture = captureTracing({ detached });
    });
    const operation = await capture!.ready;
    expect(operation.workflow).toBe(detached ? undefined : workflow!);
    capture!.finish();
    capture!.finish(new Error('duplicate'));
    const child = await startSpan({ parent: workflow! });
    expect(child.context.parentSpanId).toBe(workflow!.context.spanId);
    child.close();
  },
);
it.each([false, true])(
  'keeps workflow identity after joined close (hook fails: %s)',
  async (hookFails) => {
    const events = Array.from({ length: 2 }, () =>
      Promise.withResolvers<string>(),
    );
    const opening = captureTracing({})!;
    const session = await rootFixture(
      async () => JSON.stringify({ status: 'started', turn_id: 'root' }),
      {
        tracingCapture: opening,
        onClose: async () => {
          opening.finish();
          if (hookFails) throw new Error('synthetic close failure');
        },
      },
      {},
      events,
    );
    let workflow: Awaited<ReturnType<typeof startTrace>>;
    const turn = await withTrace({}, async (value) => {
      workflow = value;
      return session.submit('run');
    });
    events[0].resolve(
      JSON.stringify({
        id: 'root',
        msg: { type: 'task_complete', last_agent_message: 'done' },
      }),
    );
    await turn.wait();
    if (hookFails)
      await expect(session.close()).rejects.toThrow('synthetic close failure');
    else await session.close();
    const issued = (
      session as unknown as {
        issuedRuns: Map<string, { tracing?: unknown; issuedTracing?: unknown }>;
      }
    ).issuedRuns;
    for (const record of issued.values()) {
      expect(record.tracing).toBeUndefined();
      expect(record.issuedTracing).toBeUndefined();
    }
    const child = await startSpan({ parent: workflow! });
    expect(child.context.parentSpanId).toBe(workflow!.context.spanId);
    child.close();
  },
);
it('inherits a lexical workflow in a delayed arbitrary Promise task', async () => {
  const gate = Promise.withResolvers<void>();
  let child: Promise<void>;
  let workflow: Awaited<ReturnType<typeof startTrace>>;
  await withTrace({}, (value) => {
    workflow = value;
    child = (async () => {
      await gate.promise;
      await withSpan({}, (span) => {
        expect(span.context.parentSpanId).toBe(workflow.context.spanId);
        expect(getCurrentTrace()).toBe(workflow);
      });
    })();
  });
  gate.resolve();
  await child!;
});
it('suppresses processor descendants including detached scopes and captured operations', async () => {
  const { suppressTracing } = await import('../src/runtime/tracing-context');
  await suppressTracing(async () => {
    await Promise.resolve();
    await withTrace({ parent: null, disabled: false }, async (span) => {
      expect(span.context.disabled).toBe(true);
      await withSpan({ detached: true, disabled: false }, (child) =>
        expect(child.context.disabled).toBe(true),
      );
    });
    const captured = captureTracing()!;
    expect((await captured.ready).context.disabled).toBe(true);
    captured.finish();
  });
  await withTrace({}, (span) => expect(span.context.disabled).toBe(false));
});

it.each(['traced', 'disabled', 'untraced'] as const)(
  'restores direct manual reply validation (%s)',
  async (mode) => {
    const { manualTool } = await import('../src/runtime/manual');
    const { NativeAgents } = await import('../src/runtime/native-agents');
    const { z } = await import('zod');
    const observations: Array<{
      span: ReturnType<typeof getCurrentSpan>;
      workflow: ReturnType<typeof getCurrentTrace>;
    }> = [];
    const declaration = manualTool({
      name: 'direct_probe',
      description: 'manual validation',
      parameters: z.object({}),
      result: z.string().superRefine((value, context) => {
        observations.push({
          span: getCurrentSpan(),
          workflow: getCurrentTrace(),
        });
        if (value === 'invalid')
          context.addIssue({ code: 'custom', message: 'invalid' });
      }),
    });
    const events = Array.from({ length: 2 }, () =>
      Promise.withResolvers<string>(),
    );
    const interception = Promise.withResolvers<string>();
    let submitted: Record<string, unknown> = {};
    const child = {
      session_id: 'trace-fixture',
      child_id: 'child',
      incarnation: '1',
      turn_id: 'child-turn',
      instance_id: 'instance',
    } as import('../native/index.js')._NativeChildTurn;
    const session = await rootFixture(
      async (wire) => {
        submitted = JSON.parse(wire);
        return JSON.stringify({ status: 'started', turn_id: 'root' });
      },
      { nativeAgents: new NativeAgents() },
      {},
      events,
      {
        _child_turn: async () => child,
        _enable_native_interception: () => true,
        _configure_native_interception: () => true,
        _next_native_interception: () => interception.promise,
        _revoke_native_interception: () => {
          interception.resolve('null');
        },
        _finish_native_interception_reader: () => {},
        _configure_manual_tools: () => {},
        _manual_checkpoint_config_supported: async () => false,
        _manual_tool_current: () => true,
        _pending_manual_tools: () => '[]',
        _respond_python_tool: async () => true,
      },
      [declaration],
    );
    let workflow: Awaited<ReturnType<typeof startTrace>> | undefined;
    let token: string | undefined;
    try {
      if (mode === 'untraced') await session.submit('run');
      else
        await withTrace(
          { disabled: mode === 'disabled', includeSensitiveData: false },
          async (value) => {
            workflow = value;
            await session.submit('run');
          },
        );
      const operation = harness.contexts.get(
        submitted.tracing_context as string,
      );
      if (operation)
        token = harness.native.retain_trace_context(operation.handle as string);
      const requestReady = (async () => {
        for await (const event of session.events()) {
          const request = declaration.match(event);
          if (request) return request;
        }
        throw new Error('Missing request');
      })();
      events[0].resolve(
        JSON.stringify({
          id: 'child-turn',
          subagent_id: 'child',
          subagent_incarnation: '1',
          subagent_instance_id: 'instance',
          msg: {
            type: 'dynamic_tool_call_request',
            tool: 'direct_probe',
            namespace: null,
            callId: 'manual-call',
            turnId: 'child-turn',
            arguments: {},
            tracing_context: token,
            _sdk_code_origin: null,
            _sdk_model: 'fixture',
            _sdk_python_tool: {
              thread: 'child',
              instance: '1',
              generation: '0',
              slot: 0,
              manual_grant: 'grant',
            },
          },
        }),
      );
      const request = await requestReady;
      const records = (
        session as unknown as {
          manualCalls: Map<string, { tracing?: unknown }>;
        }
      ).manualCalls;
      const record = [...records.values()][0];
      await withTrace({ name: 'unrelated' }, async () => {
        await expect(session.submit(request.reply('invalid'))).rejects.toThrow(
          'Manual tool result failed validation',
        );
        expect(records.size).toBe(1);
        await session.submit(request.reply('valid'));
      });
      expect(observations).toHaveLength(2);
      for (const observed of observations) {
        expect(observed.workflow).toBe(workflow);
        if (mode === 'untraced') expect(observed.span).toBeUndefined();
        else {
          expect(observed.span?.kind).toBe('validation');
          expect(observed.span?.context.disabled).toBe(mode === 'disabled');
          expect(observed.span?.context.includeSensitiveData).toBe(false);
        }
      }
      expect(records.size).toBe(0);
      expect(record.tracing).toBeUndefined();
    } finally {
      await session.close();
      if (token) harness.native.release_trace_context(token);
    }
  },
);

it.each(['rejected success', 'aborted failure'] as const)(
  'settles managed span after native acceptance: %s',
  async (outcome) => {
    const { tool, ToolOutput } = await import('../src/runtime/tools');
    const { z } = await import('zod');
    const events = Array.from({ length: 2 }, () =>
      Promise.withResolvers<string>(),
    );
    const responding = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<boolean>();
    let span: ReturnType<typeof getCurrentSpan>;
    let submitted: Record<string, unknown> = {};
    const declaration = tool({
      name: 'outcome_probe',
      parameters: z.object({}),
      execute: () => {
        span = getCurrentSpan();
        return new ToolOutput(
          [{ type: 'inputText', text: 'result' }],
          outcome === 'rejected success',
        );
      },
    });
    const session = await rootFixture(
      async (wire) => {
        submitted = JSON.parse(wire);
        return JSON.stringify({ status: 'started', turn_id: 'root' });
      },
      {},
      {},
      events,
      {
        _check_python_tool: () => {},
        _respond_python_tool: async () => {
          responding.resolve();
          return accepted.promise;
        },
      },
      [declaration],
    );
    try {
      await withTrace({}, () => session.submit('run'));
      events[0].resolve(
        JSON.stringify({
          id: 'root',
          msg: {
            type: 'dynamic_tool_call_request',
            tool: 'outcome_probe',
            namespace: null,
            callId: 'outcome-call',
            turnId: 'root',
            arguments: {},
            tracing_context: submitted.tracing_context,
            _sdk_code_origin: null,
            _sdk_model: 'fixture',
            _sdk_python_tool: {
              thread: 'trace-fixture',
              generation: '0',
              slot: 0,
            },
          },
        }),
      );
      await responding.promise;
      const ends = () =>
        harness.native.end_trace_span.mock.calls.filter(
          ([handle]) => handle === span!.handle,
        );
      expect(ends()).toHaveLength(0);
      const closing =
        outcome === 'aborted failure' ? session.close() : undefined;
      accepted.resolve(outcome === 'aborted failure');
      if (closing) await closing;
      await vi.waitFor(() => expect(ends()).toHaveLength(1));
      expect(JSON.parse(ends()[0][1]).status).toBe('cancelled');
    } finally {
      accepted.resolve(false);
      await session.close();
    }
  },
);

it.each(['tracing admission', 'native submission'] as const)(
  'keeps only known pre-submit failures idle: %s',
  async (phase) => {
    const failure = new Error(phase);
    let nativeCalls = 0;
    const session = await rootFixture(async () => {
      nativeCalls++;
      if (phase === 'native submission') throw failure;
      return JSON.stringify({ status: 'started', turn_id: 'healthy' });
    });
    try {
      if (phase === 'tracing admission')
        harness.native.start_trace_span.mockImplementationOnce(() => {
          throw failure;
        });
      await expect(
        session.submit('invalid', { tracing: { name: 'invalid' } }),
      ).rejects.toBe(failure);
      if (phase === 'tracing admission') {
        expect(nativeCalls).toBe(0);
        expect((await session.submit('healthy')).turnId).toBe('healthy');
        expect(nativeCalls).toBe(1);
      } else {
        await expect(session.submit('after retirement')).rejects.toThrow();
        expect(nativeCalls).toBe(1);
      }
    } finally {
      await session.close();
    }
  },
);
it('resolves a retained predecessor workflow after tracing transfers', async () => {
  const events = Array.from({ length: 3 }, () =>
    Promise.withResolvers<string>(),
  );
  const starts: Record<string, unknown>[] = [];
  const session = await rootFixture(
    async (wire) => {
      const input = JSON.parse(wire);
      if (input.mode === 'steer')
        return JSON.stringify({ status: 'steered', turn_id: 'root-1' });
      starts.push(input);
      return JSON.stringify({
        status: 'started',
        turn_id: `root-${starts.length}`,
      });
    },
    {},
    { _managed_instructions: true },
    events,
  );
  try {
    let workflow: Awaited<ReturnType<typeof startTrace>>;
    const turn = await withTrace({}, async (span) => {
      workflow = span;
      return session.submit('first');
    });
    const internals = session as unknown as {
      issuedRuns: Map<
        string,
        {
          tracing?: unknown;
          issuedTracing?: unknown;
          controller: AbortController;
        }
      >;
      invokeCallback: (
        run: unknown,
        callback: () => Promise<void>,
        signal: AbortSignal,
        context: string,
      ) => Promise<void>;
    };
    const predecessor = internals.issuedRuns.get('root-1')!;
    await turn.steer('retained');
    events[0].resolve(
      JSON.stringify({
        id: 'root-1',
        msg: { type: 'task_complete', last_agent_message: 'intermediate' },
        sdk_unsampled_steering: true,
      }),
    );
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(predecessor.tracing).toBeUndefined();
    expect(predecessor.issuedTracing).toBeDefined();
    await internals.invokeCallback(
      predecessor,
      async () => {
        expect(getCurrentTrace()).toBe(workflow!);
        await withSpan({}, () => expect(getCurrentTrace()).toBe(workflow!));
      },
      predecessor.controller.signal,
      starts[0].tracing_context as string,
    );
  } finally {
    await session.close();
  }
});
it('clears processor descriptors when native terminal shutdown rejects', async () => {
  const telemetry = await import('../src/runtime/telemetry');
  await telemetry.setTraceProcessors([{ onEvent() {} }]);
  const failure = new Error('terminal shutdown failure');
  harness.native.shutdown_telemetry.mockRejectedValueOnce(failure);
  await expect(shutdown()).rejects.toBe(failure);
  const terminal = new Error('native routes are terminal');
  harness.native.set_trace_routes.mockImplementationOnce(() => {
    throw terminal;
  });
  await expect(
    telemetry.setTraceProcessors(
      Array.from({ length: 64 }, () => ({ onEvent() {} })),
    ),
  ).rejects.toBe(terminal);
});
it('clears registration ambient from the processor pump and callbacks', async () => {
  const telemetry = await import('../src/runtime/telemetry');
  let delivered = 0;
  await withTrace({ name: 'registration' }, () =>
    telemetry.setTraceProcessors([
      {
        async onEvent() {
          expect(getCurrentSpan()).toBeUndefined();
          expect(getCurrentTrace()).toBeUndefined();
          await Promise.resolve();
          expect(getCurrentSpan()).toBeUndefined();
          delivered++;
        },
      },
    ]),
  );
  const ids = JSON.parse(
    harness.native.set_trace_routes.mock.calls.at(-1)![0],
  ).processor_ids;
  harness.native.drain_trace_events.mockResolvedValueOnce(
    JSON.stringify({
      events: [
        {
          sequence: 100000,
          lifecycle: 'end',
          processor_ids: ids,
          attributes: {},
        },
      ],
      through_sequence: 100000,
    }),
  );
  await forceFlush();
  await vi.waitFor(() => expect(delivered).toBe(1));
  await telemetry.setTraceProcessors([]);
});

it.each(['expired', 'live', 'entered'] as const)(
  'discards only pre-entry expired question context: %s',
  async (state) => {
    const { parseEvent } = await import('../src/runtime/events');
    let checks = 0;
    const session = await rootFixture(
      async () => JSON.stringify({ status: 'started', turn_id: 'root' }),
      {},
      {},
      undefined,
      {
        _native_question_pending: async () =>
          ++checks === 1 || state === 'live',
      },
    );
    await session.submit('run');
    const source = await startTrace();
    const token = source.retain();
    if (state !== 'entered') source.releaseContext(token);
    const internals = session as unknown as {
      issuedRuns: Map<string, unknown>;
      trackNativeQuestion: (owner: never, event: never) => Promise<void>;
      track: () => void;
      admitNativeQuestion: (...args: unknown[]) => Promise<void>;
    };
    const failure = new Error('entered question callback failure');
    const admit = vi
      .spyOn(internals, 'admitNativeQuestion')
      .mockRejectedValue(failure);
    vi.spyOn(internals, 'track').mockImplementation(() => {});
    try {
      const event = parseEvent(
        JSON.stringify({
          id: 'root',
          msg: {
            type: 'exec_approval_request',
            turn_id: 'root',
            _sdk_question_id: 'question',
            tracing_context: token,
          },
        }),
      );
      const pending = internals.trackNativeQuestion(
        internals.issuedRuns.get('root') as never,
        event as never,
      );
      if (state === 'expired') await expect(pending).resolves.toBeUndefined();
      else
        await expect(pending).rejects.toThrow(
          state === 'entered'
            ? 'entered question callback failure'
            : 'Unknown or released',
        );
      expect(admit).toHaveBeenCalledTimes(state === 'entered' ? 1 : 0);
      expect(checks).toBe(state === 'entered' ? 1 : 2);
    } finally {
      if (state === 'entered') source.releaseContext(token);
      source.close();
      await session.close();
    }
  },
);
it('retains nested question callback context after admission and grant release', async () => {
  let submitted: Record<string, unknown> = {};
  const session = await rootFixture(async (wire) => {
    submitted = JSON.parse(wire);
    return JSON.stringify({ status: 'started', turn_id: 'root' });
  });
  let workflow: Awaited<ReturnType<typeof startTrace>>;
  await withTrace({}, async (span) => {
    workflow = span;
    await session.submit('run');
  });
  const internals = session as unknown as {
    issuedRuns: Map<string, unknown>;
    trackQuestionCallback: (
      owner: never,
      callback: () => Promise<void>,
    ) => Promise<void>;
  };
  const borrowed = harness.native.retain_trace_context(
    submitted.tracing_context as string,
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let callback: Promise<void>;
  try {
    await withoutTracing(() =>
      withNativeCallbackContext(
        borrowed,
        () => {
          callback = internals.trackQuestionCallback(
            internals.issuedRuns.get('root') as never,
            async () => {
              entered.resolve();
              await release.promise;
              expect(getCurrentTrace()).toBe(workflow!);
              await withSpan({}, () =>
                expect(getCurrentTrace()).toBe(workflow!),
              );
            },
          );
        },
        undefined,
        () => workflow!,
      ),
    );
    await entered.promise;
    harness.native.release_trace_context(borrowed);
    release.resolve();
    await callback!;
  } finally {
    release.resolve();
    await session.close();
  }
});

it.each([true, false])(
  'creates one root question callback span only while pending: %s',
  async (live) => {
    const { parseEvent } = await import('../src/runtime/events');
    let carrier: string;
    const session = await rootFixture(
      async (wire) => {
        carrier = JSON.parse(wire).tracing_context;
        return JSON.stringify({ status: 'started', turn_id: 'root' });
      },
      {},
      {},
      undefined,
      { _native_question_pending: async () => live },
    );
    let workflow: Awaited<ReturnType<typeof startTrace>>;
    await withTrace({}, async (span) => {
      workflow = span;
      await session.submit('run');
    });
    const internals = session as unknown as {
      issuedRuns: Map<string, { toolInvocations: Set<Promise<void>> }>;
      trackNativeQuestion: (owner: never, event: never) => Promise<void>;
      admitNativeQuestion: () => Promise<void>;
    };
    const owner = internals.issuedRuns.get('root')!;
    const admit = vi
      .spyOn(internals, 'admitNativeQuestion')
      .mockImplementation(async () => {
        expect(getCurrentTrace()).toBe(workflow!);
      });
    const before = harness.starts.length;
    const ended = harness.native.end_trace_span.mock.calls.length;
    try {
      const event = parseEvent(
        JSON.stringify({
          id: 'root',
          msg: {
            type: 'exec_approval_request',
            turn_id: 'root',
            _sdk_question_id: 'question',
            tracing_context: carrier!,
          },
        }),
      );
      const pending = withoutTracing(() =>
        internals.trackNativeQuestion(owner as never, event as never),
      );
      expect(owner.toolInvocations.has(pending)).toBe(true);
      await pending;
      expect(owner.toolInvocations.size).toBe(0);
      const callbacks = harness.starts
        .slice(before)
        .filter((span) => span.name === 'host.callback');
      expect(callbacks).toHaveLength(live ? 1 : 0);
      if (live) expect(callbacks[0].parent).toBe(carrier!);
      expect(harness.native.end_trace_span.mock.calls.length - ended).toBe(
        live ? 1 : 0,
      );
      expect(admit).toHaveBeenCalledTimes(live ? 1 : 0);
    } finally {
      await session.close();
    }
  },
);

it.each(['submit', 'submitWithOutput', 'enqueue'] as const)(
  'snapshots W3C parent and scoped policy fields for %s',
  async (method) => {
    const { z } = await import('zod');
    const { TraceContext } = await import('../src/runtime/trace-context');
    const fallback = new TraceContext({
      traceparent: '00-' + '3'.repeat(32) + '-' + '4'.repeat(16) + '-01',
    });
    const selected = {
      traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01',
    };
    const original = selected.traceparent;
    let submitted: Record<string, unknown> = {};
    const session = await rootFixture(
      async (wire) => {
        submitted = JSON.parse(wire);
        return JSON.stringify({ status: 'started', turn_id: 'root' });
      },
      { parentTrace: fallback },
    );
    try {
      await withTrace({}, async () => {
        const options = {
          parentTrace: selected,
          tracing: { disabled: true, includeSensitiveData: false },
        };
        const admitted =
          method === 'submit'
            ? session.submit('root', options)
            : method === 'submitWithOutput'
              ? session.submitWithOutput('root', z.string(), options)
              : session.enqueue('root', undefined, options);
        selected.traceparent = 'changed after admission capture';
        await admitted;
      });
      // Native checks parent compatibility; this fixture verifies host forwarding only.
      await vi.waitFor(() =>
        expect(submitted.trace).toEqual({ traceparent: original }),
      );
      expect(
        harness.contexts.get(submitted.tracing_context as string),
      ).toMatchObject({ disabled: true, include_sensitive_data: false });
    } finally {
      await session.close();
    }
  },
);

it.each([false, true])(
  'keeps a Session usable after a parent conflict (operation MCP: %s)',
  async (operationMcp) => {
    const { HttpMCP } = await import('../src/runtime/mcp');
    let calls = 0;
    const publish = vi.fn(async () =>
      JSON.stringify({
        result: {
          publication: 'published',
          ready: true,
          policy_generation: '1',
          servers: {
            records: {
              accepted: true,
              ready: true,
              status: 'connected',
              listing_error: false,
              tools: ['read'],
            },
          },
        },
      }),
    );
    const session = await rootFixture(
      async () => {
        if (++calls === 1)
          return JSON.stringify({
            status: 'not_submitted',
            reason: {
              type: 'trace_context_conflict',
              message:
                'Explicit trace context must match the SDK tracing parent',
            },
          });
        return JSON.stringify({ status: 'started', turn_id: 'healthy' });
      },
      operationMcp
        ? {
            mcpTools: [
              new HttpMCP({
                name: 'records',
                tools: ['read'],
                url: 'http://127.0.0.1:1/mcp',
                activation: 'operation',
              }),
            ],
          }
        : {},
      {},
      undefined,
      { _replace_mcp_servers: publish, _revoke_native_interception() {} },
    );
    try {
      await withTrace({}, async () => {
        await expect(
          session.submit('conflicting', {
            parentTrace: {
              traceparent:
                '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01',
            },
          }),
        ).rejects.toThrow('Explicit trace context must match');
      });
      expect((await session.submit('healthy')).turnId).toBe('healthy');
      expect(calls).toBe(2);
      expect(publish).toHaveBeenCalledTimes(operationMcp ? 1 : 0);
    } finally {
      await session.close();
    }
  },
);

it.each(['live', 'expired', 'missing carrier'] as const)(
  'traces root MCP result transformation once after validity: %s',
  async (state) => {
    const { HttpMCP } = await import('../src/runtime/mcp');
    let submitted: Record<string, unknown> = {};
    const released = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const result = { content: [{ type: 'text', text: 'transformed' }] };
    let workflow: Awaited<ReturnType<typeof startTrace>>;
    const transform = vi.fn(async () => {
      expect(getCurrentTrace()).toBe(workflow!);
      expect(() => session.close()).toThrow('cannot close its own session');
      await expect(session.submit('reentrant')).rejects.toThrow(
        'cannot submit to its own session',
      );
      entered.resolve();
      await release.promise;
      return result;
    });
    const next = vi.fn();
    const resolve = vi.fn(() => true);
    const fail = vi.fn(() => true);
    const releaseNotice = vi.fn(() => {
      released.resolve();
      return true;
    });
    const session = await rootFixture(
      async (wire) => {
        submitted = JSON.parse(wire);
        return JSON.stringify({ status: 'started', turn_id: 'root' });
      },
      {
        mcpTools: [
          new HttpMCP({
            name: 'records',
            tools: ['read'],
            url: 'http://127.0.0.1:1/mcp',
            transformResult: transform,
          }),
        ],
      },
      {},
      undefined,
      {
        _next_native_mcp_result: next,
        _handoff_native_mcp_result: () => true,
        _check_native_mcp_result: () => state !== 'expired',
        _resolve_native_mcp_result: resolve,
        _fail_native_mcp_result: fail,
        _release_native_mcp_result: releaseNotice,
        _revoke_native_interception() {},
      },
    );
    await withTrace({}, async (span) => {
      workflow = span;
      await session.submit('run');
    });
    const internals = session as unknown as {
      readMcpResults: () => Promise<void>;
      issuedRuns: Map<string, { toolInvocations: Set<Promise<void>> }>;
    };
    next
      .mockResolvedValueOnce(
        JSON.stringify({
          nonce: 'notice',
          thread_id: 'trace-fixture',
          turn_id: 'root',
          call_id: 'mcp-call',
          source: 'config',
          server_name: 'records',
          tool_name: 'read',
          callable_namespace: 'mcp__records',
          callable_name: 'read',
          arguments: {},
          result: {},
          generation: '0',
          ...(state === 'missing carrier'
            ? {}
            : { tracing_context: submitted.tracing_context }),
        }),
      )
      .mockResolvedValue('null');
    const before = harness.starts.length;
    const ended = harness.native.end_trace_span.mock.calls.length;
    try {
      await withoutTracing(() => internals.readMcpResults());
      if (state !== 'expired') {
        await entered.promise;
        expect(
          internals.issuedRuns.get('root')!.toolInvocations.size,
        ).toBeGreaterThan(0);
        release.resolve();
      }
      await released.promise;
      await vi.waitFor(() =>
        expect(internals.issuedRuns.get('root')!.toolInvocations.size).toBe(0),
      );
      const callbacks = harness.starts
        .slice(before)
        .filter((span) => span.name === 'host.callback');
      expect(callbacks).toHaveLength(state === 'expired' ? 0 : 1);
      if (state === 'live')
        expect(callbacks[0].parent).toBe(submitted.tracing_context);
      expect(harness.native.end_trace_span.mock.calls.length - ended).toBe(
        state === 'expired' ? 0 : 1,
      );
      expect(transform).toHaveBeenCalledTimes(state === 'expired' ? 0 : 1);
      expect(resolve).toHaveBeenCalledTimes(state === 'expired' ? 0 : 1);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(releaseNotice).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await session.close();
    }
  },
);

it.each(['live', 'aborted', 'explicit ok', 'explicit error'] as const)(
  'settles native callback normal return after cancellation: %s',
  async (state) => {
    const source = await startTrace();
    const token = source.retain();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const result = { reply: 'synthetic' };
    let callbackSpan: ReturnType<typeof getCurrentSpan>;
    const pending = withNativeCallbackContext(
      token,
      async () => {
        callbackSpan = getCurrentSpan();
        if (state === 'explicit ok') callbackSpan!.end({ status: 'ok' });
        if (state === 'explicit error') callbackSpan!.end({ status: 'error' });
        entered.resolve();
        await release.promise;
        return result;
      },
      controller.signal,
    );
    try {
      await entered.promise;
      if (state !== 'live')
        controller.abort(new Error('synthetic cancellation'));
      release.resolve();
      expect(await pending).toBe(result);
      const ends = harness.native.end_trace_span.mock.calls.filter(
        ([handle]) => handle === callbackSpan!.handle,
      );
      expect(ends).toHaveLength(1);
      const outcome = JSON.parse(ends[0][1]);
      expect(outcome.status).toBe(
        state === 'aborted'
          ? 'cancelled'
          : state === 'explicit error'
            ? 'error'
            : 'ok',
      );
      if (state === 'aborted') expect(outcome.category).toBe('cancelled');
    } finally {
      release.resolve();
      source.releaseContext(token);
      source.close();
    }
  },
);
