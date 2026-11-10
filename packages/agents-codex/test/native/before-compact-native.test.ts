import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  tool,
  type CompactionContext,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { nativeDescendantModel } from './fixtures/native-descendant-model';
import { startPublicExecutor } from './fixtures/public-executor';
import type { JsonObject } from '../../src/runtime/binding';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-compaction-callback',
    supportsWebsockets: false,
  });
}
const highUsage = JSON.stringify({
  input_tokens: 260_000,
  output_tokens: 1_000,
  total_tokens: 261_000,
});
const text = (value: unknown) => JSON.stringify(value);

async function selectRemoteCompaction() {
  // Same narrow capability seam as the Python native compaction regression.
  // It selects the real remote-v2 Core owner; no compaction result is mocked.
  const native = await binding();
  const select = (config: Record<string, any>) => {
    config['model_providers.native_agent'].capabilities = {
      remote_compaction: 'v2',
    };
  };
  const create = native.create_engine;
  vi.spyOn(native, 'create_engine').mockImplementation(
    async (config, ...args) => {
      const captured = JSON.parse(config);
      select(captured);
      return create(JSON.stringify(captured), ...args);
    },
  );
  const start = native.Engine.prototype.start_replaceable_thread;
  vi.spyOn(
    native.Engine.prototype,
    'start_replaceable_thread',
  ).mockImplementation(function (
    this: import('../../native/index.js').Engine,
    options,
    specs,
  ) {
    const captured = JSON.parse(options);
    select(captured.config);
    return start.call(this, JSON.stringify(captured), specs);
  });
}

nativeIt.each([false, true])(
  'publishes a captured application summary without a compaction provider request (remote=%s)',
  async (remote) => {
    if (remote) await selectRemoteCompaction();
    const server = new ModelServer([
      [message('remembered')],
      [message('continued')],
    ]);
    const application = { pending: 'Cite reference atlas-17.' };
    const calls: CompactionContext<typeof application>[] = [];
    await using provider = await providerFor(server);
    const agent = new Agent<typeof application>({
      instructions: 'Original instruction.',
      model: 'gpt-5.5',
      provider,
      beforeCompact: (context) => {
        calls.push(context);
        return context.context.pending;
      },
    });
    await using session = await agent.session({ context: application });
    await (await session.submit('Remember the source.')).wait();
    await session.update({ instructions: 'Current instruction.' });
    const original = await session.saveState();
    await session.compact();
    expect(server.requests).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toBe(application);
    expect(calls[0]).toMatchObject({
      sessionId: session.id,
      automatic: false,
      model: 'gpt-5.5',
    });
    expect(calls[0]!.requestId).toEqual(expect.any(String));
    expect(text(calls[0]!.items)).toContain('Remember the source.');
    const saved = await session.saveState();
    expect(saved.history.slice(0, original.history.length)).toEqual(
      original.history,
    );
    const summaries = saved.history.filter((row) => row.type === 'compacted');
    expect(summaries).toHaveLength(1);
    expect(text(summaries[0])).toContain(application.pending);
    expect(
      (summaries[0]!.payload as Record<string, unknown>)
        .compaction_response_id ?? null,
    ).toBeNull();
    expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
      'continued',
    );
    expect(text(server.requests[1]!.input)).toContain(application.pending);
    expect(text(server.requests[1])).toContain('Current instruction.');
    server.assertExhausted();
  },
  20_000,
);

nativeIt(
  'declines to the ordinary native summary and keeps detached edits out of canonical history',
  async () => {
    const server = new ModelServer([
      [message('remembered')],
      [message('Native summary.')],
    ]);
    const order: string[] = [];
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
      beforeCompact: (context) => {
        order.push('beforeCompact');
        for (const item of context.items)
          if (item.role === 'user')
            item.content = [{ type: 'input_text', text: 'DISCARDED_EDIT' }];
      },
      transformContext: (context) => {
        order.push(context.purpose);
      },
    }).session();
    await (await session.submit('Original input.')).wait();
    await session.compact();
    expect(order).toEqual(['turn', 'beforeCompact', 'compaction']);
    expect(server.requests).toHaveLength(2);
    expect(text(server.requests[1])).toContain('Original input.');
    expect(text(server.requests)).not.toContain('DISCARDED_EDIT');
    expect(text((await session.saveState()).history)).toContain(
      'Native summary.',
    );
    server.assertExhausted();
  },
  20_000,
);

