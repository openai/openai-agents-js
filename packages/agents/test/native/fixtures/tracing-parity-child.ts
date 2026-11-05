import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  telemetry,
  tool,
  manualTool,
} from '../../../src';
import { text, toolCall, withScriptedResponses } from '../../../src/testing';
import { call, message, ModelServer } from './model-server';
import { binding, type NativeThread } from '../../../src/runtime/binding';
import type { TraceEvent, Exporter } from '../../../src/runtime/telemetry';

type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes?: {
    key: string;
    value: { stringValue?: string; intValue?: string | number };
  }[];
};
function identity(value: string): string {
  return /^[0-9a-f]+$/i.test(value)
    ? value.toLowerCase()
    : Buffer.from(value, 'base64').toString('hex');
}
function attrs(span: Span): Record<string, string | number | undefined> {
  return Object.fromEntries(
    (span.attributes ?? []).map(({ key, value }) => [
      key,
      value.stringValue ?? value.intValue,
    ]),
  );
}
function decoded(batches: unknown[]): Span[] {
  return batches.flatMap(
    (batch) =>
      (
        batch as { resourceSpans?: { scopeSpans?: { spans?: Span[] }[] }[] }
      ).resourceSpans?.flatMap(
        (resource) =>
          resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? [],
      ) ?? [],
  );
}
function descendant(span: Span, ancestor: Span, spans: Span[]): boolean {
  const byId = new Map(spans.map((value) => [identity(value.spanId), value]));
  const seen = new Set<string>();
  let parent = span.parentSpanId;
  while (parent && !seen.has(parent)) {
    if (identity(parent) === identity(ancestor.spanId)) return true;
    seen.add(parent);
    parent = byId.get(identity(parent))?.parentSpanId;
  }
  return false;
}
function matchingPaths(value: unknown, needle: string, path = '$'): string[] {
  if (typeof value === 'string') return value.includes(needle) ? [path] : [];
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) =>
      matchingPaths(item, needle, `${path}.${key}`),
    );
  return [];
}
async function receiver() {
  const batches: unknown[] = [];
  const authorization: (string | undefined)[] = [];
  let bytes = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      assert(
        bytes < 8_388_608,
        'Bounded synthetic collector exceeded capacity',
      );
      chunks.push(Buffer.from(chunk));
    }
    batches.push(JSON.parse(Buffer.concat(chunks).toString()));
    authorization.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
    batches,
    authorization,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
