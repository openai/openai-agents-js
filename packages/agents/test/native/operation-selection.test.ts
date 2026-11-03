import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  tool,
  toolRef,
  webSearch,
  selectMcpTools,
  type Turn,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { DeferredTools } from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { BorrowedPeer } from './fixtures/borrowed-mcp';
import { TurnAborted } from '../../src/runtime/session';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-selection',
    supportsWebsockets: false,
  });
}

function wireFunctions(request: { tools?: unknown; input?: unknown }) {
  const selected: Array<{ name: string; description?: string }> = [];
  function add(value: unknown) {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry.type === 'namespace') add(entry.tools);
      else if (entry.type === 'function' || entry.type === 'custom')
        selected.push(entry);
    }
  }
  add(request.tools);
  if (Array.isArray(request.input))
    for (const item of request.input)
      if (item.type === 'additional_tools') add(item.tools);
  return selected;
}

function names(request: { tools?: unknown; input?: unknown }) {
  return wireFunctions(request).map((tool) => tool.name);
}

it('selects A then B before preparation and supplies the issued Turn and zero-based index', async () => {
  const effects: string[] = [];
  const a = tool({
    name: 'a',
    parameters: z.object({}),
    execute: () => {
      effects.push('a');
      return 'A';
    },
  });
  const b = tool({
    name: 'b',
    parameters: z.object({}),
    execute: () => {
      effects.push('b');
      return 'B';
    },
  });
  const server = new ModelServer([
    [call('a', {}, { callId: 'a-1' })],
    [call('b', {}, { callId: 'b-1' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use admitted tools.',
    provider,
    tools: [a, b],
  }).session();
  const seen: { submission: Turn<unknown>; index: number }[] = [];
  const turn = await session.submit('go', {
    tools: [a, b],
    beforeStep({ submission, stepIndex }) {
      seen.push({ submission, index: stepIndex });
      return stepIndex === 0 ? [a] : stepIndex === 1 ? [toolRef('b')] : [];
    },
  });
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(effects).toEqual(['a', 'b']);
  expect(seen.map((entry) => entry.index)).toEqual([0, 1, 2]);
  expect(seen.every((entry) => entry.submission === turn)).toBe(true);
  expect(server.requests.map(names)).toEqual([['a'], ['b'], []]);
  server.assertExhausted();
});

it('blocks an off-roster call and keeps its handler and manual requests untouched', async () => {
  let effects = 0;
  const hidden = tool({
    name: 'hidden',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'bad';
    },
  });
  const manual = manualTool({
    name: 'manual',
    description: 'Ask.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [
      call('hidden', {}, { callId: 'hidden-1' }),
      call('manual', {}, { callId: 'manual-1' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    tools: [hidden, manual],
  }).session();
  const turn = await session.submit('go', { tools: [] });
  await turn.wait();
  expect(effects).toBe(0);
  expect('requests' in (await turn.wait({ until: 'request' }))).toBe(false);
  expect(server.requests.map(names)).toEqual([[], []]);
  server.assertExhausted();
});

it('fences provider entry on a rejected preparation and preserves its original error', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  const error = new Error('preparation failed');
  const turn = await session.submit('go', {
    beforeStep: async () => {
      throw error;
    },
  });
  await expect(turn.wait()).rejects.toBe(error);
  expect(server.requests).toHaveLength(0);
});

it('aborts and joins an entered preparation while the sole event reader keeps progressing', async () => {
  const entered = Promise.withResolvers<void>();
  const left = Promise.withResolvers<void>();
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  const turn = await session.submit('go', {
    beforeStep: async ({ signal }) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      left.resolve();
      signal.throwIfAborted();
      return [];
    },
  });
  await entered.promise;
  const result = turn.wait().catch(() => {});
  await session.close();
  await left.promise;
  await result;
  expect(server.requests).toHaveLength(0);
});

it('resolves stale selectors to acknowledged bindings and keeps defaults and FIFO capture separate', async () => {
  const effects: string[] = [];
  const old = tool({
    name: 'a',
    description: 'Old.',
    parameters: z.object({}),
    execute: () => {
      effects.push('old');
      return 'old';
    },
  });
  const replacement = tool({
    name: 'a',
    description: 'Current.',
    parameters: z.object({ value: z.string() }),
    execute: ({ value }) => {
      effects.push(value);
      return value;
    },
  });
  const server = new ModelServer([
    [call('a', { value: 'current' }, { callId: 'current-1' })],
    [message('selected')],
    [message('ordinary')],
    [message('restored ordinary')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    tools: [old],
  }).session();
  await session.update({ tools: [replacement] });
  await session.update({ tools: [] });
  const selectors = [old];
  const selected = await session.enqueue('selected', undefined, {
    tools: selectors,
  });
  selectors.length = 0;
  const ordinary = await session.enqueue('ordinary');
  await selected.wait();
  await ordinary.wait();
  expect(effects).toEqual(['current']);
  expect(server.requests.map(names)).toEqual([['a'], ['a'], []]);
  expect(
    wireFunctions(server.requests[0]).find((tool) => tool.name === 'a')
      ?.description,
  ).toBe('Current.');
  const state = await session.saveState();
  expect(state.native.managed_tool_specs).toEqual([
    expect.objectContaining({ name: 'a', description: 'Current.' }),
  ]);
  expect(state).toMatchObject({ kind: 'idle', default_tools: [] });
  await session.close();
  await expect(
    new Agent({ instructions: 'Answer.', provider }).session({ state }),
  ).rejects.toThrow('matching managed tools');
  await using restored = await new Agent({
    instructions: 'Answer.',
    provider,
    tools: [replacement],
  }).session({ state });
  await expect(
    restored.submit('restore unknown', { tools: [toolRef('not_admitted')] }),
  ).rejects.toThrow('not admitted');
  expect(
    (await (await restored.submit('use empty restored defaults')).wait())
      .finalOutput,
  ).toBe('restored ordinary');
  expect(server.requests.map(names)).toEqual([['a'], ['a'], [], []]);
  expect(effects).toEqual(['current']);
  server.assertExhausted();
});

it('rejects unknown declarations and duplicates before model input', async () => {
  const admitted = tool({
    name: 'a',
    parameters: z.object({}),
    execute: () => 'a',
  });
  const other = tool({
    name: 'a',
    parameters: z.object({}),
    execute: () => 'other',
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    tools: [admitted],
  }).session();
  await expect(session.submit('go', { tools: [other] })).rejects.toThrow(
    'not admitted',
  );
  await expect(
    session.submit('go', { tools: [admitted, toolRef('a')] }),
  ).rejects.toThrow('Duplicate');
  expect(server.requests).toHaveLength(0);
});

it('refuses callback-selected capture without consuming its manual reply', async () => {
  const decision = manualTool({
    name: 'decision',
    description: 'Choose.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [
      call('decision', {}, { callId: 'decision-1' }),
      call('decision', {}, { callId: 'decision-2' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Ask.',
    provider,
    tools: [decision],
  }).session();
  const turn = await session.submit('go', {
    tools: [decision],
    beforeStep: () => [decision],
  });
  const batch = await turn.wait({ until: 'request' });
  if (!('requests' in batch)) throw new Error('Expected a manual request');
  expect(await session.checkpointStatus({ kind: 'manualWait' })).toEqual({
    status: 'notReady',
    reasons: ['Cannot capture a callback-selected operation'],
  });
  await expect(session.suspend()).rejects.toThrow(
    'callback-selected operation',
  );
  expect(batch.requests).toHaveLength(2);
  const first = decision.match(batch.requests[0])!.reply('yes');
  const second = decision.match(batch.requests[1])!.reply('also yes');
  await session.respond(first);
  await expect(session.respond(first)).rejects.toThrow();
  await session.respond(second);
  expect((await turn.wait()).finalOutput).toBe('done');
  server.assertExhausted();
});

it('applies an explicit empty native plan to CodeMode without retaining generated helpers', async () => {
  const server = new ModelServer([
    (request) => {
      expect(request.tools ?? []).toEqual([]);
      return [message('empty')];
    },
    [message('ordinary')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    programmaticToolCalling: true,
  }).session();
  expect(
    (await (await session.submit('selected', { tools: [] })).wait())
      .finalOutput,
  ).toBe('empty');
  expect((await (await session.submit('ordinary')).wait()).finalOutput).toBe(
    'ordinary',
  );
  server.assertExhausted();
});

it('revokes a selected call while an asynchronous function policy waits', async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let effects = 0;
  const selected = tool({
    name: 'selected',
    parameters: z.object({}),
    before: async ({ signal }) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      released.resolve();
      return { action: 'allow' };
    },
    execute: () => {
      effects++;
      return 'bad';
    },
  });
  const server = new ModelServer([
    [call('selected', {}, { callId: 'selected-1' })],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Call selected.',
    provider,
    tools: [selected],
  }).session();
  const turn = await session.submit('go', { tools: [selected] });
  await entered.promise;
  const result = turn.wait().catch(() => {});
  await turn.cancel();
  await released.promise;
  await result;
  expect(effects).toBe(0);
  server.assertExhausted();
});

it('rejects preparation widening before the first provider request', async () => {
  const a = tool({ name: 'a', parameters: z.object({}), execute: () => 'a' });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    tools: [a],
  }).session();
  const turn = await session.submit('go', { tools: [], beforeStep: () => [a] });
  await expect(turn.wait()).rejects.toThrow('only narrow');
  expect(server.requests).toHaveLength(0);
});

it.each(['force', 'graceful'] as const)(
  'revokes and joins preparation on %s cancellation',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const left = Promise.withResolvers<void>();
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const turn = await session.submit('go', {
      beforeStep: async ({ signal }) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        left.resolve();
        signal.throwIfAborted();
        return [];
      },
    });
    await entered.promise;
    const result = turn.wait().catch(() => {});
    await turn.cancel({ mode });
    await left.promise;
    await result;
    expect(server.requests).toHaveLength(0);
  },
);