nativeIt(
  'supplies an automatic summary after the tool effect and before the next model request',
  async () => {
    const application = { pending: 'Run lookup.' };
    let effects = 0;
    const calls: CompactionContext<typeof application>[] = [];
    const server = new ModelServer(
      [[call('lookup', {}, { callId: 'lookup-once' })], [message('Cited.')]],
      [highUsage],
    );
    await using provider = await providerFor(server);
    await using session = await new Agent<typeof application>({
      instructions: 'Use lookup.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => {
            effects++;
            application.pending = 'Cite reference atlas-17.';
            return 'Lookup finished.';
          },
        }),
      ],
      beforeCompact: (context) => {
        calls.push(context);
        expect(text(context.items)).toContain('Lookup finished.');
        return context.context.pending;
      },
    }).session({ context: application });
    const turn = await session.submit('Look up the reference.');
    expect((await turn.wait()).finalOutput).toBe('Cited.');
    expect(effects).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ automatic: true, turnId: turn.turnId });
    expect(text(server.requests[1]!.input)).toContain(application.pending);
    expect(server.requests).toHaveLength(2);
    server.assertExhausted();
  },
  20_000,
);

nativeIt(
  'rebinds on restore, freezes the current opening and leaves supplied summaries on their existing route',
  async () => {
    const server = new ModelServer([]);
    const calls: string[] = [];
    await using provider = await providerFor(server);
    const agent = new Agent<string>({
      instructions: 'Answer.',
      provider,
      beforeCompact: () => {
        calls.push('captured');
        return 'Original summary.';
      },
    });
    let state;
    {
      await using session = await agent.session({ context: 'old' });
      agent.beforeCompact = (context) => {
        calls.push(context.context);
        return context.context;
      };
      await session.compact();
      state = await session.saveState();
    }
    await using restored = await agent.session({
      state,
      context: 'Current summary.',
    });
    await restored.compact({ summary: 'Explicit summary.' });
    expect(calls).toEqual(['captured']);
    await restored.compact();
    expect(calls).toEqual(['captured', 'Current summary.']);
    expect(text((await restored.saveState()).history)).toContain(
      'Current summary.',
    );
    expect(server.requests).toHaveLength(0);
  },
  20_000,
);

nativeIt.each([null, '', '   ', 42, {}])(
  'rejects an invalid summary without provider work or a compacted record (%j)',
  async (bad) => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
      beforeCompact: () => bad as never,
    }).session();
    await expect(session.compact()).rejects.toThrow('nonempty summary');
    expect(server.requests).toHaveLength(0);
    expect(
      (await session.saveState()).history.some(
        (row) => row.type === 'compacted',
      ),
    ).toBe(false);
  },
  15_000,
);