async function flush() {
  const result = await telemetry.forceFlush({ timeoutMs: 5_000 });
  assert.equal(result.status, 'success', JSON.stringify(result));
}
async function contextCase(batches: unknown[]) {
  await telemetry.withTrace(
    { name: 'workflow.shared_outer', traceId: '4'.repeat(32) },
    async (outer) => {
      await telemetry.withTrace(
        { name: 'workflow.shared_inner' },
        async (inner) => {
          assert.equal(inner.context.traceId, outer.context.traceId);
          assert.notEqual(inner.context.spanId, outer.context.spanId);
          assert.equal(telemetry.getCurrentTrace(), inner);
          await telemetry.withSpan({}, () =>
            assert.equal(telemetry.getCurrentTrace(), inner),
          );
          await telemetry.withSpan({ parent: outer }, () =>
            assert.equal(telemetry.getCurrentTrace(), outer),
          );
          await telemetry.withSpan({ parent: null }, () =>
            assert.equal(telemetry.getCurrentTrace(), undefined),
          );
        },
      );
      assert.equal(telemetry.getCurrentTrace(), outer);
    },
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let effects = 0;
  let callbackTrace = '';
  let workflowHandle: telemetry.TraceSpan | undefined;
  let stepCalls = 0;
  const server = new ModelServer(
    [
      [call('probe', { value: 'synthetic' }, { callId: 'probe-1' })],
      [message('first-answer')],
      [message('second-answer')],
      [message('after-flush')],
    ],
    {
      input_tokens: 7,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 12,
    },
  );
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'model-only-synthetic',
  });
  try {
    const agent = new Agent({
      instructions: 'Use probe then answer.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'probe',
          parameters: z.object({ value: z.string() }),
          execute: async () => {
            effects++;
            assert.equal(telemetry.getCurrentTrace(), workflowHandle);
            callbackTrace = telemetry.getCurrentSpan()?.context.traceId ?? '';
            entered.resolve();
            await release.promise;
            return telemetry.withSpan({ name: 'application.tool_work' }, () => {
              assert.equal(telemetry.getCurrentTrace(), workflowHandle);
              return 'tool-result';
            });
          },
        }),
      ],
    });
    await using session = await agent.session();
    let first: Awaited<ReturnType<typeof session.submit>> | undefined;
    let queued: Awaited<ReturnType<typeof session.enqueue>> | undefined;
    let firstTrace = '';
    let firstHandle = '';
    let queuedTrace = '';
    await telemetry.withTrace(
      {
        name: 'workflow.first',
        traceId: 'trace_ABCDEF0123456789ABCDEF0123456789',
        groupId: 'synthetic-group',
        metadata: { attempt: 1 },
      },
      async (span) => {
        firstTrace = span.context.traceId;
        firstHandle = span.handle;
        workflowHandle = span;
        first = await telemetry.withSpan(
          { name: 'application.admit_first' },
          () =>
            session.submit('first', {
              beforeStep: async () => {
                stepCalls++;
                assert.equal(telemetry.getCurrentTrace(), workflowHandle);
                await telemetry.withSpan(
                  { name: 'application.step_work' },
                  () => {
                    assert.equal(telemetry.getCurrentTrace(), workflowHandle);
                  },
                );
                return undefined;
              },
            }),
        );
        await entered.promise;
      },
    );
    await telemetry.withTrace({ name: 'workflow.queued' }, async (span) => {
      queuedTrace = span.context.traceId;
      queued = await session.enqueue('second');
    });
    release.resolve();
    assert.equal((await first!.wait()).finalOutput, 'first-answer');
    assert(stepCalls >= 2, 'Both native model steps must restore the workflow');
    assert.equal((await queued!.wait()).finalOutput, 'second-answer');
    assert.equal(callbackTrace, firstTrace);
    assert.equal(firstTrace, 'abcdef0123456789abcdef0123456789');
    assert.notEqual(firstTrace, queuedTrace);
    assert.equal(effects, 1);
    await flush();
    assert.equal(
      (await (await session.submit('third')).wait()).finalOutput,
      'after-flush',
    );
    const saved = JSON.stringify(await session.saveState());
    assert(!saved.includes('tracing_context'));
    assert(!saved.includes(firstHandle));
    // TurnStartedEvent intentionally stores inert trace IDs for rollout consumers.
    assert(
      matchingPaths(JSON.parse(saved), firstTrace).every((path) =>
        /^\$\.history\.\d+\.payload\.trace_id$/.test(path),
      ),
    );
    server.assertExhausted();
    await flush();
    const spans = decoded(batches);
    const firstWorkflow = spans.find((span) => span.name === 'workflow.first');
    const queuedWorkflow = spans.find(
      (span) => span.name === 'workflow.queued',
    );
    const custom = spans.find((span) => span.name === 'application.tool_work');
    assert(
      firstWorkflow && queuedWorkflow && custom,
      'Missing workflow/custom native OTLP spans',
    );
    assert.equal(identity(firstWorkflow.traceId), firstTrace);
    assert.equal(identity(queuedWorkflow.traceId), queuedTrace);
    assert(
      descendant(custom, firstWorkflow, spans),
      'Delayed callback custom span lost workflow ancestry',
    );
    assert.equal(attrs(firstWorkflow)['sdk.group_id'], 'synthetic-group');
    assert.equal(Number(attrs(firstWorkflow)['sdk.metadata.attempt']), 1);
    const native = spans.filter((span) => !attrs(span)['sdk.span.kind']);
    assert(
      native.some(
        (span) =>
          identity(span.traceId) === firstTrace &&
          descendant(span, firstWorkflow, spans),
      ),
      'First root has no native descendants',
    );
    assert(
      native.some(
        (span) =>
          identity(span.traceId) === queuedTrace &&
          descendant(span, queuedWorkflow, spans),
      ),
      'Queued root lost native ancestry',
    );
    const usage = native.filter(
      (span) => attrs(span)['gen_ai.usage.input_tokens'] !== undefined,
    );
    assert(usage.length > 0, 'Missing native model usage records');
    assert(
      usage.some(
        (span) =>
          Number(attrs(span)['gen_ai.usage.input_tokens']) === 7 &&
          Number(attrs(span)['gen_ai.usage.output_tokens']) === 5,
      ),
      'Native OTLP usage changed scripted token counts',
    );
  } finally {
    release.resolve();
    await provider.close();
    await ModelServer.closeAll();
  }
}
async function controlCase(batches: unknown[]) {
  const canary = 'SCOPED_PAYLOAD_CANARY';
  const disabledParent = await telemetry.startTrace({
    name: 'disabled.parent',
    disabled: true,
  });
  try {
    await telemetry.withTrace(
      { name: 'workflow.detached_ambient', includeSensitiveData: true },
      () =>
        telemetry.withSpan(
          {
            name: 'disabled.detached',
            parent: disabledParent,
            detached: true,
            includeSensitiveData: true,
          },
          (span) => {
            assert.equal(span.context.disabled, true);
            assert.equal(span.context.parentSpanId, null);
            assert.equal(telemetry.getCurrentTrace(), undefined);
          },
        ),
    );
  } finally {
    disabledParent.close();
  }

  await withScriptedResponses([[text('disabled-answer')]], async (peer) => {
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider: peer.provider,
    });
    await using session = await agent.session({ tracing: { disabled: true } });
    await telemetry.withTrace(
      { name: 'workflow.enabled_ambient', includeSensitiveData: true },
      async () => {
        await telemetry.withTrace(
          {
            name: 'workflow.explicit_parent',
            detached: true,
            includeSensitiveData: true,
          },
          async (parent) => {
            const turn = await session.submit(canary, {
              tracing: {
                name: 'disabled.operation',
                parent,
                includeSensitiveData: true,
              },
              ifBusy: 'reject',
            });
            assert.equal((await turn.wait()).finalOutput, 'disabled-answer');
          },
        );
      },
    );
    peer.assertExhausted();
  });
  await withScriptedResponses(
    [
      [toolCall('probe', { value: canary }, { callId: 'metadata-tool' })],
      [text(canary)],
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Use probe.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'probe',
            parameters: z.object({ value: z.string() }),
            execute: () => canary,
          }),
        ],
      });
      await using session = await agent.session({
        tracing: { name: 'metadata.session', includeSensitiveData: false },
      });
      await telemetry.withTrace(
        { name: 'workflow.payload_requested', includeSensitiveData: true },
        async (parent) => {
          const turn = await session.submit(canary, {
            tracing: {
              name: 'metadata.operation',
              parent,
              includeSensitiveData: true,
            },
            ifBusy: 'reject',
          });
          assert.equal((await turn.wait()).finalOutput, canary);
        },
      );
      peer.assertExhausted();
    },
  );
  await withScriptedResponses(
    [[toolCall('fail', {}, { callId: 'failed-tool' })]],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Use fail.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'fail',
            parameters: z.object({}),
            execute: () => {
              throw new Error('PRIVATE_CALLBACK_CANARY');
            },
          }),
        ],
      });
      await telemetry.withTrace(
        { name: 'workflow.callback_failure' },
        async () => {
          await assert.rejects(agent.run('fail'));
        },
      );
      peer.assertExhausted();
    },
  );
  await withScriptedResponses([[text('{"label":42}')]], async (peer) => {
    const agent = new Agent({
      instructions: 'Answer JSON.',
      model: 'gpt-5',
      provider: peer.provider,
      outputType: z.object({ label: z.string() }),
    });
    await telemetry.withTrace(
      { name: 'workflow.validation_failure' },
      async () => {
        await assert.rejects(agent.run('invalid'));
      },
    );
    peer.assertExhausted();
  });
  await flush();
  const spans = decoded(batches);
  assert(
    !spans.some(
      (span) =>
        span.name === 'disabled.operation' || span.name === 'disabled.detached',
    ),
  );
  assert(
    !JSON.stringify(spans).includes(canary),
    'Metadata-only or disabled policy leaked content',
  );
  assert(!JSON.stringify(spans).includes('PRIVATE_CALLBACK_CANARY'));
  assert(
    spans.some(
      (span) =>
        attrs(span)['sdk.outcome.category'] === 'tool_error' ||
        attrs(span)['sdk.outcome.category'] === 'callback_error',
    ),
    'Missing actual callback failure outcome',
  );
  assert(
    spans.some(
      (span) => attrs(span)['sdk.outcome.category'] === 'validation_error',
    ),
    'Missing actual output-validation outcome',
  );
  const metadata = spans.find((span) => span.name === 'metadata.operation');
  assert(metadata);
}
async function processorCase(batches: unknown[]) {
  const first: TraceEvent[] = [];
  const second: TraceEvent[] = [];
  await telemetry.addTraceProcessor({
    onEvent: (event) => {
      assert(Object.isFrozen(event));
      first.push(event);
    },
  });
  await telemetry.addTraceProcessor({
    onEvent: (event) => {
      second.push(event);
    },
  });
  await telemetry.withTrace({ name: 'routes.before' }, () =>
    telemetry.withSpan({ name: 'routes.child' }, () => {}),
  );
  await flush();
  assert.deepEqual(
    first.map((event) => [event.sequence, event.lifecycle]),
    second.map((event) => [event.sequence, event.lifecycle]),
  );
  assert(
    first.some((event) => event.lifecycle === 'start') &&
      first.some((event) => event.lifecycle === 'end'),
  );
  assert(
    decoded(batches).some((span) => span.name === 'routes.before'),
    'add removed native default exporter',
  );
  const replacement: TraceEvent[] = [];
  await telemetry.setTraceProcessors([
    {
      onEvent: (event) => {
        replacement.push(event);
      },
    },
  ]);
  await telemetry.withTrace({ name: 'routes.after' }, () => {});
  await flush();
  assert(replacement.some((event) => event.name === 'routes.after'));
  assert(!first.some((event) => event.name === 'routes.after'));
  assert(
    !decoded(batches).some((span) => span.name === 'routes.after'),
    'set retained native default exporter',
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await telemetry.addTraceProcessor({
    onEvent: async (event) => {
      if (event.name === 'routes.stall' && event.lifecycle === 'start') {
        entered.resolve();
        await release.promise;
      }
    },
  });
  await telemetry.withTrace({ name: 'routes.stall' }, () => {});
  await entered.promise;
  // The native tap admits at most 2048 unacknowledged snapshots. This held
  // processor prevents drain progress while 2400 new lifecycle events arrive.
  for (let index = 0; index < 1200; index++)
    await telemetry.withTrace({ name: 'routes.overflow' }, () => {});
  try {
    const start = performance.now();
    const timed = await telemetry.forceFlush({ timeoutMs: 100 });
    assert.equal(timed.status, 'timeout');
    assert(
      performance.now() - start < 2_000,
      'Flush multiplied or ignored its total timeout',
    );
    const longer = telemetry.forceFlush({ timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const shorterStart = performance.now();
    const shorter = await telemetry.forceFlush({ timeoutMs: 50 });
    assert.equal(shorter.status, 'timeout');
    const shorterElapsed = performance.now() - shorterStart;
    assert(
      shorterElapsed < 250,
      `Concurrent 50ms flush took ${shorterElapsed}ms while waiting for the provider owner`,
    );
    assert.equal((await longer).status, 'timeout');
  } finally {
    release.resolve();
  }
  const recovered = await telemetry.forceFlush({ timeoutMs: 5_000 });
  assert.equal(recovered.status, 'partial');
  assert(recovered.droppedRecords > 0, 'Native tap overflow was not reported');
  let effects = 0;
  await telemetry.addTraceProcessor({
    onEvent: () => {
      throw new Error('PRIVATE_PROCESSOR_CANARY');
    },
  });
  await withScriptedResponses(
    [
      [toolCall('effect', {}, { callId: 'effect-1' })],
      [text('first')],
      [toolCall('effect', {}, { callId: 'effect-2' })],
      [text('second')],
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Use effect.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'effect',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'effect';
            },
          }),
        ],
      });
      await using session = await agent.session();
      await telemetry.withTrace({ name: 'routes.failure' }, async () => {
        assert.equal(
          (await (await session.submit('first')).wait()).finalOutput,
          'first',
        );
        const partial = await telemetry.forceFlush({ timeoutMs: 5_000 });
        assert.equal(partial.status, 'partial');
        assert(partial.failedDeliveries > 0);
        assert.equal(
          (await (await session.submit('second')).wait()).finalOutput,
          'second',
        );
      });
      peer.assertExhausted();
    },
  );
  assert.equal(effects, 2, 'Processor failure altered actual tool effects');
}
async function retainedCase(
  batches: unknown[],
  authorization: (string | undefined)[],
) {
  const native = await binding();
  const nextEvent = native.NativeThread.prototype._next_session_event;
  const submit = native.NativeThread.prototype._submit;
  for (const disabled of [true, false]) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let originalId: string | undefined;
    let firstContext: string | undefined;
    let continuedContext: string | undefined;
    const sessionCredential = new telemetry.TraceExportCredentials({
      headers: { authorization: 'Bearer synthetic-session-default' },
    });
    const rootCredential = new telemetry.TraceExportCredentials({
      headers: { authorization: 'Bearer synthetic-retained-root' },
    });
    // Reuse the established conditional-tail seam: only the unsampled hint and
    // conditional admission are projected; both model turns execute natively.
    native.NativeThread.prototype._next_session_event = async function (
      this: NativeThread,
    ) {
      const raw = await nextEvent.call(this);
      const event = JSON.parse(raw);
      if (
        !originalId &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg.type)
      ) {
        originalId = event.id;
        event.sdk_unsampled_steering = true;
        return JSON.stringify(event);
      }
      return raw;
    };
    native.NativeThread.prototype._submit = async function (
      this: NativeThread,
      raw: string,
    ) {
      const request = JSON.parse(raw);
      if (request.mode === 'continue_if_idle') {
        assert.equal(request.expected_previous_turn_id, originalId);
        assert.deepEqual(request.input, []);
        continuedContext = request.tracing_context;
        entered.resolve();
        await release.promise;
        return submit.call(
          this,
          JSON.stringify({
            mode: 'start_if_idle',
            input: [{ type: 'text', text: 'RETAINED_PAYLOAD_CANARY' }],
            start: request.start,
            tracing_context: request.tracing_context,
          }),
        );
      }
      if (request.mode === 'start_if_idle')
        firstContext = request.tracing_context;
      return submit.call(this, raw);
    };
    try {
      await withScriptedResponses(
        [[text('intermediate')], [text('RETAINED_PAYLOAD_CANARY')]],
        async (peer) => {
          const agent = new Agent({
            instructions: 'Answer.',
            model: 'gpt-5',
            provider: peer.provider,
          });
          await using session = await agent.session({
            tracing: {
              name: 'retained.session',
              includeSensitiveData: true,
              exportCredential: sessionCredential,
            },
          });
          let traceId = '';
          const turn = await telemetry.withTrace(
            {
              name: `retained.workflow.${disabled}`,
              includeSensitiveData: true,
            },
            (workflow) => {
              traceId = workflow.context.traceId;
              return session.submit('RETAINED_PAYLOAD_CANARY', {
                tracing: {
                  name: 'retained.operation',
                  disabled,
                  includeSensitiveData: false,
                  exportCredential: rootCredential,
                },
              });
            },
          );
          rootCredential.close();
          const settled = turn.wait();
          void settled.catch(() => {});
          try {
            await entered.promise;
            assert(typeof firstContext === 'string');
            assert(
              firstContext === continuedContext,
              'Retained steering changed its admitting context',
            );
            const current = JSON.parse(native.trace_span_context(firstContext));
            assert.equal(current.trace_id, traceId);
            assert.equal(current.disabled, disabled);
            assert.equal(current.include_sensitive_data, false);
            release.resolve();
            assert.equal(
              (await settled).finalOutput,
              'RETAINED_PAYLOAD_CANARY',
            );
            peer.assertExhausted();
            await flush();
            const scoped = decoded(batches).filter(
              (span) => identity(span.traceId) === traceId,
            );
            if (disabled)
              assert(
                scoped.every(
                  (span) => attrs(span)['sdk.span.kind'] === 'workflow',
                ),
                'Retained disabled root emitted native spans',
              );
            else {
              assert.equal(
                scoped.filter((span) => span.name === 'retained.operation')
                  .length,
                1,
              );
              assert(
                scoped.some((span) => !attrs(span)['sdk.span.kind']),
                'Retained model work has no native descendants',
              );
              assert(
                !JSON.stringify(scoped).includes('RETAINED_PAYLOAD_CANARY'),
                'Retained metadata-only policy leaked content',
              );
              const deliveries = batches.flatMap((batch, index) =>
                decoded([batch])
                  .filter(
                    (span) =>
                      identity(span.traceId) === traceId &&
                      attrs(span)['sdk.span.kind'] !== 'workflow',
                  )
                  .map(() => authorization[index]),
              );
              assert(deliveries.length > 0);
              assert(
                deliveries.every(
                  (value) => value === 'Bearer synthetic-retained-root',
                ),
                'Retained root lost its selected credential',
              );
            }
          } finally {
            release.resolve();
          }
        },
      );
    } finally {
      release.resolve();
      sessionCredential.close();
      rootCredential.close();
      native.NativeThread.prototype._next_session_event = nextEvent;
      native.NativeThread.prototype._submit = submit;
    }
  }
}

