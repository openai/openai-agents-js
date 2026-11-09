import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ObservationBuffer } from '../../src/runtime/observation';
import { decodeRequestMetadata } from '../../src/runtime/request-metadata';
import type { Completed } from '../../src/runtime/session';
import { ModelServer, message, call } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function within<T>(pending: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not arrive`)),
      10_000,
    );
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function streamingBody(chunks: string[]): string {
  const item = {
    id: 'carrier-message',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: chunks.join('') }],
  };
  return [
    { type: 'response.created', response: { id: 'carrier-response' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    ...chunks.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'carrier-response',
        output: [item],
        usage: {
          input_tokens: 17,
          output_tokens: 7,
          total_tokens: 24,
        },
      },
    },
  ]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join('');
}

function response(chunks: string[]) {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: streamingBody(chunks),
  };
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-terminal-carrier',
    supportsWebsockets: false,
  });
}

function ordinaryFactory(agent: Agent) {
  const original = agent.session;
  Object.defineProperty(agent, 'session', {
    configurable: true,
    value: function (this: Agent, ...args: unknown[]) {
      return Reflect.apply(original, this, args);
    },
  });
}

async function observeReads() {
  const native = await binding();
  const ordinary = native.NativeThread.prototype._next_session_events;
  const owned = native.NativeThread.prototype._next_owned_session_events;
  expect(typeof owned).toBe('function'); // Never silently qualify an ordinary binary.
  const active = new Map<NativeThread, number>();
  const rows: string[][] = [];
  const calls: { turn: string; seen: boolean }[] = [];
  const entered = Promise.withResolvers<void>();
  let overlap = 0;
  function track(thread: NativeThread, pending: Promise<string[]>) {
    if ((active.get(thread) ?? 0) !== 0) overlap++;
    active.set(thread, (active.get(thread) ?? 0) + 1);
    void pending.then(
      (batch) => {
        rows.push([...batch]);
        active.set(thread, active.get(thread)! - 1);
      },
      () => {
        active.set(thread, active.get(thread)! - 1);
      },
    );
    return pending;
  }
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(function (this: NativeThread) {
    return track(this, ordinary.call(this));
  });
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_owned_session_events',
  ).mockImplementation(function (this: NativeThread, turn, seen) {
    calls.push({ turn, seen });
    const pending = track(this, owned.call(this, turn, seen));
    entered.resolve();
    return pending;
  });
  return {
    native,
    ordinary,
    owned,
    rows,
    calls,
    entered,
    active,
    trackRead: track,
    assertJoined() {
      expect(overlap).toBe(0);
      expect([...active.values()]).toEqual([...active.values()].map(() => 0));
    },
  };
}

async function replay(result: Completed) {
  const first = [];
  for await (const event of result.turn.events({
    includeExecutionDetails: true,
  }))
    first.push(event);
  const second = [];
  for await (const event of result.turn.events({
    includeExecutionDetails: true,
  }))
    second.push(event);
  expect(second).toEqual(first);
  for (let index = 0; index < first.length; index++) {
    const event = first[index]!;
    expect(Number.isInteger(event.sequence)).toBe(true);
    expect(event.sequence).toBeGreaterThan(
      index === 0 ? 0 : first[index - 1]!.sequence,
    );
    if (index + 1 < first.length) {
      const suffix = [];
      for await (const remaining of result.turn.events({
        after: event.sequence,
        includeExecutionDetails: true,
      }))
        suffix.push(remaining);
      expect(suffix).toEqual(first.slice(index + 1));
    }
  }
  const last = first.at(-1);
  if (last) {
    const tail = [];
    for await (const event of result.turn.events({
      after: last.sequence,
      includeExecutionDetails: true,
    }))
      tail.push(event);
    expect(tail).toEqual([]);
  }
  expect(await result.turn.wait()).toBe(result); // Original Completed/Turn owner, not a replacement.
  return first;
}

// Relabel only opaque cross-run identities. Keep every field, scope relation,
// sequence, gap, usage value and text unchanged; independent cursors compare exactly above.
function identities(value: unknown): unknown {
  const ids = new Map<string, string>();
  const keys = new Set([
    'sessionId',
    'threadId',
    'turnId',
    'submissionId',
    'parentSubmissionId',
    'requestId',
    'responseObservationId',
  ]);
  function visit(value: unknown, key = ''): unknown {
    if (typeof value === 'string' && keys.has(key)) {
      if (!ids.has(value)) ids.set(value, `identity-${ids.size}`);
      return ids.get(value);
    }
    if (Array.isArray(value)) return value.map((entry) => visit(entry));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [key, visit(value, key)]),
      );
    return value;
  }
  return visit(value);
}

it.each([
  {
    name: 'ordinary chunks and empty/NUL/Unicode text',
    chunks: ['α🙂', '', '\0', 'answer'],
  },
  {
    name: 'oversized Unicode eviction followed by a retained suffix',
    chunks: ['🙂'.repeat(33_000), 'retained suffix'],
  },
])(
  'preserves exact completed replay and usage: $name',
  async ({ chunks }) => {
    const reads = await observeReads();
    type Published = NonNullable<ReturnType<ObservationBuffer['append']>>;
    const publications: Published[] = [];
    let publicationOverflow = false;
    const append = ObservationBuffer.prototype.append;
    vi.spyOn(ObservationBuffer.prototype, 'append').mockImplementation(
      function (this: ObservationBuffer, value) {
        const event = append.call(this, value);
        if (event) {
          if (publications.length === 128) publicationOverflow = true;
          else publications.push(event);
        }
        return event;
      },
    );
    const server = new ModelServer([response(chunks), response(chunks)]);
    await using provider = await providerFor(server);
    const ordinary = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    ordinaryFactory(ordinary);
    const reference = await ordinary.run('Answer.');
    expect(reads.calls).toHaveLength(0);
    const expectedReplay = await replay(reference);
    const candidate = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).run('Answer.');
    expect(reads.calls).toHaveLength(1);
    expect(candidate.finalOutput).toBe(chunks.join(''));
    expect(candidate.finalOutput).toBe(reference.finalOutput);
    expect(candidate.threadUsage).toEqual(reference.threadUsage);
    const candidateReplay = await replay(candidate);
    function checkPublicationReplay(
      result: Completed,
      actual: typeof candidateReplay,
    ) {
      expect(publicationOverflow).toBe(false);
      expect(actual.length).toBeGreaterThan(0);
      const sessionId = actual[0]!.sessionId;
      const published = publications.filter(
        (event) => event.sessionId === sessionId,
      );
      expect(published.map((event) => event.sequence)).toEqual(
        published.map((_, index) => index + 1),
      );
      expect(published.at(-1)?.type).toBe('session_ended');
      const starts = published.filter((event) => event.type === 'turn_started');
      expect(starts).toHaveLength(1);
      const submissionId = starts[0]!.submissionId;
      expect(starts[0]!.turnId).toBe(result.turn.turnId);
      const scoped = published.filter(
        (event) =>
          'submissionId' in event && event.submissionId === submissionId,
      );
      const deltas = scoped.filter(
        (event) => event.type === 'output_text_delta',
      );
      // This checks the giant payload before retention can discard it.
      expect(deltas.map((event) => event.delta).join('')).toBe(chunks.join(''));
      const metadata = scoped.filter(
        (event) =>
          event.type === 'model_request_dispatching' ||
          event.type === 'model_response_linked',
      );
      const wireMetadata = reads.rows
        .flat()
        .map((raw) => JSON.parse(raw))
        .filter(
          (event) =>
            event.msg?.type === '_sdk_request_metadata' &&
            event.id === result.turn.turnId &&
            event.msg.observation?.thread_id === sessionId,
        );
      // This admitted fixture has one dispatch and one retained response. Require
      // their actual bridge delivery and exact publication, even if later evicted.
      expect(wireMetadata.map((event) => event.msg.observation.type)).toEqual([
        'model_request_dispatching',
        'model_response_linked',
      ]);
      expect(
        metadata.map(
          ({ sequence: _sequence, sessionId: _sessionId, ...event }) => event,
        ),
      ).toEqual(
        wireMetadata.map((event) =>
          decodeRequestMetadata(event.msg.observation, event.msg.submission_id),
        ),
      );
      expect(metadata).toHaveLength(2);
      expect(metadata[1]!.requestId).toBe(metadata[0]!.requestId);
      expect(
        metadata.every(
          (event) =>
            event.threadId === sessionId &&
            event.turnId === result.turn.turnId &&
            event.submissionId === submissionId,
        ),
      ).toBe(true);
      // Only scalar fixture observations occur here; richer item budgets have
      // their existing retention tests. Fail if that fixture assumption changes.
      const kinds = new Set([
        'turn_started',
        'warning',
        'model_request_dispatching',
        'model_response_linked',
        'output_text_delta',
        'usage_updated',
        'turn_finished',
        'session_ended',
      ]);
      expect(published.every((event) => kinds.has(event.type))).toBe(true);
      const oversized = (event: Published) =>
        event.type === 'output_text_delta' && event.delta.length > 65_536;
      expect(published.filter(oversized)).toHaveLength(
        chunks[0]!.length > 65_536 ? 1 : 0,
      );
      const retained = published.slice(published.findLastIndex(oversized) + 1);
      expect(retained.length).toBeLessThanOrEqual(256);
      // These plain fixture records have no custom serialization. JSON includes
      // every scalar string plus keys/escaping, so this conservative bound proves
      // no further size eviction without copying the buffer's size calculation.
      expect(JSON.stringify(retained).length).toBeLessThanOrEqual(65_536);
      const oldest = retained[0]?.sequence ?? published.at(-1)!.sequence + 1;
      const expected = [
        ...(oldest > 1
          ? [{ type: 'gap', sessionId, firstSequence: 1, sequence: oldest - 1 }]
          : []),
        ...retained.filter(
          (event) =>
            'submissionId' in event && event.submissionId === submissionId,
        ),
      ];
      // Keep the exact gap and every surviving metadata/payload/cursor field.
      expect(actual).toEqual(expected);
      // The Core text/lifecycle channel and the metadata channel each retain
      // their own order; neither promises a cross-channel total order.
      const semantic = scoped.filter(
        (event) =>
          event.type !== 'model_request_dispatching' &&
          event.type !== 'model_response_linked',
      );
      return {
        semantic: semantic.map(({ sequence: _sequence, ...event }) => event),
        sampling: metadata
          .filter((event) => event.type === 'model_request_dispatching')
          .map(({ sequence: _sequence, ...event }) => event),
      };
    }
    expect(
      identities(checkPublicationReplay(candidate, candidateReplay)),
    ).toEqual(identities(checkPublicationReplay(reference, expectedReplay)));
    if (chunks[0]!.length > 65_536)
      expect(candidateReplay.some((event) => event.type === 'gap')).toBe(true);
    server.assertExhausted();
    reads.assertJoined();
  },
  30_000,
);

it.each(['accepted-before-start', 'start-before-accepted'] as const)(
  'admits only after both start and acceptance: %s',
  async (order) => {
    const reads = await observeReads();
    const accepted = Promise.withResolvers<void>();
    const startDelivered = Promise.withResolvers<void>();
    const releaseBody = Promise.withResolvers<void>();
    const submit = reads.native.NativeThread.prototype._submit;
    vi.spyOn(reads.native.NativeThread.prototype, '_submit').mockImplementation(
      function (this: NativeThread, request) {
        const pending = submit.call(this, request);
        void pending.then(
          () => accepted.resolve(),
          () => accepted.resolve(),
        );
        return order === 'start-before-accepted'
          ? pending.then(async (result) => {
              await startDelivered.promise;
              return result;
            })
          : pending;
      },
    );
    // Observe the same ordinary promise, except when deliberately holding its
    // task_started result to establish acceptance-first ordering.
    vi.spyOn(
      reads.native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(function (this: NativeThread) {
      const pending = reads.ordinary.call(this);
      const isStart = (rows: string[]) =>
        rows.some((raw) =>
          ['task_started', 'turn_started'].includes(JSON.parse(raw).msg.type),
        );
      if (order === 'accepted-before-start')
        return reads.trackRead(
          this,
          pending.then(async (rows) => {
            if (isStart(rows)) await accepted.promise;
            return rows;
          }),
        );
      void pending.then(
        (rows) => {
          if (isStart(rows)) queueMicrotask(() => startDelivered.resolve());
        },
        () => startDelivered.resolve(),
      );
      return reads.trackRead(this, pending);
    });
    const server = new ModelServer([
      async () => {
        await releaseBody.promise;
        return [message('answer')];
      },
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const stop = new AbortController();
    const running = agent.run('Answer.', { signal: stop.signal });
    try {
      await within(reads.entered.promise, 'owned native read');
      expect(reads.calls).toHaveLength(1);
      expect(reads.calls[0]!.turn).not.toBe('');
      releaseBody.resolve();
      expect((await running).finalOutput).toBe('answer');
      server.assertExhausted();
      reads.assertJoined();
    } finally {
      accepted.resolve();
      startDelivered.resolve();
      stop.abort(new Error('test cleanup'));
      releaseBody.resolve();
      await running.catch(() => {});
    }
  },
  30_000,
);

it('retains first parser failure after processing the preceding public warning', async () => {
  const reads = await observeReads();
  const append = vi.spyOn(ObservationBuffer.prototype, 'append');
  vi.spyOn(
    reads.native.NativeThread.prototype,
    '_next_owned_session_events',
  ).mockImplementation(function (this: NativeThread, turn, seen) {
    reads.calls.push({ turn, seen });
    return reads.owned.call(this, turn, seen).then(() => [
      JSON.stringify({
        id: turn,
        msg: { type: 'warning', message: 'prefix-before-parser-error' },
      }),
      '{',
    ]);
  });
  const server = new ModelServer([[message('answer')]]);
  await using provider = await providerFor(server);
  await expect(
    new Agent({ instructions: 'Answer.', model: 'gpt-5', provider }).run(
      'Answer.',
    ),
  ).rejects.toBeInstanceOf(SyntaxError);
  expect(reads.calls).toHaveLength(1);
  expect(
    append.mock.calls.filter(
      ([event]) =>
        event.type === 'warning' &&
        event.message === 'prefix-before-parser-error',
    ),
  ).toHaveLength(1);
  reads.assertJoined();
}, 30_000);

it('preserves the exact abort reason and refuses Provider.close during an owned wait', async () => {
  const reads = await observeReads();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    async () => {
      await release.promise;
      return [message('late answer')];
    },
  ]);
  await using provider = await providerFor(server);
  const abort = new AbortController();
  const reason = Object.freeze({ caller: 'exact cancellation reason' });
  const running = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).run('Answer.', { signal: abort.signal });
  const settled = running.then(
    () => {
      throw new Error('cancelled run unexpectedly completed');
    },
    (error: unknown) => error,
  );
  try {
    await within(reads.entered.promise, 'owned native read');
    await expect(provider.close()).rejects.toThrow(
      'NativeProvider has open or opening sessions',
    );
    abort.abort(reason);
    release.resolve();
    expect(await settled).toBe(reason);
    reads.assertJoined();
  } finally {
    abort.abort(reason);
    release.resolve();
    await settled.catch(() => {});
  }
}, 30_000);

it.each([
  'maxModelSteps',
  'returnState',
  'budget',
  'onInteraction',
  'non-string input',
  'forwarded factory',
] as const)(
  'keeps the supported %s route ordinary',
  async (excluded) => {
    const reads = await observeReads();
    const server = new ModelServer([[message('answer')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    if (excluded === 'forwarded factory') ordinaryFactory(agent);
    const options =
      excluded === 'maxModelSteps'
        ? { maxModelSteps: 1 }
        : excluded === 'returnState'
          ? { returnState: true }
          : excluded === 'budget'
            ? { budget: { maxRequests: 1 } }
            : excluded === 'onInteraction'
              ? {
                  onInteraction: () => {
                    throw new Error('No interaction expected');
                  },
                }
              : {};
    const result =
      excluded === 'non-string input'
        ? await agent.run({ role: 'user', content: 'Answer.' }, options)
        : await agent.run('Answer.', options);
    expect(result.finalOutput).toBe('answer');
    expect(reads.calls).toHaveLength(0);
    server.assertExhausted();
    reads.assertJoined();
  },
  30_000,
);

it('preserves the3971 concurrency getter read and rejects invalid values before opening', async () => {
  const reads = await observeReads();
  const server = new ModelServer([[message('answer')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  });
  let getterReads = 0;
  const result = await agent.run('Answer.', {
    get maxFunctionConcurrency() {
      getterReads++;
      return 1;
    },
  });
  expect(result.finalOutput).toBe('answer');
  expect(getterReads).toBe(1);
  expect(reads.calls).toHaveLength(1);
  const factory = vi.spyOn(agent, 'session');
  await expect(
    agent.run('Answer.', { maxFunctionConcurrency: 0 }),
  ).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
  reads.assertJoined();
}, 30_000);

it('keeps managed callbacks ordinary and retains3971 concurrency through settlement', async () => {
  const reads = await observeReads();
  let active = 0,
    peak = 0,
    completed = 0;
  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const echo = tool({
    name: 'echo',
    description: 'Echo.',
    parameters: z.object({ value: z.string() }),
    execute: async ({ value }) => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (value === 'first') {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        return value;
      } finally {
        active--;
        completed++;
      }
    },
  });
  const server = new ModelServer([
    [
      call('echo', { value: 'first' }, { callId: 'first' }),
      call('echo', { value: 'second' }, { callId: 'second' }),
    ],
    [message('answer')],
  ]);
  await using provider = await providerFor(server);
  const stop = new AbortController();
  const running = new Agent({
    instructions: 'Use echo, then answer.',
    model: 'gpt-5',
    provider,
    tools: [echo],
  }).run('Answer.', { maxFunctionConcurrency: 1, signal: stop.signal });
  try {
    await within(firstEntered.promise, 'first managed callback');
    expect(active).toBe(1);
    expect(peak).toBe(1);
    releaseFirst.resolve();
    expect((await running).finalOutput).toBe('answer');
    expect(completed).toBe(2);
    expect(active).toBe(0);
    expect(peak).toBe(1);
    expect(reads.calls).toHaveLength(0);
    server.assertExhausted();
    reads.assertJoined();
  } finally {
    stop.abort(new Error('test cleanup'));
    releaseFirst.resolve();
    await running.catch(() => {});
  }
}, 30_000);

it.each(['method', 'getter'] as const)(
  'keeps actual public self-restoring provider %s acquisition ordinary',
  async (kind) => {
    const reads = await observeReads();
    const server = new ModelServer([[message('answer')]]);
    await using provider = await providerFor(server);
    const acquire = provider._acquire;
    let calls = 0,
      getterReads = 0;
    const wrapped = function (
      this: NativeProvider,
      ...args: Parameters<NativeProvider['_acquire']>
    ) {
      calls++;
      Reflect.deleteProperty(provider, '_acquire');
      return Reflect.apply(acquire, this, args);
    };
    Object.defineProperty(provider, '_acquire', {
      configurable: true,
      ...(kind === 'method'
        ? { value: wrapped }
        : {
            get() {
              getterReads++;
              Reflect.deleteProperty(provider, '_acquire');
              return wrapped;
            },
          }),
    });
    const result = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).run('Answer.');
    expect(result.finalOutput).toBe('answer');
    expect(calls).toBe(1);
    expect(getterReads).toBe(kind === 'getter' ? 1 : 0);
    expect(reads.calls).toHaveLength(0);
    server.assertExhausted();
    reads.assertJoined();
  },
  30_000,
);

it('leaves a public retained Session on the ordinary reader', async () => {
  const reads = await observeReads();
  const server = new ModelServer([[message('answer')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  expect((await (await session.submit('Answer.')).wait()).finalOutput).toBe(
    'answer',
  );
  expect(reads.calls).toHaveLength(0);
  server.assertExhausted();
  await session.close();
  reads.assertJoined();
}, 30_000);

it('preserves an observable async-factory prototype apply override on the ordinary path', async () => {
  const reads = await observeReads();
  const server = new ModelServer([[message('answer')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  });
  const prototype = Object.getPrototypeOf(Agent.prototype.session);
  const previous = Object.getOwnPropertyDescriptor(prototype, 'apply');
  const originalApply = Function.prototype.apply;
  let applyCalls = 0;
  try {
    expect(previous).toBeUndefined();
    Object.defineProperty(prototype, 'apply', {
      configurable: true,
      value: function (this: unknown, receiver: unknown, args: unknown[]) {
        applyCalls++;
        return Reflect.apply(originalApply, this, [receiver, args]);
      },
    });
    expect((await agent.run('Answer.')).finalOutput).toBe('answer');
    expect(applyCalls).toBeGreaterThan(0);
    expect(reads.calls).toHaveLength(0);
    server.assertExhausted();
    reads.assertJoined();
  } finally {
    if (previous) Object.defineProperty(prototype, 'apply', previous);
    else Reflect.deleteProperty(prototype, 'apply');
  }
}, 30_000);