nativeIt(
  'joins a canceled automatic callback and never publishes its suppressed late summary',
  async () => {
    const server = new ModelServer(
      [
        [call('lookup', {}, { callId: 'lookup-once' })],
        [message('healthy next turn')],
      ],
      [highUsage],
    );
    const entered = Promise.withResolvers<AbortSignal>(),
      release = Promise.withResolvers<void>();
    let finished = false,
      canceled = false,
      calls = 0,
      effects = 0;
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'lookup done';
          },
        }),
      ],
      beforeCompact: async (context) => {
        if (calls++ !== 0) return 'Fresh summary.';
        entered.resolve(context.signal);
        await release.promise;
        finished = true;
        return 'LATE_CANCELED_SUMMARY';
      },
    }).session();
    const turn = await session.submit('Lookup.');
    const result = turn.wait().catch((error) => error);
    try {
      const signal = await entered.promise;
      const canceling = turn.cancel().then(() => {
        canceled = true;
      });
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(canceled).toBe(false);
      expect(finished).toBe(false);
      expect(effects).toBe(1);
      release.resolve();
      await canceling;
      expect(await result).toBeInstanceOf(NativeError);
      expect(finished).toBe(true);
      expect(text((await session.saveState()).history)).not.toContain(
        'LATE_CANCELED_SUMMARY',
      );
      expect(
        (await (await session.submit('Next turn.')).wait()).finalOutput,
      ).toBe('healthy next turn');
      expect(text(server.requests)).not.toContain('LATE_CANCELED_SUMMARY');
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    } finally {
      release.resolve();
      await result;
    }
  },
  20_000,
);

nativeIt(
  'close joins a held manual callback before retiring its owner',
  async () => {
    const server = new ModelServer([]);
    const entered = Promise.withResolvers<AbortSignal>(),
      release = Promise.withResolvers<void>();
    let finished = false,
      closed = false;
    await using provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
      beforeCompact: async (context) => {
        entered.resolve(context.signal);
        await release.promise;
        finished = true;
        return 'LATE_CLOSE_SUMMARY';
      },
    }).session();
    const compacting = session.compact().catch((error) => error);
    try {
      const signal = await entered.promise;
      const closing = session.close().then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(closed).toBe(false);
      expect(finished).toBe(false);
      release.resolve();
      await closing;
      expect(await compacting).toBeInstanceOf(NativeError);
      expect(finished).toBe(true);
      expect(server.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await compacting;
      await session.close();
    }
  },
  20_000,
);

nativeIt(
  'uses the captured destination profile hook and application context',
  async () => {
    const server = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'handoff' })],
      [message('B final')],
    ]);
    const application = { summary: 'B captured summary.' },
      late = vi.fn();
    const captured = vi.fn((context: CompactionContext<typeof application>) => {
      expect(context.context).toBe(application);
      expect(context.model).toBe('gpt-5.5');
      return context.context.summary;
    });
    await using provider = await providerFor(server);
    const destination = new Agent<typeof application>({
      name: 'B',
      instructions: 'B base',
      model: 'gpt-5.5',
      provider,
      beforeCompact: captured,
    });
    await using session = await new Agent<typeof application>({
      name: 'A',
      instructions: 'A base',
      model: 'gpt-5.5',
      provider,
      handoffs: [destination],
    }).session({ context: application });
    destination.beforeCompact = late;
    const beforeStep = vi.fn(() => undefined);
    await (await session.submit('Transfer.', { beforeStep })).wait();
    expect(beforeStep).toHaveBeenCalledTimes(2);
    await session.compact();
    expect(beforeStep).toHaveBeenCalledTimes(2);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    expect(text((await session.saveState()).history)).toContain(
      application.summary,
    );
    expect(server.requests).toHaveLength(2);
    server.assertExhausted();
  },
  20_000,
);

