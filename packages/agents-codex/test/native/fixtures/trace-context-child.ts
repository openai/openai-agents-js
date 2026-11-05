import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  NativeAgents,
  fileSessionStore,
  TraceContext,
  telemetry,
  tool,
  manualTool,
  type SessionState,
} from '../../../src';
import { ModelServer, call, message } from './model-server';

const PARENT = '00-11111111111111111111111111111111-2222222222222222-01';
const OVERRIDE = '00-33333333333333333333333333333333-4444444444444444-01';
const WORKER = '00-55555555555555555555555555555555-6666666666666666-01';
const STATE =
  'tenant@abcdefghijklm=' + 'x'.repeat(256) + ',other=' + 'y'.repeat(256);
const parent = (traceparent: string) =>
  new TraceContext({ traceparent, tracestate: STATE });
const final = (text: string) => ({ ...message(text), phase: 'final_answer' });

async function providerFor(server: ModelServer) {
  const config = await server.config();
  class FixtureProvider extends NativeProvider {
    override _acquire() {
      const lease = super._acquire();
      Object.assign(lease.config, config);
      return lease;
    }
  }
  return new FixtureProvider({ apiKey: 'fixture' });
}

async function compact() {
  const server = new ModelServer([
    [final('before')],
    [final('Remember the synthetic label.')],
    [final('Remember the synthetic label after command.')],
    [final('after')],
  ]);
  const agent = new Agent({
    instructions: 'Remember the synthetic label.',
    model: 'gpt-5',
    provider: await providerFor(server),
  });
  const session = await agent.session({ parentTrace: parent(PARENT) });
  try {
    const first = await session.submit('before', {
      parentTrace: parent(OVERRIDE),
    });
    assert.equal((await first.wait()).finalOutput, 'before');
    await session.compact();
    const command = await session.executeCommand('/compact');
    if (command.command !== 'compact')
      throw new Error('Missing compact receipt');
    await command.turn.wait();
    const after = await session.submit('after');
    assert.equal((await after.wait()).finalOutput, 'after');
    const turns = [];
    for await (const turn of session.turns()) turns.push(turn);
    assert.equal(turns.length, 4);
    server.assertExhausted();
    return {
      first: first.turnId,
      compact: turns[1]!.id,
      commandCompact: turns[2]!.id,
      after: after.turnId,
    };
  } finally {
    await session.close();
  }
}

async function review() {
  const reviewOutput = {
    findings: [],
    overall_correctness: 'patch is correct',
    overall_explanation: 'Synthetic review found no issues.',
    overall_confidence_score: 0.9,
  };
  const server = new ModelServer([
    [final('before')],
    [message(JSON.stringify(reviewOutput))],
    [final('after')],
  ]);
  const agent = new Agent({
    instructions: 'Review the synthetic change.',
    model: 'gpt-5',
    provider: await providerFor(server),
  });
  const session = await agent.session({ parentTrace: parent(PARENT) });
  try {
    const first = await session.submit('before', {
      parentTrace: parent(OVERRIDE),
    });
    assert.equal((await first.wait()).finalOutput, 'before');
    const command = await session.executeCommand(
      '/review Inspect the synthetic change.',
    );
    if (command.command !== 'review') throw new Error('Missing review receipt');
    assert.deepEqual((await command.turn.wait()).finalOutput, reviewOutput);
    const after = await session.submit('after');
    assert.equal((await after.wait()).finalOutput, 'after');
    server.assertExhausted();
    return {
      first: first.turnId,
      review: command.turn.turnId,
      after: after.turnId,
    };
  } finally {
    await session.close();
  }
}

async function definedFlags(flags: string) {
  let callback: ReturnType<TraceContext['toHeaders']> | undefined;
  const server = new ModelServer([
    [call('observe', {}, { callId: 'flags-call' })],
    [final('done')],
  ]);
  const agent = new Agent({
    instructions: 'Call observe.',
    model: 'gpt-5',
    provider: await providerFor(server),
    tools: [
      tool({
        name: 'observe',
        parameters: z.object({}),
        execute: (_args, context) => {
          assert(context.traceContext);
          callback = context.traceContext.toHeaders();
          return 'accepted';
        },
      }),
    ],
  });
  const result = await agent.run('start', {
    parentTrace: parent(PARENT.slice(0, -2) + flags),
  });
  assert.equal(result.finalOutput, 'done');
  assert(callback);
  server.assertExhausted();
  return { callback, turn: result.turn.turnId };
}