it.each(['force', 'graceful'] as const)(
  'keeps the session usable after %s preparation cancellation',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const server = new ModelServer([[message('successor')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const turn = await session.submit('cancel', {
      beforeStep: async ({ signal }) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
        return [];
      },
    });
    await entered.promise;
    const result = turn.wait().catch(() => {});
    await turn.cancel({ mode });
    await result;
    expect(server.requests).toHaveLength(0);
    expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
      'successor',
    );
    server.assertExhausted();
  },
);

it('joins delayed graceful preparation cleanup and admits a successor', async () => {
  const entered = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let left = false;
  let cancelled = false;
  const server = new ModelServer([[message('successor')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  try {
    const turn = await session.submit('cancel', {
      beforeStep: async ({ signal }) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        cleanupEntered.resolve();
        await release.promise;
        left = true;
        signal.throwIfAborted();
        return [];
      },
    });
    await entered.promise;
    const result = turn.wait().catch(() => {});
    const stop = turn.cancel({ mode: 'graceful' });
    void stop.then(
      () => {
        cancelled = true;
      },
      () => {
        cancelled = true;
      },
    );
    await cleanupEntered.promise;
    expect(left).toBe(false);
    expect(cancelled).toBe(false);
    expect(server.requests).toHaveLength(0);
    release.resolve();
    await stop;
    await result;
    expect(left).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
      'successor',
    );
    server.assertExhausted();
  } finally {
    release.resolve();
  }
});

it.each(['force', 'graceful'] as const)(
  'fails %s cancellation and close for a distinct preparation cleanup error of the same class',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const cleanup = new TurnAborted('Distinct preparation cleanup failure');
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    try {
      const turn = await session.submit('cancel', {
        beforeStep: async ({ signal }) => {
          entered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          throw cleanup;
        },
      });
      await entered.promise;
      const result = turn.wait().catch(() => {});
      await expect(turn.cancel({ mode })).rejects.toMatchObject({
        name: 'AggregateError',
        message: 'Native tool callback cleanup failed',
        errors: expect.arrayContaining([cleanup]),
      });
      await result;
      expect(server.requests).toHaveLength(0);
      const closeError = await session.close().catch((error: unknown) => error);
      const closeErrors: unknown[] = [closeError];
      for (const error of closeErrors) {
        if (error instanceof AggregateError) closeErrors.push(...error.errors);
      }
      expect(closeErrors).toContain(cleanup);
    } finally {
      await session.close().catch(() => {});
    }
  },
);

