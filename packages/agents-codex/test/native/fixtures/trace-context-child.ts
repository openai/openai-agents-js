import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  NativeAgents,
  Environment,
  fileSessionStore,
  TraceContext,
  telemetry,
  tool,
  manualTool,
  type SessionState,
} from '../../../src';
import { ModelServer, call, message } from './model-server';
import { startPublicExecutor } from './public-executor';

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

async function ownedChildren(
  flags?: string,
  steering = false,
  overlap = false,
) {
  const callbackTurns: string[] = [];
  const callbacks: ReturnType<TraceContext['toHeaders']>[] = [];
  let rootCallback: ReturnType<TraceContext['toHeaders']> | undefined;
  const sampled = Promise.withResolvers<void>();
  const releaseSample = Promise.withResolvers<void>();
  const continued = Promise.withResolvers<void>();
  const marker = 'RAW_CHILD_RETAINED_TRACE';
  const sampledMarker: boolean[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let workflow: Awaited<ReturnType<typeof telemetry.startTrace>> | undefined;
  const openingStorage = new AsyncLocalStorage<
    telemetry.TraceSpan | undefined
  >();
  const submissionStorage = new AsyncLocalStorage<
    telemetry.TraceSpan | undefined
  >();
  const successorStorage = new AsyncLocalStorage<
    telemetry.TraceSpan | undefined
  >();
  const successorEntered = Promise.withResolvers<void>();
  const releaseSuccessor = Promise.withResolvers<void>();
  let successorActive = false;
  let retainedStorage:
    | {
        submission: boolean;
        opening: boolean;
        successor: boolean;
        overlapping: boolean;
      }
    | undefined;
  const childStorage: { submission: boolean; opening: boolean }[] = [];
  const recordChildStorage = () => {
    const span = telemetry.getCurrentSpan();
    assert(span);
    childStorage.push({
      submission: submissionStorage.getStore() === span,
      opening: openingStorage.getStore() === span,
    });
  };
  let traceId = flags ? PARENT.slice(3, 35) : undefined;
  let policyChecks = 0;
  const checkPolicy = () => {
    if (flags) return;
    const span = telemetry.getCurrentSpan();
    assert(span);
    assert.equal(telemetry.getCurrentTrace(), workflow);
    assert.equal(span.context.disabled, false);
    assert.equal(span.context.includeSensitiveData, false);
    policyChecks++;
  };
  let rootId: string | undefined;
  let roots = 0;
  let children = 0;
  const respond = async (request: Record<string, unknown>) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId) {
      roots++;
      if (overlap && roots === 4) {
        successorActive = true;
        successorEntered.resolve();
        try {
          await releaseSuccessor.promise;
          return [final('successor done')];
        } finally {
          successorActive = false;
        }
      }
      return roots === 1
        ? [call('root_observe', {}, { callId: 'root-observe' })]
        : roots === 2
          ? [
              call(
                'spawn_agent',
                { task_name: 'trace_child', message: 'Call observe.' },
                { namespace: 'collaboration', callId: 'spawn-trace-child' },
              ),
            ]
          : [final('root done')];
    }
    children++;
    sampledMarker.push(JSON.stringify(request.input).includes(marker));
    if (steering && children === 2) {
      sampled.resolve();
      await releaseSample.promise;
    }
    return children % 2 === 1
      ? [call('observe', {}, { callId: `child-observe-${children}` })]
      : [final('child done')];
  };
  const server = new ModelServer(
    Array.from({ length: overlap ? 8 : 7 }, () => respond),
  );
  const agent = new Agent({
    instructions: 'Delegate.',
    model: 'gpt-5.5',
    provider: await providerFor(server),
    tools: [
      new NativeAgents({
        beforeStep: () => {
          checkPolicy();
          return undefined;
        },
      }),
      tool({
        name: 'root_observe',
        parameters: z.object({}),
        execute: (_args, context) => {
          checkPolicy();
          assert(context.traceContext);
          rootCallback = context.traceContext.toHeaders();
          return 'root observed';
        },
      }),
      tool({
        name: 'observe',
        parameters: z.object({}),
        execute: async (_args, context) => {
          checkPolicy();
          assert(context.traceContext);
          callbacks.push(context.traceContext.toHeaders());
          callbackTurns.push(context.turnId);
          if (callbacks.length === 2) {
            if (overlap) {
              const span = telemetry.getCurrentSpan();
              assert(span);
              retainedStorage = {
                submission: submissionStorage.getStore() === span,
                opening: openingStorage.getStore() === span,
                successor: successorStorage.getStore() === span,
                overlapping: successorActive,
              };
            }
            continued.resolve();
          }
          if (callbacks.length === 1) {
            if (!flags) recordChildStorage();
            entered.resolve();
            await release.promise;
            if (!flags) recordChildStorage();
          }
          await Promise.resolve();
          checkPolicy();
          return 'accepted';
        },
      }),
    ],
  });
  const executor = await startPublicExecutor();
  try {
    const open = async () => {
      if (!flags) telemetry.setTraceContextStorage(openingStorage);
      const session = await agent.session({
        ...(flags
          ? { parentTrace: parent(PARENT.slice(0, -2) + flags) }
          : { tracing: { includeSensitiveData: false } }),
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
          approval: () => false,
        }),
      });
      try {
        if (!flags) telemetry.setTraceContextStorage(submissionStorage);
        const root = flags
          ? await session.submit('delegate')
          : await telemetry.withTrace(
              { name: 'carrier.owner', includeSensitiveData: false },
              (original) => {
                workflow = original;
                traceId = original.context.traceId;
                telemetry.setTraceContextStorage(openingStorage);
                return session.submit('delegate');
              },
            );
        assert.equal((await root.wait()).finalOutput, 'root done');
        return { session, root };
      } catch (error) {
        release.resolve();
        await session.close();
        throw error;
      }
    };
    const { session, root } = await open();
    try {
      const deadline = Date.now() + 5_000;
      let owned = await Array.fromAsync(session.subagents());
      while (owned.length === 1 && !owned[0]!.turn && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        owned = await Array.fromAsync(session.subagents());
      }
      assert.equal(owned.length, 1);
      const child = owned[0]!;
      assert(child.turn);
      await Promise.race([
        entered.promise,
        child.turn.wait().then(() => {
          throw new Error('Child finished without entering observe');
        }),
      ]);
      release.resolve();
      if (steering) {
        await sampled.promise;
        const steered = await telemetry.withTrace(
          { name: 'unrelated.steering', includeSensitiveData: true },
          () => child.submit(marker),
        );
        assert.equal(steered, child.turn);
        releaseSample.resolve();
        assert.equal((await child.turn.wait()).finalOutput, 'child done');
        await continued.promise;
        for await (const event of session.events()) {
          if (
            event.type === 'turn_finished' &&
            event.turnId === callbackTurns[1]
          ) {
            assert.equal(event.status, 'completed');
            break;
          }
        }
        assert.deepEqual(sampledMarker.slice(0, 3), [false, false, true]);
      } else {
        assert.equal((await child.turn.wait()).finalOutput, 'child done');
        let successor;
        const timeout = overlap
          ? setTimeout(releaseSuccessor.resolve, 5_000)
          : undefined;
        try {
          if (overlap) {
            telemetry.setTraceContextStorage(successorStorage);
            successor = await telemetry.withSpan({ name: 'successor' }, () =>
              session.submit('hold the next root'),
            );
            await Promise.race([
              successorEntered.promise,
              releaseSuccessor.promise.then(() => {
                throw new Error('Successor root did not reach the model');
              }),
            ]);
          }
          const later = await telemetry.withTrace(
            { name: 'unrelated.caller', includeSensitiveData: true },
            () => child.submit('call observe again'),
          );
          assert.equal((await later.wait()).finalOutput, 'child done');
          assert.equal(later.turnId, callbackTurns[1]);
        } finally {
          clearTimeout(timeout);
          releaseSuccessor.resolve();
        }
        if (successor)
          assert.equal((await successor.wait()).finalOutput, 'successor done');
      }
      if (steering) assert.deepEqual(sampledMarker, [false, false, true, true]);
      assert.equal(callbacks.length, 2);
      server.assertExhausted();
      return {
        flags,
        steering,
        sampledMarker,
        traceId,
        rootCallback,
        childStorage,
        retainedStorage,
        callbacks,
        callbackTurns,
        rootTurn: root.turnId,
        childTurns: callbackTurns,
        policyChecks,
      };
    } finally {
      release.resolve();
      releaseSample.resolve();
      releaseSuccessor.resolve();
      await session.close();
    }
  } finally {
    if (!flags) telemetry.setTraceContextStorage();
    release.resolve();
    releaseSample.resolve();
    await executor.close();
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
    const queued = await session.enqueue('queued', {
      parentTrace: headers,
    });
    headers.traceparent = WORKER;
    const parallel = await parallelAgent.run('parallel', {
      parentTrace: parent(WORKER),
    });
    await assert.rejects(
      session.submit('independent busy task', {
        parentTrace: parent(OVERRIDE),
      }),
      /submit requires a settled open session/,
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
      await turn.wait({ until: 'manual_tool' });
      const state = await session.suspend();
      assert(!JSON.stringify(state).includes(PARENT));
      assert(!JSON.stringify(state).includes('"traceparent"'));
      await writeFile(path, JSON.stringify(state));
      return { turn: turn.turnId };
    }
    const waiting = await session.wait({ until: 'manual_tool' });
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
        : mode?.startsWith('owned-steering-')
          ? await ownedChildren(mode.slice('owned-steering-'.length), true)
          : mode === 'owned-children-overlap'
            ? await ownedChildren(undefined, false, true)
            : mode?.startsWith('owned-children-')
              ? await ownedChildren(
                  mode === 'owned-children-scoped'
                    ? undefined
                    : mode.slice('owned-children-'.length),
                )
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