async function customOnlyCase() {
  const events: TraceEvent[] = [];
  await telemetry.configure({
    traceProcessors: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  try {
    await withScriptedResponses([[text('custom-only')]], async (peer) => {
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider: peer.provider,
      });
      await telemetry.withTrace({ name: 'custom.only.workflow' }, async () => {
        assert.equal(
          (await agent.run('custom-only')).finalOutput,
          'custom-only',
        );
      });
      peer.assertExhausted();
    });
    await flush();
    assert(
      events.some(
        (event) =>
          event.name === 'custom.only.workflow' && event.lifecycle === 'start',
      ),
    );
    assert(
      events.some(
        (event) =>
          event.name === 'custom.only.workflow' && event.lifecycle === 'end',
      ),
    );
    assert(
      events.some(
        (event) =>
          event.attributes &&
          typeof event.attributes === 'object' &&
          !('sdk.span.kind' in event.attributes),
      ),
      'Custom-only processor received no native runtime spans',
    );
    const worker = new Worker(
      new URL('./tracing-owner-worker.mjs', import.meta.url),
    );
    const closed = once(worker, 'exit');
    const [result] = await once(worker, 'message');
    assert.deepEqual(result, { ownerRejected: true, emitted: true });
    assert.equal((await closed)[0], 0);
    await telemetry.withTrace({ name: 'owner.after_worker' }, () => {});
    await flush();
    assert(events.some((event) => event.name === 'worker.emitted_scope'));
    assert(events.some((event) => event.name === 'owner.after_worker'));
  } finally {
    await telemetry.shutdown();
  }
}

