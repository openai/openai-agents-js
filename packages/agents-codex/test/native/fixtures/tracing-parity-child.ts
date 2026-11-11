import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../../fixtures/native-event-batches';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  TraceContext,
  telemetry,
  tool,
  manualTool,
} from '../../../src';
import { text, toolCall, withScriptedResponses } from '../../../src/testing';
import { call, message, ModelServer } from './model-server';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../../src/runtime/binding';
import type { TraceEvent, Exporter } from '../../../src/runtime/telemetry';
import { startPublicExecutor } from './public-executor';

type LogRecord = {
  attributes?: { key: string; value: { stringValue?: string } }[];
};
type LogBatch = {
  resourceLogs?: { scopeLogs?: { logRecords?: LogRecord[] }[] }[];
};

type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  flags?: number;
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
  const lateGate = Promise.withResolvers<void>();
  let lateTask: Promise<void>;
  await telemetry.withTrace({ name: 'arbitrary.parent' }, (parent) => {
    lateTask = (async () => {
      await lateGate.promise;
      await telemetry.withSpan({ name: 'arbitrary.child' }, (child) => {
        assert.equal(child.context.parentSpanId, parent.context.spanId);
        assert.equal(telemetry.getCurrentTrace(), parent);
      });
    })();
  });
  lateGate.resolve();
  await lateTask!;
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
            const explicit = await telemetry.startSpan({
              parent: telemetry.getCurrentTrace()!,
            });
            assert.equal(
              explicit.context.parentSpanId,
              workflowHandle?.context.spanId,
            );
            explicit.close();
            return telemetry.withSpan({ name: 'application.tool_work' }, () => {
              assert.equal(telemetry.getCurrentTrace(), workflowHandle);
              return 'tool-result';
            });
          },
        }),
      ],
    });
    await assert.rejects(
      agent.session({ tracing: { name: '' } }),
      /Tracing span name/,
    );
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
    await session.close();
    const record = (
      session as unknown as {
        lastRun: { tracing?: unknown; issuedTracing?: unknown };
      }
    ).lastRun;
    assert.equal(record.tracing, undefined);
    assert.equal(record.issuedTracing, undefined);
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

  const cases = [
    { label: 'disabled', disabled: true, includeSensitiveData: true },
    { label: 'metadata-only', disabled: false, includeSensitiveData: false },
    { label: 'sensitive', disabled: false, includeSensitiveData: true },
  ];

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let rootId: string;
  let childModelId: string | undefined;
  let childRequests = 0;
  let nextCall: JsonObject | undefined = call(
    'spawn_agent',
    { task_name: 'child', message: 'Complete the assigned work.' },
    { namespace: 'collaboration', callId: 'spawn-queue-receiver' },
  );
  const respond = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    if (id === rootId) {
      const selected = nextCall;
      nextCall = undefined;
      return selected ? [selected] : [message('root finished')];
    }
    assert.equal(++childRequests, 1, 'Unexpected child model request');
    childModelId = id;
    // Hold the first child response through every sender flush.
    entered.resolve();
    await release.promise;
    return [message('first child final')];
  };
  const executor = await startPublicExecutor();
  try {
    // Spawn and each send take two root requests. The child uses one request.
    const server = new ModelServer(
      Array.from({ length: 3 + 2 * cases.length }, () => respond),
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-queue-tracing',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents()],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    try {
      rootId = session.id;
      await (await session.submit('Start the child.')).wait();
      const children = await Array.fromAsync(session.subagents());
      assert.equal(children.length, 1, 'Expected one real queue receiver');
      const child = children[0]!;
      await Promise.race([
        entered.promise,
        delay(10_000, undefined, { ref: false }).then(() => {
          throw new Error(
            'Timed out waiting for the initial child model request',
          );
        }),
      ]);
      assert.equal(child.id, childModelId, 'Queue receiver model thread ID');
      await flush();

      for (const { label, ...policy } of cases) {
        const callId = `queue-only-${label}`;
        const marker = `QUEUE_ONLY_CANARY_${label}`;
        nextCall = call(
          'send_message',
          { target: child.id, message: marker },
          { namespace: 'collaboration', callId },
        );
        const start = batches.length;
        const turn = await session.submit('Queue more child work.', {
          tracing: { parent: null, ...policy },
        });
        assert.equal(
          (await turn.wait()).finalOutput,
          'root finished',
          `${label} sender turn output`,
        );
        const postTool = server.requests.at(-1)?.input as
          JsonObject[] | undefined;
        const output = postTool?.find(
          (item) =>
            item.type === 'function_call_output' && item.call_id === callId,
        );
        assert.equal(
          output?.output,
          '',
          `${label} send_message success output`,
        );
        await flush();
        assert.equal(childRequests, 1, `${label} child model request count`);

        const senderLogs = (batches.slice(start) as LogBatch[])
          .flatMap((batch) => batch.resourceLogs ?? [])
          .flatMap((resource) => resource.scopeLogs ?? [])
          .flatMap((scope) => scope.logRecords ?? [])
          .map((record) =>
            Object.fromEntries(
              (record.attributes ?? []).map(({ key, value }) => [
                key,
                value.stringValue,
              ]),
            ),
          )
          .filter(
            (record) =>
              record['event.name'] === 'codex.agent_communication' &&
              record.state === 'send' &&
              record.kind === 'message',
          );
        assert.equal(
          senderLogs.length,
          policy.disabled ? 0 : 1,
          `${label} sender log count`,
        );
        if (policy.disabled) continue;
        const record = senderLogs[0]!;
        assert.equal(
          record.sender_thread_id,
          session.id,
          `${label} sender thread ID`,
        );
        assert.equal(
          record.receiver_thread_id,
          child.id,
          `${label} receiver thread ID`,
        );
        if (policy.includeSensitiveData)
          assert.equal(record.content, marker, `${label} sender log content`);
        else
          assert(
            !Object.hasOwn(record, 'content'),
            `${label} sender log must omit content`,
          );
      }
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  } finally {
    await executor.close();
  }
}
async function processorCase(batches: unknown[]) {
  const first: TraceEvent[] = [];
  const second: TraceEvent[] = [];
  await telemetry.addTraceProcessor({
    onEvent: async (event) => {
      assert(Object.isFrozen(event));
      first.push(event);
      await telemetry.withSpan(
        { name: 'processor.must_not_export', parent: null, disabled: false },
        (span) => assert.equal(span.context.disabled, true),
      );
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
  assert(!first.some((event) => event.name === 'processor.must_not_export'));
  assert(
    !decoded(batches).some((span) => span.name === 'processor.must_not_export'),
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
async function mailboxReceiverCase(
  batches: unknown[],
  wake: 'scoped' | 'bare',
  origin: 'disabled' | 'metadata-only' | 'permissive',
) {
  const executor = await startPublicExecutor();
  const native = await binding();
  const submit = native.NativeThread.prototype._submit;
  const bareHeaders = {
    traceparent: '00-83838383838383838383838383838383-8484848484848484-01',
    tracestate: 'test=bare',
  };
  const bareParent = new TraceContext(bareHeaders);
  let bareAdmissions = 0;
  native.NativeThread.prototype._submit = function (raw: string) {
    const request = JSON.parse(raw);
    if (request.trace?.traceparent === bareHeaders.traceparent) {
      bareAdmissions++;
      assert.equal(Object.hasOwn(request, 'tracing_context'), false);
    }
    return submit.call(this, raw);
  };
  const policy = {
    disabled: origin === 'disabled',
    includeSensitiveData: origin === 'permissive',
  };
  try {
    const start = batches.length;
    let childId: string | undefined;
    let replacementId: string | undefined;
    let wakeRequest: number | undefined;
    let childRequests = 0;
    let replacementRequests = 0;
    const initial: JsonObject = {
      ...message('initial receiver canary'),
      phase: 'final_answer',
    };
    const resumed: JsonObject = {
      ...message('follow-up receiver canary'),
      phase: 'final_answer',
    };
    const spawn = (name: string) =>
      call(
        'spawn_agent',
        {
          task_name: name,
          fork_turns: 'none',
          message: 'Complete the assigned work.',
        },
        { namespace: 'collaboration', callId: 'spawn-' + name },
      );
    let nextRootCall: JsonObject | undefined = spawn('receiver');
    const respond = (request: JsonObject): JsonObject[] => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']!).thread_id,
      );
      if (id === rootId) {
        const selected = nextRootCall;
        nextRootCall = undefined;
        return selected ? [selected] : [message('root done')];
      }
      childId ??= id;
      if (id !== childId) {
        replacementId ??= id;
        assert.equal(id, replacementId);
        assert.equal(++replacementRequests, 1);
        return [message('replacement done')];
      }
      if (++childRequests === 1) return [initial];
      assert.equal(childRequests, 2);
      wakeRequest = server.requests.length - 1;
      return [resumed];
    };
    const server = new ModelServer(Array.from({ length: 9 }, () => respond));
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-mailbox-receiver',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents({ maxChildren: 1 })],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    const rootId = session.id;
    const find = async (id: string | undefined) =>
      (await Array.fromAsync(session.subagents())).find(
        (child) => child.id === id,
      );
    const waitForChild = async (
      id: () => string | undefined,
      previousTurn?: string,
    ) => {
      const until = performance.now() + 5_000;
      do {
        const child = await find(id());
        if (child?.isLive && child.turn && child.turn.turnId !== previousTurn)
          return child.turn;
        await delay(25);
      } while (performance.now() < until);
      throw new Error('Missing live receiver fixture turn');
    };
    const firstRoot = await session.submit('Start the receiver.', {
      tracing: { parent: null, ...policy },
    });
    assert.equal((await firstRoot.wait()).finalOutput, 'root done');
    const first = await waitForChild(() => childId);
    assert.equal((await first.wait()).finalOutput, 'initial receiver canary');
    assert.equal(
      (await telemetry.forceFlush({ timeoutMs: 5_000 })).status,
      'success',
    );

    nextRootCall = spawn('replacement');
    const replacementRoot = await session.submit('Start the replacement.');
    assert.equal((await replacementRoot.wait()).finalOutput, 'root done');
    const replacement = await waitForChild(() => replacementId);
    assert.equal((await replacement.wait()).finalOutput, 'replacement done');
    const evicted = await find(childId);
    assert.ok(evicted && !evicted.isLive && evicted.turn === null);
    assert.ok(childId && first.instanceId);
    nextRootCall = call(
      'followup_task',
      {
        target: childId,
        message: 'Complete the follow-up request.',
      },
      { namespace: 'collaboration', callId: 'wake-receiver' },
    );
    const root = await session.submit(
      'Wake the receiver.',
      wake === 'bare'
        ? { parentTrace: bareParent }
        : {
            tracing: {
              parent: null,
              disabled: false,
              includeSensitiveData: true,
            },
          },
    );
    assert.equal((await root.wait()).finalOutput, 'root done');
    const reloaded = await waitForChild(() => childId, first.turnId);
    assert.ok(reloaded.instanceId);
    assert.notEqual(reloaded.instanceId, first.instanceId);
    assert.equal(
      (await reloaded.wait()).finalOutput,
      'follow-up receiver canary',
    );
    assert.equal(childRequests, 2);
    assert.equal(replacementRequests, 1);
    server.assertExhausted();
    assert.equal(
      (await telemetry.forceFlush({ timeoutMs: 5_000 })).status,
      'success',
    );
    if (wake === 'bare') {
      const dispatch = decoded(batches.slice(start)).filter(
        (span) =>
          span.name.startsWith('op.dispatch.') &&
          attrs(span)['submission.id'] === root.turnId,
      );
      assert.equal(dispatch.length, 1);
      assert.equal(
        identity(dispatch[0]!.traceId),
        bareHeaders.traceparent.slice(3, 35),
      );
      assert.equal(
        identity(dispatch[0]!.parentSpanId!),
        bareHeaders.traceparent.slice(36, 52),
      );
      assert.notEqual(wakeRequest, undefined);
      const headers = server.requestHeaders[wakeRequest!]!;
      assert.equal(
        String(headers.traceparent).slice(3, 35),
        bareHeaders.traceparent.slice(3, 35),
      );
      assert.equal(headers.tracestate, bareHeaders.tracestate);
    }
    const records = (batches.slice(start) as LogBatch[])
      .flatMap((batch) => batch.resourceLogs ?? [])
      .flatMap((resource) => resource.scopeLogs ?? [])
      .flatMap((scope) => scope.logRecords ?? [])
      .map(({ attributes }) =>
        Object.fromEntries(
          (attributes ?? []).map(({ key, value }) => [key, value.stringValue]),
        ),
      )
      .filter((record) => record['event.name'] === 'codex.agent_response');
    const responses = [initial, resumed].map((item, index) => {
      const matching = records.filter(
        (record) => record['item.id'] === item.id,
      );
      for (const record of matching) {
        assert.equal(record['agent.type'], 'subagent');
        assert.equal(
          record['turn.id'],
          (index === 0 ? first : reloaded).turnId,
        );
        assert.equal(
          record.response,
          index === 0 ? 'initial receiver canary' : 'follow-up receiver canary',
        );
      }
      return matching.length;
    });
    assert.equal(bareAdmissions, wake === 'bare' ? 1 : 0);
    assert.deepEqual(
      responses,
      policy.includeSensitiveData ? [1, 1] : [0, 0],
      `${wake} wake after ${origin} child creation`,
    );
  } finally {
    native.NativeThread.prototype._submit = submit;
    await executor.close();
  }
}

async function retainedCase(
  batches: unknown[],
  authorization: (string | undefined)[],
) {
  const native = await binding();
  const nextEvent = native.NativeThread.prototype._next_session_events;
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
    native.NativeThread.prototype._next_session_events = async function (
      this: NativeThread,
    ) {
      const raw = await nextEvent.call(this);
      const event = JSON.parse(firstNativeBatchWire(raw));
      if (
        !originalId &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg.type)
      ) {
        originalId = event.id;
        event.sdk_unsampled_steering = true;
        return replaceSingletonNativeBatchEvent(raw, event);
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
      native.NativeThread.prototype._next_session_events = nextEvent;
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

async function manualReplyContextStorageCase() {
  const admission = new AsyncLocalStorage<telemetry.TraceSpan | undefined>();
  const caller = new AsyncLocalStorage<telemetry.TraceSpan | undefined>();
  const select = (storage: typeof admission) =>
    telemetry.setTraceContextStorage({
      getStore: () => storage.getStore(),
      run: (span, callback) => storage.run(span, callback),
    });
  let requestSpan: telemetry.TraceSpan | undefined;
  let requestStorageSpan: telemetry.TraceSpan | undefined;
  const validations: {
    span: telemetry.TraceSpan | undefined;
    admissionSpan: telemetry.TraceSpan | undefined;
  }[] = [];
  const lookup = manualTool({
    name: 'lookup',
    description: 'Return a synthetic record.',
    parameters: z.object({}).superRefine(() => {
      requestSpan = telemetry.getCurrentSpan();
      requestStorageSpan = admission.getStore();
    }),
    result: z.string().superRefine((value, context) => {
      validations.push({
        span: telemetry.getCurrentSpan(),
        admissionSpan: admission.getStore(),
      });
      if (value === 'invalid')
        context.addIssue({ code: 'custom', message: 'invalid' });
    }),
  });
  await telemetry.configure();
  try {
    await withScriptedResponses(
      [[toolCall('lookup', {}, { callId: 'manual-lookup' })], [text('done')]],
      async (peer) => {
        const agent = new Agent({
          instructions: 'Use lookup then answer.',
          model: 'gpt-5',
          provider: peer.provider,
          tools: [lookup],
        });
        select(admission);
        await using session = await agent.session();
        const { turn, request } = await telemetry.withTrace(
          { name: 'storage.request' },
          async (trace) => {
            const turn = await session.submit('lookup');
            const result = await turn.wait({ until: 'manual_tool' });
            assert('requests' in result && result.requests.length === 1);
            const request = lookup.match(result.requests[0]);
            assert(request);
            assert.equal(requestSpan?.context.traceId, trace.context.traceId);
            assert.equal(requestStorageSpan, requestSpan);
            return { turn, request };
          },
        );
        select(caller);
        await telemetry.withTrace({ name: 'storage.reply' }, async (trace) => {
          assert.equal(caller.getStore(), trace);
          await assert.rejects(
            session.respond(request.reply('invalid')),
            /Manual tool result failed validation/,
          );
          assert.equal(peer.requests.length, 1);
          assert.equal(caller.getStore(), trace);
          const reply = request.reply('valid');
          await session.respond(reply);
          await assert.rejects(
            session.respond(reply),
            /Manual reply must identify one pending call/,
          );
          assert.equal(telemetry.getCurrentSpan(), trace);
          assert.equal(caller.getStore(), trace);
        });
        assert.equal((await turn.wait()).finalOutput, 'done');
        peer.assertExhausted();
        assert.equal(validations.length, 2);
        for (const { span, admissionSpan } of validations) {
          assert(span);
          assert.equal(span.kind, 'validation');
          assert.equal(span.context.traceId, requestSpan?.context.traceId);
          assert.equal(span.context.parentSpanId, requestSpan?.context.spanId);
          assert(
            admissionSpan === span,
            'Saved request adapter did not own validation',
          );
        }
      },
    );
  } finally {
    telemetry.setTraceContextStorage();
    await telemetry.shutdown();
  }
}

async function restoreCase(batches: unknown[]) {
  let directValidationTrace: string | undefined;
  const lookup = manualTool({
    name: 'lookup',
    description: 'Return a synthetic record.',
    parameters: z.object({ key: z.string() }),
    result: z.object({ value: z.string() }).superRefine((value, context) => {
      if (value.value === 'invalid') {
        assert.equal(telemetry.getCurrentSpan()?.kind, 'validation');
        directValidationTrace = telemetry.getCurrentSpan()?.context.traceId;
        context.addIssue({ code: 'custom', message: 'invalid' });
      }
    }),
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
          const result = await turn.wait({ until: 'manual_tool' });
          assert('requests' in result && result.requests.length === 1);
          const request = lookup.match(result.requests[0]);
          assert(request);
          await telemetry.withTrace(
            { name: 'unrelated.direct.reply', parent: null },
            () =>
              assert.rejects(
                session.respond(request.reply({ value: 'invalid' })),
                /Manual tool result failed validation/,
              ),
          );
          assert.equal(directValidationTrace, originalTrace);

          state = await session.suspend();
        },
      );
      const serialized = JSON.stringify(state);
      assert(!serialized.includes('"strict_executor_writes":'));
      assert(!/"executors":\[(?!\])/.test(serialized));
      // Whole handles only: no substring matches inside longer opaque IDs.
      const handleToken = originalHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert(
        !new RegExp(`(?<![A-Za-z0-9_-])${handleToken}(?![A-Za-z0-9_-])`).test(
          serialized,
        ),
      );
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
              if (action.type !== 'action_requested')
                throw new Error('Unexpected native request');

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

async function parentPolicyCase(
  collector: Awaited<ReturnType<typeof receiver>>,
) {
  const victimCredential = new telemetry.TraceExportCredentials({
    headers: { authorization: 'Bearer synthetic-victim-parent' },
  });
  const callerCredential = new telemetry.TraceExportCredentials({
    headers: { authorization: 'Bearer synthetic-caller-parent' },
  });
  const victim = await telemetry.startTrace({
    name: 'parent-policy.victim',
    includeSensitiveData: true,
    exportCredential: victimCredential,
  });
  const server = new ModelServer([
    [message('unscoped')],
    [message('default')],
    [message('caller')],
  ]);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'model-only-synthetic',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Answer.',

    provider,
  });
  const carrier = (traceId: string, spanId: string) =>
    new TraceContext({ traceparent: `00-${traceId}-${spanId}-01` });
  const submit = async (label: string, parentTrace?: TraceContext) => {
    const session = await agent.session({ parentTrace });
    try {
      const turn = await session.submit(label);
      assert.equal((await turn.wait()).finalOutput, label);
      return turn.turnId;
    } finally {
      await session.close();
    }
  };
  try {
    assert.equal(telemetry.getCurrentSpan(), undefined);
    // Keep the victim live, but admit this Session outside its workflow.
    const unscoped = await submit(
      'unscoped',
      carrier(victim.context.traceId, victim.context.spanId),
    );
    const ordinary = await submit(
      'default',
      carrier('1'.repeat(32), '2'.repeat(16)),
    );
    const caller = await telemetry.withTrace(
      {
        name: 'parent-policy.caller',
        includeSensitiveData: false,
        exportCredential: callerCredential,
      },
      async (span) => {
        assert.equal(span.context.includeSensitiveData, false);
        return { turn: await submit('caller'), context: span.context };
      },
    );
    server.assertExhausted();
    await flush();
    const allSpans = decoded(collector.batches);
    const dispatch = (turn: string) => {
      const matches = collector.batches.flatMap((batch, index) =>
        decoded([batch])
          .filter(
            (span) =>
              span.name.startsWith('op.dispatch.') &&
              attrs(span)['submission.id'] === turn,
          )
          .map((span) => ({
            span,
            authorization: collector.authorization[index],
          })),
      );
      assert.equal(matches.length, 1);
      return matches[0]!;
    };
    const victimChild = dispatch(unscoped);
    const defaultChild = dispatch(ordinary);
    const callerChild = dispatch(caller.turn);
    // Public ancestry and sampling flags survive independently of local policy.
    assert.equal(identity(victimChild.span.traceId), victim.context.traceId);
    assert.equal(
      identity(victimChild.span.parentSpanId!),
      victim.context.spanId,
    );
    assert.equal(identity(defaultChild.span.traceId), '1'.repeat(32));
    assert.equal(identity(defaultChild.span.parentSpanId!), '2'.repeat(16));
    for (const { span } of [victimChild, defaultChild, callerChild])
      assert.equal((span.flags ?? 0) & 1, 1);
    assert.equal(defaultChild.authorization, 'Bearer synthetic-default');
    assert.equal(callerChild.authorization, 'Bearer synthetic-caller-parent');
    const callerSpan = allSpans.find(
      (span) => identity(span.spanId) === caller.context.spanId,
    );
    assert(callerSpan);
    assert(descendant(callerChild.span, callerSpan, allSpans));
    assert.equal(
      victimChild.authorization,
      'Bearer synthetic-default',
      'A public parent carrier restored the live victim export credential',
    );
  } finally {
    victim.close();
    victimCredential.close();
    callerCredential.close();
    await provider.close();
  }
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
async function preparedRequestCase() {
  const server = new ModelServer([[message('traced answer')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-editor-trace',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
  });
  let callbacks = 0;
  await telemetry.withTrace(
    { name: 'prepared-request-workflow' },
    async (workflow) => {
      const result = await agent.run('answer', {
        prepareRequest() {
          callbacks++;
          assert.equal(telemetry.getCurrentTrace(), workflow);
          const callback = telemetry.getCurrentSpan();
          assert.equal(callback?.context.traceId, workflow.context.traceId);
          assert.notEqual(callback?.context.spanId, workflow.context.spanId);
          return undefined;
        },
      });
      assert.equal(result.finalOutput, 'traced answer');
    },
  );
  assert.equal(callbacks, 1);
  assert.equal(server.requests.length, 1);
}

async function sessionContextStorageCase() {
  const storages = Array.from(
    { length: 2 },
    () => new AsyncLocalStorage<telemetry.TraceSpan | undefined>(),
  );
  const adapters = storages.map((storage): telemetry.TraceContextStorage => ({
    getStore: () => storage.getStore(),
    run: (span, callback) => storage.run(span, callback),
  }));
  const release = Promise.withResolvers<void>();
  const pending: Promise<void>[] = [];
  try {
    for (const mode of ['default', 'before-open', 'late'] as const) {
      const entered = Promise.withResolvers<void>();
      const index =
        mode === 'default' ? undefined : mode === 'before-open' ? 0 : 1;
      const selected = index === undefined ? undefined : adapters[index];
      const storage = index === undefined ? undefined : storages[index];
      const rows: {
        phase: string;
        span: telemetry.TraceSpan | undefined;
        trace: telemetry.TraceSpan | undefined;
        stores: (telemetry.TraceSpan | undefined)[];
      }[] = [];
      let root: telemetry.TraceSpan;
      const record = (phase: string) =>
        rows.push({
          phase,
          span: telemetry.getCurrentSpan(),
          trace: telemetry.getCurrentTrace(),
          stores: storages.map((store) => store.getStore()),
        });
      const run = withScriptedResponses(
        [
          [toolCall('lookup', {}, { callId: `storage-${mode}` })],
          [text('recovered')],
        ],
        async (peer) => {
          // Exercise both directions: the reader and submission use different backends.
          telemetry.setTraceContextStorage(
            mode === 'late' ? undefined : adapters[0],
          );
          const lookup = tool({
            name: 'lookup',
            parameters: z.object({}),
            async execute() {
              record('execute');
              entered.resolve();
              await release.promise;
              record('execute.after-reset');
              await telemetry.withSpan(
                { name: `storage.${mode}.nested` },
                async () => {
                  await Promise.resolve();
                  record('nested');
                },
              );
              record('execute.after-nested');
              throw new Error('synthetic function body failure');
            },
            async errorFunction() {
              await Promise.resolve();
              record('errorFunction');
              return 'synthetic mapped failure';
            },
          });
          await using session = await new Agent({
            instructions: 'Use lookup.',
            model: 'gpt-5',
            provider: peer.provider,
            tools: [lookup],
          }).session();
          telemetry.setTraceContextStorage(selected);
          const result = await telemetry.withTrace(
            { name: `storage.session.${mode}` },
            async (workflow) => {
              root = workflow;
              assert.equal(storage?.getStore(), storage ? root : undefined);
              return (await session.submit('begin')).wait();
            },
          );
          assert.equal(result.finalOutput, 'recovered');
          assert.deepEqual(
            rows.map((row) => row.phase),
            [
              'execute',
              'execute.after-reset',
              'nested',
              'execute.after-nested',
              'errorFunction',
            ],
          );
          for (const row of rows) {
            assert(row.span, `${mode}: ${row.phase} has no current span`);
            assert.equal(row.span.context.traceId, root.context.traceId);
            assert.equal(row.trace, root);
            assert.notEqual(row.span, root);
            for (const [storeIndex, value] of row.stores.entries())
              assert.equal(
                value === (storeIndex === index ? row.span : undefined),
                true,
                `${mode}: ${row.phase} uses the wrong context storage`,
              );
          }
          const callback = rows[0]!.span!;
          assert.equal(
            rows[2]!.span!.context.parentSpanId,
            callback.context.spanId,
          );
          for (const row of [rows[1]!, rows[3]!, rows[4]!])
            assert.equal(row.span, callback);
          peer.assertExhausted();
        },
      );
      pending.push(run);
      await Promise.race([entered.promise, run]);
    }
    telemetry.setTraceContextStorage();
    release.resolve();
    const settled = await Promise.allSettled(pending);
    assert.deepEqual(
      settled.flatMap((result) =>
        result.status === 'rejected' ? [String(result.reason)] : [],
      ),
      [],
    );
    assert(storages.every((storage) => storage.getStore() === undefined));
    assert.equal(telemetry.getCurrentSpan(), undefined);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    telemetry.setTraceContextStorage();
  }
}

async function customContextStorageCase() {
  const storage = new AsyncLocalStorage<telemetry.TraceSpan | undefined>();
  const customScopes: string[] = [];
  const adapter: telemetry.TraceContextStorage = {
    getStore: () => storage.getStore(),
    run(span, callback) {
      if (span) customScopes.push(span.context.spanId);
      return storage.run(span, callback);
    },
  };
  await telemetry.configure();
  const enteredDefault = Promise.withResolvers<void>();
  const enteredCustom = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let defaultRun: Promise<void> | undefined;
  let customRun: Promise<void> | undefined;
  try {
    telemetry.setTraceContextStorage(adapter);
    telemetry.setTraceContextStorage();
    defaultRun = telemetry.withTrace(
      { name: 'storage.default' },
      async (root) => {
        enteredDefault.resolve();
        await release.promise;
        assert.equal(telemetry.getCurrentTrace(), root);
        await telemetry.withSpan({ name: 'storage.default.child' }, (child) => {
          assert.equal(child.context.traceId, root.context.traceId);
          assert.equal(child.context.parentSpanId, root.context.spanId);
          assert.equal(storage.getStore(), undefined);
        });
      },
    );
    await Promise.race([enteredDefault.promise, defaultRun]);
    telemetry.setTraceContextStorage(adapter);
    customRun = telemetry.withTrace(
      { name: 'storage.custom' },
      async (root) => {
        assert.equal(storage.getStore(), root);
        enteredCustom.resolve();
        await release.promise;
        assert.equal(telemetry.getCurrentTrace(), root);
        const failure = new Error('custom span failed');
        await assert.rejects(
          telemetry.withSpan(
            { name: 'storage.custom.child' },
            async (child) => {
              await Promise.resolve();
              assert.equal(storage.getStore(), child);
              assert.equal(telemetry.getCurrentSpan(), child);
              assert.equal(child.context.traceId, root.context.traceId);
              assert.equal(child.context.parentSpanId, root.context.spanId);
              throw failure;
            },
          ),
          (error) => error === failure,
        );
        assert.equal(telemetry.getCurrentSpan(), root);
      },
    );
    await Promise.race([enteredCustom.promise, customRun]);
    telemetry.setTraceContextStorage();
    assert.equal(telemetry.getCurrentSpan(), undefined);
    release.resolve();
    await Promise.all([defaultRun, customRun]);
    assert.equal(customScopes.length, 2);
    assert.equal(storage.getStore(), undefined);
    await telemetry.withTrace({ name: 'storage.reset' }, (root) => {
      assert.equal(telemetry.getCurrentTrace(), root);
      assert.equal(storage.getStore(), undefined);
    });
    await sessionContextStorageCase();
  } finally {
    release.resolve();
    await Promise.allSettled([defaultRun, customRun]);
    await telemetry.shutdown();
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'manual-reply-context-storage') {
    await manualReplyContextStorageCase();
    console.log('PASS manual-reply-context-storage');
    return;
  }
  if (mode === 'custom-context-storage') {
    await customContextStorageCase();
    console.log('PASS custom-context-storage');
    return;
  }
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
  const receiverWake =
    /^mailbox-receiver-(scoped|bare)-(disabled|metadata-only|permissive)$/.exec(
      mode ?? '',
    );
  try {
    await telemetry.configure({
      traces: {
        kind: 'otlp-http',
        endpoint: collector.endpoint,
        protocol: 'json',
        ...(mode === 'parent-policy'
          ? { headers: { authorization: 'Bearer synthetic-default' } }
          : {}),
      },
      ...(mode === 'control' || receiverWake
        ? {
            logs: {
              kind: 'otlp-http',
              endpoint: new URL('/v1/logs', collector.endpoint).href,
              protocol: 'json',
            },
          }
        : {}),
      logUserPrompt: !receiverWake,
      logAgentResponses: true,
      toolResultMaxBytes: 4096,
    });
    try {
      if (mode === 'context') await contextCase(collector.batches);
      else if (mode === 'control') await controlCase(collector.batches);
      else if (receiverWake)
        await mailboxReceiverCase(
          collector.batches,
          receiverWake[1] as 'scoped' | 'bare',
          receiverWake[2] as 'disabled' | 'metadata-only' | 'permissive',
        );
      else if (mode === 'processors') await processorCase(collector.batches);
      else if (mode === 'restore') await restoreCase(collector.batches);
      else if (mode === 'model-preparation') await preparedRequestCase();
      else if (mode === 'parent-policy') await parentPolicyCase(collector);
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