async function storeReopen(path: string) {
  const callbacks: ReturnType<TraceContext['toHeaders']>[] = [];
  const server = new ModelServer(
    Array.from({ length: 3 }, (_, index) => [
      [call('observe', {}, { callId: `store-${index}` })],
      [final('stored')],
    ]).flat(),
  );
  const agent = new Agent({
    instructions: 'Call observe.',
    model: 'gpt-5',
    provider: await providerFor(server),
    tools: [
      tool({
        name: 'observe',
        parameters: z.object({}),
        execute: (_args, context) => {
          assert(context.traceContext);
          callbacks.push(context.traceContext.toHeaders());
          return 'accepted';
        },
      }),
    ],
  });
  const storage = fileSessionStore(path + '.store');
  let id: string | undefined;
  const turns: string[] = [];
  for (const carrier of [
    PARENT.slice(0, -2) + '03',
    WORKER.slice(0, -2) + '03',
    undefined,
  ]) {
    const session = await agent.session({
      storage,
      resume: id,
      parentTrace: carrier ? parent(carrier) : undefined,
    });
    try {
      id ??= session.id;
      assert.equal(session.id, id);
      const turn = await session.submit('observe after opening');
      assert.equal((await turn.wait()).finalOutput, 'stored');
      turns.push(turn.turnId!);
    } finally {
      await session.close();
    }
  }
  assert.equal(callbacks.length, 3);
  server.assertExhausted();
  return { id, turns, callbacks };
}

async function ownedChildren(flags: string) {
  const callbacks: ReturnType<TraceContext['toHeaders']>[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let workflow: Awaited<ReturnType<typeof telemetry.startTrace>>;
  let rootId: string | undefined;
  let roots = 0;
  let children = 0;
  let policyChecks = 0;
  const check = () => {
    const span = telemetry.getCurrentSpan();
    assert(span);
    assert.equal(telemetry.getCurrentTrace(), workflow);
    assert.equal(span.context.disabled, false);
    assert.equal(span.context.includeSensitiveData, false);
    policyChecks++;
  };
  const respond = (request: Record<string, unknown>) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId)
      return ++roots === 1
        ? [
            call(
              'spawn_agent',
              { task_name: 'trace-child', message: 'Call observe.' },
              { namespace: 'collaboration', callId: 'spawn-trace-child' },
            ),
          ]
        : [final('root done')];
    return ++children % 2 === 1
      ? [call('observe', {}, { callId: `child-observe-${children}` })]
      : [final('child done')];
  };
  const server = new ModelServer(Array.from({ length: 6 }, () => respond));
  const agent = new Agent({
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider: await providerFor(server),
    tools: [
      new NativeAgents({
        beforeStep: () => {
          check();
          return undefined;
        },
      }),
      tool({
        name: 'observe',
        parameters: z.object({}),
        execute: async (_args, context) => {
          check();
          assert(context.traceContext);
          callbacks.push(context.traceContext.toHeaders());
          if (callbacks.length === 1) {
            entered.resolve();
            await release.promise;
            check();
          }
          return 'accepted';
        },
      }),
    ],
  });
  let traceId: string | undefined;
  const session = await telemetry.withTrace(
    { name: 'carrier.owner', includeSensitiveData: false },
    async (original) => {
      workflow = original;
      const identity = telemetry.getCurrentSpan()!.context;
      traceId = identity.traceId;
      const opened = await agent.session({
        parentTrace: parent(
          `00-${identity.traceId}-${identity.spanId}-${flags}`,
        ),
        tracing: { includeSensitiveData: false },
      });
      try {
        assert.equal(
          (await (await opened.submit('delegate')).wait()).finalOutput,
          'root done',
        );
        return opened;
      } catch (error) {
        release.resolve();
        await opened.close();
        throw error;
      }
    },
  );
  try {
    await entered.promise;
    const owned = await Array.fromAsync(session.subagents());
    assert.equal(owned.length, 1);
    const child = owned[0]!;
    assert(child.turn);
    release.resolve();
    assert.equal((await child.turn.wait()).finalOutput, 'child done');
    await telemetry.withTrace(
      { name: 'unrelated.caller', includeSensitiveData: true },
      async () => {
        const later = await child.submit('call observe again');
        assert.equal((await later.wait()).finalOutput, 'child done');
      },
    );
    assert.equal(callbacks.length, 2);
    assert(policyChecks >= 4);
    server.assertExhausted();
    return { flags, traceId, callbacks, policyChecks };
  } finally {
    release.resolve();
    await session.close();
  }
}

