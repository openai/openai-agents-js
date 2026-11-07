import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  StaleTurnError,
  manualTool,
  tool,
  type ActionRequested,
  type Observation,
  type SubmitOptions,
  type Turn,
} from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('exact root Turn controls', () => {
  it('keeps implicit steering and prevents an old root from controlling later work', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    const server = new ModelServer([
      [message('A done')],
      [call('hold', {}, { callId: 'B-call' })],
      (request) => {
        const input = JSON.stringify(request.input);
        expect(input).toContain('implicit detail');
        expect(input).toContain('legacy detail');
        expect(input.split('exact one')).toHaveLength(2);
        expect(input.split('exact two')).toHaveLength(2);
        expect(input).not.toContain('stale detail');
        return [message('B done')];
      },
    ]);
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      async execute() {
        entered.resolve();
        await release.promise;
        effects.push('B');
        return 'recorded';
      },
    });
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [hold],
    }).session();
    try {
      const first = await session.submit('A', { ifBusy: 'steer' });
      const result = await first.wait();
      const second = await session.submit('B');
      await entered.promise;
      await expect(first.steer('stale detail')).rejects.toThrow(
        'no longer active',
      );
      await first.cancel();
      await first.cancel({ mode: 'graceful' });
      const stale: unknown = await first
        .steerExact('stale detail', second.turnId)
        .catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(StaleTurnError);
      expect(stale).toMatchObject({ effects: 'notStarted' });
      expect(await session.submit('implicit detail')).toBe(second);
      await second.steer('legacy detail');
      const firstReceipt = await second.steerExact('exact one', second.turnId);
      const secondReceipt = await second.steerExact('exact two', second.turnId);
      expect(firstReceipt).toEqual({
        sessionId: session.id,
        submissionId: second.submissionId,
        turnId: second.turnId,
        inputId: expect.any(String),
      });
      expect(secondReceipt).toMatchObject({
        turnId: second.turnId,
        inputId: expect.any(String),
      });
      expect(firstReceipt.inputId).not.toBe(secondReceipt.inputId);
      await expect(
        session.submit('rejected', { ifBusy: 'reject' }),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(2);
      expect(effects).toEqual([]);
      release.resolve();
      expect((await second.wait()).finalOutput).toBe('B done');
      expect(await first.wait()).toBe(result);
      expect(effects).toEqual(['B']);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('can cancel a settled root inside a later root callback', async () => {
    const server = new ModelServer([
      [message('A done')],
      [call('cleanup', {}, { callId: 'B-cleanup' })],
      [message('B done')],
    ]);
    const cleanup = tool({
      name: 'cleanup',
      parameters: z.object({}),
      async execute() {
        await settled.cancel();
        await settled.cancel({ mode: 'graceful' });
        return 'cleaned';
      },
    });
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [cleanup],
    }).session();
    const settled: Turn<string> = await session.submit('A');
    const first = await settled.wait();
    const second = await session.submit('B');
    expect((await second.wait()).finalOutput).toBe('B done');
    expect(await settled.wait()).toBe(first);
    server.assertExhausted();
  });

  it('waits for initial admission before the submit promise is awaited', async () => {
    const server = new ModelServer([[message('A done')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const submitted = session.submit('A');
    const result = session.wait();
    const [turn, completed] = await Promise.all([submitted, result]);
    expect(completed.finalOutput).toBe('A done');
    expect(completed.turn).toBe(turn);
    expect(await turn.wait()).toBe(completed);
    server.assertExhausted();
  });

  it('atomically starts only one competing reject submission', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('one root')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      await expect(
        // @ts-expect-error FIFO admission is outside this slice.
        session.submit('invalid option', { ifBusy: 'queue' }),
      ).rejects.toThrow('ifBusy must be steer or reject');
      const outcomes = await Promise.allSettled([
        session.submit('one', { ifBusy: 'reject' } satisfies SubmitOptions),
        session.submit('two', { ifBusy: 'reject' }),
      ]);
      expect(
        outcomes.filter((value) => value.status === 'rejected'),
      ).toHaveLength(1);
      const winner = outcomes.find((value) => value.status === 'fulfilled');
      if (!winner || winner.status !== 'fulfilled')
        throw new Error('No admitted root');
      await entered.promise;
      expect(server.requests).toHaveLength(1);
      release.resolve();
      expect((await winner.value.wait()).finalOutput).toBe('one root');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('joins repeated cancellation and holds admission through callback cleanup', async () => {
    const entered = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('hold', {}, { callId: 'hold' })],
      [message('survivor')],
    ]);
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      async execute(_args, context) {
        const own = context.submission;
        if (!('wait' in own)) throw new Error('Expected root submission');
        expect(() => own.steer('callback reentry')).toThrow();
        expect(() => own.cancel()).toThrow();
        entered.resolve();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        cleaning.resolve();
        await release.promise;
        return 'finished cleanup';
      },
    });
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [hold],
    }).session();
    try {
      const first = await session.submit('A');
      const failure = first.wait().catch((error: unknown) => error);
      await entered.promise;
      const waiter = new AbortController();
      const waitFailure = new Error('Supervisor stopped waiting');
      const passive = first.waitForAttention({ signal: waiter.signal });
      waiter.abort(waitFailure);
      await expect(passive).rejects.toBe(waitFailure);
      expect(server.requests).toHaveLength(1);
      const attention = first.waitForAttention();
      let settled = 0;
      const stopping = first.cancel().then(() => {
        settled++;
      });
      await cleaning.promise;
      const repeated = first.cancel().then(() => {
        settled++;
      });
      await expect(
        session.submit('too early', { ifBusy: 'reject' }),
      ).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(0);
      expect(server.requests).toHaveLength(1);
      release.resolve();
      await Promise.all([stopping, repeated]);
      expect(settled).toBe(2);
      expect(await failure).toBeInstanceOf(Error);
      expect(await attention).toMatchObject({
        type: 'needs_attention',
        reason: 'interrupted',
        error: await failure,
      });
      const second = await session.submit('B');
      await first.cancel();
      expect((await second.wait()).finalOutput).toBe('survivor');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('lets a graceful exact stop preserve a naturally completed response', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('natural final')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const turn = await session.submit('A');
      await entered.promise;
      const stopping = turn.cancel({ mode: 'graceful' });
      release.resolve();
      await stopping;
      expect((await turn.wait()).finalOutput).toBe('natural final');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('keeps the original handle through real native continuation requests and manual replies', async () => {
    const native = await binding();
    const nextEvent = native.NativeThread.prototype._next_session_events;
    const submit = native.NativeThread.prototype._submit;
    let originalId: string | undefined;
    const admitting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Core's terminal-to-idle tail cannot be scheduled deterministically from JS.
    // Project that hint and conditional admission only; all turns and tool grants are native.
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await nextEvent.call(this);
      const event = JSON.parse(firstNativeBatchWire(raw));
      if (
        !originalId &&
        event &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg.type)
      ) {
        originalId = event.id;
        event.sdk_unsampled_steering = true;
        return replaceSingletonNativeBatchEvent(raw, event);
      }
      return raw;
    });
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        const request = JSON.parse(raw);
        if (request.mode === 'continue_if_idle') {
          expect(request.expected_previous_turn_id).toBe(originalId);
          expect(request.input).toEqual([]);
          admitting.resolve();
          await release.promise;
          return submit.call(
            this,
            JSON.stringify({
              mode: 'start_if_idle',
              input: [
                { type: 'text', text: 'synthetic continuation admission' },
              ],
              start: request.start,
            }),
          );
        }
        return submit.call(this, raw);
      },
    );
    const decision = manualTool({
      name: 'decision',
      description: 'Ask.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [message('first native step')],
      [call('decision', {}, { callId: 'decision' })],
      [message('final native step')],
      [message('unrelated B')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    try {
      const first = await session.submit('A');
      const result = first.wait();
      const observations: Observation[] = [];
      let observerEnded = false;
      const observing = (async () => {
        for await (const event of first.events()) observations.push(event);
        observerEnded = true;
      })();
      await admitting.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observations.at(-1)).toMatchObject({
        type: 'turn_finished',
        turnId: originalId,
      });
      expect(observerEnded).toBe(false);
      const requestWait = first.waitForAttention();
      if (!originalId) throw new Error('No initial native turn ID');
      await expect(
        first.steerExact('stale native step', originalId),
      ).rejects.toBeInstanceOf(StaleTurnError);
      const steering = first.steer('captured while successor admission waits');
      release.resolve();
      await steering;
      let request: ActionRequested | undefined;
      for await (const event of session.events()) {
        if (event.type === 'action_requested') {
          request = event;
          break;
        }
      }
      if (!request) throw new Error('No manual request');
      const batch = await requestWait;
      if (!('requests' in batch))
        throw new Error('Expected the owned successor manual request');
      expect(batch.turn).toBe(first);
      expect(batch.requests).toHaveLength(1);
      expect(batch.requests[0].turnId).toBe(request.turnId);
      expect(batch.requests[0].submissionId).toBe(request.submissionId);
      expect(request.turnId).not.toBe(first.turnId);
      expect(first.turnId).toBe(originalId);
      const receipt = await first.steerExact(
        'exact continuation detail',
        request.turnId,
      );
      expect(receipt).toEqual({
        sessionId: session.id,
        submissionId: request.submissionId,
        turnId: request.turnId,
        inputId: expect.any(String),
      });
      expect(await session.submit('implicit continuation detail')).toBe(first);
      await expect(
        // @ts-expect-error Manual replies cannot carry new-submission options.
        session.submit(request.reply('yes'), {}),
      ).rejects.toThrow('only to user input');
      expect(await session.submit(request.reply('yes'))).toBe(first);
      const completed = await result;
      await observing;
      expect(
        observations
          .filter((event) => event.type === 'turn_finished')
          .map((event) => event.turnId),
      ).toEqual([first.turnId, request.turnId]);
      expect(completed.finalOutput).toBe('final native step');
      expect(completed.turn).toBe(first);
      expect(await first.wait()).toBe(completed);
      expect(await first.wait({ until: 'request' })).toBe(completed);
      expect(await session.wait()).toBe(completed);
      const second = await session.submit('B');
      expect((await second.wait()).finalOutput).toBe('unrelated B');
      expect(await first.wait()).toBe(completed);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('rejects child controls without stopping active root work', async () => {
    const executor = await startPublicExecutor();
    const rootEntered = Promise.withResolvers<void>();
    const childEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const respond = async (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id === rootId && count === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Answer.' },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      (id === rootId ? rootEntered : childEntered).resolve();
      await release.promise;
      return [message(id === rootId ? 'root survives' : 'child survives')];
    };
    const server = new ModelServer(Array.from({ length: 3 }, () => respond));
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents()],
    });
    try {
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        const root = await session.submit('A');
        await Promise.all([rootEntered.promise, childEntered.promise]);
        const children = await vi.waitFor(
          async () => {
            const children = await Array.fromAsync(session.subagents());
            expect(children[0]?.turn).toBeTruthy();
            return children;
          },
          { timeout: 5_000 },
        );
        const child = children[0]?.turn;
        if (!child) throw new Error('No live child Turn');
        await expect(child.cancel()).rejects.toThrow('root Turns only');
        await expect(child.steer('wrong scope')).rejects.toThrow(
          'root Turns only',
        );
        release.resolve();
        expect((await root.wait()).finalOutput).toBe('root survives');
        expect((await child.wait()).finalOutput).toBe('child survives');
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    } finally {
      await executor.close();
    }
  }, 20_000);
});