nativeIt(
  'routes automatic child compaction to the captured child owner without borrowing the root turn',
  async () => {
    let rootId: string | undefined,
      effects = 0;
    const counts = new Map<string, number>();
    const thread = (request: JsonObject) =>
      String(
        JSON.parse(
          (request.client_metadata as Record<string, string>)[
            'x-codex-turn-metadata'
          ]!,
        ).thread_id,
      );
    const respond = (request: JsonObject) => {
      const id = thread(request);
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id === rootId && count === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Use lookup and answer.' },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      if (id !== rootId && count === 1)
        return [call('lookup', {}, { callId: 'child-lookup-once' })];
      return [message(id === rootId ? 'root final' : 'child final')];
    };
    const usage = (request: JsonObject) =>
      thread(request) !== rootId && counts.get(thread(request)) === 1
        ? JSON.stringify({
            input_tokens: 5_000_000,
            output_tokens: 1_000,
            total_tokens: 5_001_000,
          })
        : undefined;
    const server = new ModelServer(
      Array.from({ length: 4 }, () => respond),
      Array.from({ length: 4 }, () => usage),
    );
    const observed: CompactionContext[] = [];
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate the lookup.',
        model: nativeDescendantModel,
        provider,
        tools: [
          new NativeAgents(),
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'Child lookup finished.';
            },
          }),
        ],
        beforeCompact: (context) => {
          observed.push(context);
          return 'CHILD_CAPTURED_SUMMARY';
        },
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect(
        (await (await session.submit('Delegate.')).wait()).finalOutput,
      ).toBe('root final');
      const children = await vi.waitUntil(async () => {
        const entries = await Array.fromAsync(session.subagents());
        return entries.length === 1 && entries[0]!.turn ? entries : false;
      });
      const child = children[0]!,
        childTurn = child.turn!;
      expect((await childTurn.wait()).finalOutput).toBe('child final');
      expect(effects).toBe(1);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        sessionId: session.id,
        subagentId: child.id,
        turnId: childTurn.turnId,
        automatic: true,
        model: nativeDescendantModel,
      });
      expect(text(observed[0]!.items)).toContain('Child lookup finished.');
      const childRequests = server.requests.filter(
        (request) => thread(request) === child.id,
      );
      const rootRequests = server.requests.filter(
        (request) => thread(request) === rootId,
      );
      expect(childRequests).toHaveLength(2);
      expect(rootRequests).toHaveLength(2);
      expect(text(childRequests[1]!.input)).toContain('CHILD_CAPTURED_SUMMARY');
      expect(text(rootRequests)).not.toContain('CHILD_CAPTURED_SUMMARY');
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

nativeIt(
  'preserves steering admitted while the automatic summary callback waits',
  async () => {
    const server = new ModelServer(
      [
        [call('lookup', {}, { callId: 'lookup-once' })],
        [message('tool continuation before steering')],
        [message('answer after steering')],
      ],
      [highUsage],
    );
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0,
      effects = 0;
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer current input.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'lookup done';
          },
        }),
      ],
      beforeCompact: async (context) => {
        calls++;
        expect(text(context.items)).not.toContain('STEER_DURING_COMPACTION');
        entered.resolve();
        await release.promise;
        return 'Summary before steering.';
      },
    }).session();
    const turn = await session.submit('Lookup.');
    const outcome = turn.wait();
    outcome.catch(() => {});
    try {
      await entered.promise;
      await turn.steer('STEER_DURING_COMPACTION');
      release.resolve();
      expect((await outcome).finalOutput).toBe('answer after steering');
      expect(calls).toBe(1);
      expect(effects).toBe(1);
      expect(server.requests).toHaveLength(3);
      expect(text(server.requests[2]!.input)).toContain(
        'STEER_DURING_COMPACTION',
      );
      expect(text(server.requests[1]!.input)).toContain(
        'Summary before steering.',
      );
      expect(text(server.requests[1]!.input)).not.toContain(
        'STEER_DURING_COMPACTION',
      );
      expect(text(server.requests[2]!.input)).toContain(
        'Summary before steering.',
      );
      server.assertExhausted();
    } finally {
      release.resolve();
      await outcome.catch(() => {});
    }
  },
  20_000,
);

nativeIt(
  'preserves a callback error and never substitutes a provider fallback',
  async () => {
    const server = new ModelServer([]),
      failure = new Error('application summary failed');
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
      beforeCompact: () => {
        throw failure;
      },
    }).session();
    await expect(session.compact()).rejects.toBe(failure);
    expect(server.requests).toHaveLength(0);
    expect(
      (await session.saveState()).history.some(
        (row) => row.type === 'compacted',
      ),
    ).toBe(false);
  },
  15_000,
);