it.each(['standalone', 'hosted'] as const)(
  'filters %s WebSearch from an empty step plan and preserves ordinary roots',
  async (route) => {
    const server = new ModelServer([
      (request) => {
        expect(request.tools ?? []).toEqual([]);
        return [message('empty')];
      },
      [message('ordinary mixed root')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'operation-fixture',
      provider,
      tools: [
        webSearch({ route }),
        tool({
          name: 'ordinary',
          parameters: z.object({}),
          execute: () => 'ok',
        }),
      ],
    }).session();
    expect(
      (await (await session.submit('empty', { beforeStep: () => [] })).wait())
        .finalOutput,
    ).toBe('empty');
    expect((await (await session.submit('ordinary')).wait()).finalOutput).toBe(
      'ordinary mixed root',
    );
    server.assertExhausted();
  },
);

it.each(['prepare', 'start'] as const)(
  'refuses callback-selected pending Deferred.%s before journal or provider work and preserves the grant',
  async (method) => {
    const declaration = deferredTool({
      name: 'selected_job',
      description: 'Start work.',
      schemas: (schema) => ({
        parameters: schema.strictObject({}),
        result: schema.string(),
      }),
    });
    const journal = {
      prepare: vi.fn(),
      claim: vi.fn(),
      authorize: vi.fn(),
      record: vi.fn(),
      saveResult: vi.fn(),
    };
    const backend = {
      start: vi.fn(),
      observe: vi.fn(),
      reconcileCreation: vi.fn(),
    };
    const jobs = new DeferredTools({
      tenant: 'selected-tenant',
      runId: 'selected-run',
      journal,
    });
    jobs.register(declaration, {
      providerId: 'selected-provider',
      provider: backend,
      project: String,
    });
    const server = new ModelServer([
      [call('selected_job', {}, { callId: 'selected-job' })],
      [message('replied')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Ask.',
      provider,
      tools: [declaration],
    }).session();
    const turn = await session.submit('go', {
      tools: [declaration],
      beforeStep: () => [declaration],
    });
    const batch = await turn.wait({ until: 'request' });
    if (!('requests' in batch))
      throw new Error('Expected the selected manual request');
    const request = batch.requests[0];
    const use = vi.fn();
    const attempt =
      method === 'prepare'
        ? jobs.prepare(session, request)
        : jobs.start(session, request, {}, use);
    await expect(attempt).rejects.toThrow(
      'Deferred checkpoint could not be prepared',
    );
    expect(journal.prepare).not.toHaveBeenCalled();
    expect(journal.claim).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.observe).not.toHaveBeenCalled();
    expect(backend.reconcileCreation).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
    const matched = declaration.match(request);
    if (!matched) throw new Error('Expected the original declaration');
    const reply = matched.reply('ordinary response');
    await session.respond(reply);
    await expect(session.respond(reply)).rejects.toThrow();
    expect((await turn.wait()).finalOutput).toBe('replied');
    server.assertExhausted();
  },
);

it('selects borrowed namespaces while preserving distinct same-name bindings and updates', async () => {
  const peer = new BorrowedPeer();
  const borrowed = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined },
  );
  const execute = vi.fn(() => 'ordinary');
  const ordinary = tool({
    name: 'lookup',
    parameters: z.object({ value: z.string() }),
    execute,
  });
  const server = new ModelServer([
    (request) => {
      expect(request.tools ?? []).toEqual([]);
      return [message('empty')];
    },
    [
      call(
        'lookup',
        { value: 'borrowed' },
        { namespace: 'crm', callId: 'borrowed' },
      ),
      call('lookup', { value: 'ordinary' }, { callId: 'ordinary' }),
    ],
    [message('both')],
    [
      call(
        'lookup',
        { value: 'retained borrowed' },
        { namespace: 'crm', callId: 'retained-borrowed' },
      ),
    ],
    [message('after removal')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the tools.',
    provider,
    tools: [ordinary, ...borrowed],
  }).session();
  expect(
    (await (await session.submit('empty', { tools: [] })).wait()).finalOutput,
  ).toBe('empty');
  await session.update({ tools: [ordinary, ...borrowed] });
  expect(
    (
      await (
        await session.submit('both', { tools: [ordinary, ...borrowed] })
      ).wait()
    ).finalOutput,
  ).toBe('both');
  expect(peer.callTool).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  await session.update({ tools: [ordinary] });
  expect(
    (
      await (
        await session.submit('selected after removal', {
          tools: [toolRef('lookup'), toolRef('lookup', 'crm')],
        })
      ).wait()
    ).finalOutput,
  ).toBe('after removal');
  expect(peer.callTool).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(1);
  server.assertExhausted();
});