async function graph() {
  const remoteServer = new ModelServer([[final('remote')]]);
  const remote = new Agent({
    instructions: 'Reply.',
    model: 'gpt-5',
    provider: await providerFor(remoteServer),
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  let callback: ReturnType<TraceContext['toHeaders']> | undefined;
  let remoteTurn: string | undefined;
  const server = new ModelServer([
    [call('outbound', {}, { callId: 'outbound-call' })],
    [final('first')],
    [final('queued')],
    [call('hold', {}, { callId: 'cancel-call' })],
    [final('after')],
  ]);
  const agent = new Agent({
    instructions: 'Use requested tools.',
    model: 'gpt-5',
    provider: await providerFor(server),
    tools: [
      tool({
        name: 'outbound',
        parameters: z.object({}),
        execute: async (_args, context) => {
          assert(context.traceContext);
          callback = context.traceContext.toHeaders();
          assert.equal(callback.tracestate, STATE);
          const result = await remote.run('remote', {
            parentTrace: context.traceContext,
          });
          remoteTurn = result.turn.turnId;
          entered.resolve();
          await release.promise;
          return 'done';
        },
      }),
      tool({
        name: 'hold',
        parameters: z.object({}),
        execute: async (_args, context) => {
          cancelling.resolve();
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          return 'cancelled';
        },
      }),
    ],
  });
  const parallelServer = new ModelServer([[final('parallel')]]);
  const parallelAgent = new Agent({
    instructions: 'Reply.',
    model: 'gpt-5',
    provider: await providerFor(parallelServer),
  });
  const session = await agent.session({ parentTrace: parent(PARENT) });
  try {
    const first = await session.submit('first');
    await entered.promise;
    const headers = { traceparent: OVERRIDE };
    const queued = await session.enqueue('queued', undefined, {
      parentTrace: headers,
    });
    headers.traceparent = WORKER;
    const parallel = await parallelAgent.run('parallel', {
      parentTrace: parent(WORKER),
    });
    await assert.rejects(
      session.submit('steer', { parentTrace: parent(OVERRIDE) }),
      /Cannot reparent/,
    );
    release.resolve();
    assert.equal((await first.wait()).finalOutput, 'first');
    assert.equal((await queued.wait()).finalOutput, 'queued');
    const cancelled = await session.submit('cancel', {
      parentTrace: parent(OVERRIDE),
      ifBusy: 'reject',
    });
    const outcome = cancelled.wait().catch((error: unknown) => error);
    await cancelling.promise;
    await cancelled.cancel();
    await outcome;
    const after = await session.submit('after', { parentTrace: null });
    await after.wait();
    const state = await session.saveState();
    const stored = JSON.stringify(state);
    assert(!stored.includes(PARENT) && !stored.includes(OVERRIDE));
    assert(
      !stored.includes('"traceparent"') && !stored.includes('"tracestate"'),
    );
    const idleServer = new ModelServer([[final('idle restored')]]);
    const idleAgent = new Agent({
      instructions: 'Use requested tools.',
      model: 'gpt-5',
      provider: await providerFor(idleServer),
      tools: agent.tools,
    });
    const restored = await idleAgent.run('restored', {
      state,
      parentTrace: parent(WORKER),
    });
    server.assertExhausted();
    remoteServer.assertExhausted();
    parallelServer.assertExhausted();
    idleServer.assertExhausted();
    return {
      first: first.turnId,
      queued: queued.turnId,
      cancelled: cancelled.turnId,
      after: after.turnId,
      parallel: parallel.turn.turnId,
      remote: remoteTurn,
      idleRestored: restored.turn.turnId,
      callback,
    };
  } finally {
    release.resolve();
    await session.close();
  }
}

async function manual(mode: string, path: string) {
  const decision = manualTool({
    name: 'decision',
    description: 'Get a decision.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer(
    mode === 'suspend'
      ? [[call('decision', {}, { callId: 'manual-call' })]]
      : [[final('resumed')]],
  );
  const agent = new Agent({
    instructions: 'Get a decision.',
    model: 'gpt-5',
    provider: await providerFor(server),
    tools: [decision],
  });
  const state: SessionState | undefined =
    mode === 'resume' ? JSON.parse(await readFile(path, 'utf8')) : undefined;
  const session = await agent.session({
    parentTrace: parent(mode === 'resume' ? WORKER : PARENT),
    state,
  });
  try {
    if (mode === 'suspend') {
      const turn = await session.submit('ask');
      await turn.wait({ until: 'request' });
      const state = await session.suspend();
      assert(!JSON.stringify(state).includes(PARENT));
      assert(!JSON.stringify(state).includes('"traceparent"'));
      await writeFile(path, JSON.stringify(state));
      return { turn: turn.turnId };
    }
    const waiting = await session.wait({ until: 'request' });
    assert('requests' in waiting && waiting.requests.length === 1);
    await session.respond(waiting.requests[0]!.reply('approved'));
    const completed = await session.wait();
    assert.equal(completed.finalOutput, 'resumed');
    return { turn: completed.turn.turnId };
  } finally {
    await session.close();
    server.assertExhausted();
  }
}

async function main() {
  const [mode, collector, path] = process.argv.slice(2);
  await telemetry.configure({
    traces: { kind: 'otlp-http', endpoint: collector!, protocol: 'json' },
  });
  try {
    const result = mode?.startsWith('flags-')
      ? await definedFlags(mode.slice(6))
      : mode === 'store-reopen'
        ? await storeReopen(path!)
        : mode?.startsWith('owned-children-')
          ? await ownedChildren(mode.slice('owned-children-'.length))
          : mode === 'graph'
            ? await graph()
            : mode === 'compact'
              ? await compact()
              : mode === 'review'
                ? await review()
                : await manual(mode!, path!);
    console.log(JSON.stringify(result));
  } finally {
    await telemetry.shutdown();
    await ModelServer.closeAll();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