async function restoreCase(batches: unknown[]) {
  const lookup = manualTool({
    name: 'lookup',
    description: 'Return a synthetic record.',
    parameters: z.object({ key: z.string() }),
    result: z.object({ value: z.string() }),
  });
  await withScriptedResponses(
    [
      [toolCall('lookup', { key: 'synthetic' }, { callId: 'manual-lookup' })],
      [text('restored-answer')],
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Use lookup then answer.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [lookup],
      });
      let state: import('../../../src').SessionState | undefined;
      let originalTrace = '';
      let originalHandle = '';
      let restoredTrace = '';
      let callbackTrace = '';
      await telemetry.withTrace(
        { name: 'workflow.before_restore' },
        async (workflow) => {
          originalTrace = workflow.context.traceId;
          originalHandle = workflow.handle;
          await using session = await agent.session();
          const turn = await session.submit('lookup');
          const result = await turn.wait({ until: 'request' });
          assert('requests' in result && result.requests.length === 1);
          state = await session.suspend();
        },
      );
      const serialized = JSON.stringify(state);
      assert(!serialized.includes('"strict_executor_writes":'));
      assert(!/"executors":\[(?!\])/.test(serialized));
      assert(!serialized.includes(originalHandle));
      assert(
        matchingPaths(state, originalTrace).every((path) =>
          /^\$\.history\.\d+\.payload\.trace_id$/.test(path),
        ),
      );
      assert(!serialized.includes('tracing_context'));
      await telemetry.withTrace(
        { name: 'workflow.after_restore' },
        async (workflow) => {
          restoredTrace = workflow.context.traceId;
          const result = await agent.run(null, {
            state,
            onInteraction(action) {
              callbackTrace = telemetry.getCurrentSpan()?.context.traceId ?? '';
              const request = lookup.match(action);
              assert(request);
              return request.reply({ value: 'record' });
            },
          });
          assert.equal(result.finalOutput, 'restored-answer');
        },
      );
      assert.notEqual(originalTrace, restoredTrace);
      assert.equal(callbackTrace, restoredTrace);
      peer.assertExhausted();
      await flush();
      const spans = decoded(batches);
      const restored = spans.find(
        (span) => span.name === 'workflow.after_restore',
      );
      assert(restored);
      assert(
        spans.some(
          (span) =>
            !attrs(span)['sdk.span.kind'] &&
            identity(span.traceId) === restoredTrace &&
            descendant(span, restored, spans),
        ),
        'Restored model work lost its new admitting trace',
      );
    },
  );
}