it('retains hidden admitted bindings and narrowed defaults across supplied compaction', async () => {
  const effects: string[] = [];
  const a = tool({ name: 'a', parameters: z.object({}), execute: () => 'A' });
  const b = tool({
    name: 'b',
    parameters: z.object({}),
    execute: () => {
      effects.push('b');
      return 'B';
    },
  });
  const server = new ModelServer([
    [message('before')],
    [call('b', {}, { callId: 'hidden-after-compaction' })],
    [message('selected after')],
    [message('ordinary after')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    tools: [a, b],
  }).session();
  await (await session.submit('remember')).wait();
  await session.update({ tools: [a] });
  await session.compact({ summary: 'Remember the completed answer.' });
  expect(server.requests).toHaveLength(1);
  const state = await session.saveState();
  expect(state.native.managed_tool_specs).toEqual([
    expect.objectContaining({ name: 'a' }),
    expect.objectContaining({ name: 'b' }),
  ]);
  expect(state).toMatchObject({
    kind: 'idle',
    default_tools: [{ name: 'a', namespace: 'functions' }],
  });
  const selected = await session.submit('use hidden B', { tools: [b] });
  expect((await selected.wait()).finalOutput).toBe('selected after');
  expect(effects).toEqual(['b']);
  expect(
    (await (await session.submit('ordinary defaults')).wait()).finalOutput,
  ).toBe('ordinary after');
  expect(server.requests.map(names)).toEqual([['a', 'b'], ['b'], ['b'], ['a']]);
  server.assertExhausted();
});

it('retains the issuing step plan for a yielded cell after a successor removes its leaf', async () => {
  let entered = false;
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  const first = tool({
    name: 'first',
    parameters: z.object({}),
    async execute() {
      entered = true;
      await release.promise;
      effects.push('first');
      return 'first accepted';
    },
  });
  const second = tool({
    name: 'second',
    parameters: z.object({}),
    execute() {
      effects.push('second');
      return 'issuing step accepted';
    },
  });
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'old-cell',
        input:
          'const pending = tools.first({}); yield_control(); await pending; text(await tools.second({}));',
      },
    ],
    async (request) => {
      const output = (request.input as Array<Record<string, unknown>>).find(
        (item) =>
          item.type === 'custom_tool_call_output' &&
          item.call_id === 'old-cell',
      )?.output;
      expect(output).toBeDefined();
      const text =
        typeof output === 'string'
          ? output
          : (output as Array<{ text?: string }>)
              .map((item) => item.text ?? '')
              .join('');
      const cell = /Script running with cell ID ([^\s.]+)/.exec(text)?.[1];
      if (!cell)
        throw new Error(`Missing yielded cell: ${JSON.stringify(output)}`);
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      // This request is admitted only after the successor has selected its plan.
      release.resolve();
      return [
        call(
          'wait',
          { cell_id: cell, yield_time_ms: 1000 },
          { callId: 'join-cell' },
        ),
      ];
    },
    (request) => {
      expect(JSON.stringify(request.input)).toContain('issuing step accepted');
      return [message('done')];
    },
  ]);
  await using provider = await providerFor(server);
  const session = await new Agent({
    instructions: 'Keep the issuing roster.',
    provider,
    tools: [first, second],
    programmaticToolCalling: true,
  }).session();
  try {
    const turn = await session.submit('Yield then continue.', {
      beforeStep: ({ stepIndex }) =>
        stepIndex === 0 ? [first, second] : [first],
    });
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toEqual(['first', 'second']);
    const descriptions = server.requests.map(
      (request) =>
        wireFunctions(request).find((tool) => tool.name === 'exec')
          ?.description,
    );
    expect(descriptions[0]).toContain('### `second`');
    for (const description of descriptions.slice(1)) {
      expect(description).toBeTypeOf('string');
      expect(description).not.toContain('### `second`');
    }
    server.assertExhausted();
  } finally {
    release.resolve();
    await session.close();
  }
}, 40_000);