async function credentialsCase() {
  const options: { traces: Exporter } = JSON.parse(
    await readFile(process.argv[3], 'utf8'),
  );
  await telemetry.configure(options);
  const traceIds: string[] = [];
  for (const value of ['one', 'two']) {
    const credential = new telemetry.TraceExportCredentials({
      headers: { aUtHoRiZaTiOn: `Bearer synthetic-${value}` },
    });
    try {
      await telemetry.withTrace(
        { name: `credential.${value}`, exportCredential: credential },
        async (span) => {
          traceIds.push(span.context.traceId);
          const server = new ModelServer([[message(value)]]);
          const config = await server.config();
          const provider = new NativeProvider({
            baseUrl: (config['model_providers.fixture'] as { base_url: string })
              .base_url,
            apiKey: 'model-only-synthetic',
          });
          try {
            const agent = new Agent({
              instructions: 'Answer.',
              model: 'gpt-5',
              provider,
            });
            const result = await agent.run(value, { returnState: true });
            assert.equal(result.finalOutput, value);
            const saved = JSON.stringify(result.state);
            assert(
              !saved.includes('synthetic-one') &&
                !saved.includes('synthetic-two') &&
                !saved.includes('credential_ref'),
            );
            assert.equal(
              server.requestHeaders[0]?.authorization,
              'Bearer model-only-synthetic',
            );
            server.assertExhausted();
          } finally {
            await provider.close();
            await ModelServer.closeAll();
          }
        },
      );
    } finally {
      credential.close();
    }
  }
  await flush();
  await telemetry.shutdown();
  console.log(JSON.stringify({ traceIds }));
}
async function main() {
  const mode = process.argv[2];
  if (mode === 'custom-only') {
    await customOnlyCase();
    console.log('PASS custom-only');
    return;
  }
  if (mode === 'credentials') {
    await credentialsCase();
    return;
  }
  if (mode === 'no-export') {
    await telemetry.configure();
    for (const value of [
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
    ]) {
      await assert.rejects(
        telemetry.forceFlush({ timeoutMs: value as number }),
        TypeError,
      );
      await assert.rejects(
        telemetry.shutdown({ timeoutMs: value as number }),
        TypeError,
      );
    }
    await withScriptedResponses(
      [[text('admission-still-open')]],
      async (peer) => {
        const agent = new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider: peer.provider,
        });
        assert.equal(
          (await agent.run('after invalid shutdown')).finalOutput,
          'admission-still-open',
        );
        peer.assertExhausted();
      },
    );
    await telemetry.withTrace(
      { name: 'nonrecording.workflow' },
      async (trace) => {
        assert.match(trace.context.traceId, /^[0-9a-f]{32}$/);
        assert.notEqual(trace.context.traceId, '0'.repeat(32));
        await telemetry.withSpan({ name: 'nonrecording.custom' }, (span) => {
          assert.equal(span.context.traceId, trace.context.traceId);
        });
      },
    );
    await assert.rejects(telemetry.addTraceProcessor({ onEvent: () => {} }));
    await telemetry.shutdown();
    console.log('PASS no-export');
    return;
  }
  const collector = await receiver();
  try {
    await telemetry.configure({
      traces: {
        kind: 'otlp-http',
        endpoint: collector.endpoint,
        protocol: 'json',
      },
      logUserPrompt: true,
      logAgentResponses: true,
      toolResultMaxBytes: 4096,
    });
    try {
      if (mode === 'context') await contextCase(collector.batches);
      else if (mode === 'control') await controlCase(collector.batches);
      else if (mode === 'processors') await processorCase(collector.batches);
      else if (mode === 'restore') await restoreCase(collector.batches);
      else if (mode === 'retained')
        await retainedCase(collector.batches, collector.authorization);
      else throw new Error('Unknown qualification mode');
    } finally {
      await telemetry.shutdown({ timeoutMs: 5_000 });
    }
    console.log(`PASS ${mode}`);
  } finally {
    await collector.close();
    await ModelServer.closeAll();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
