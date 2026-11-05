import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  Turn,
  manualTool,
  tool,
  type Observation,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-turn-events',
    supportsWebsockets: false,
  });
}

async function collect(reader: AsyncIterable<Observation>) {
  const events: Observation[] = [];
  for await (const event of reader) events.push(event);
  return events;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('passive real-native root Turn events', () => {
  it('drains genuine terminal publication without public wait and supports independent replay', async () => {
    const native = await binding();
    const next = native.NativeThread.prototype._next_session_event;
    const terminal = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    // Delay delivery only: the terminal and its identity come from real Core.
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_event',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await next.call(this);
      const event = JSON.parse(raw);
      if (
        !held &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg?.type)
      ) {
        held = true;
        terminal.resolve();
        await release.promise;
      }
      return raw;
    });
    const wait = vi.spyOn(Turn.prototype, 'wait');
    const server = new ModelServer([[message('observed without wait')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const turn = await session.submit('A');
      let ended = false;
      const first = collect(turn.events()).then((events) => {
        ended = true;
        return events;
      });
      const sibling = collect(turn.events());
      await terminal.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ended).toBe(false);
      expect(wait).not.toHaveBeenCalled();
      release.resolve();
      const events = await first;
      expect(await sibling).toEqual(events);
      expect(events[0]).toMatchObject({
        type: 'turn_started',
        submissionId: turn.submissionId,
        turnId: turn.turnId,
      });
      expect(events.at(-1)).toMatchObject({
        type: 'turn_finished',
        status: 'completed',
        submissionId: turn.submissionId,
        turnId: turn.turnId,
      });
      expect(await collect(turn.events())).toEqual(events);
      expect(
        await collect(turn.events({ after: events[0]!.sequence })),
      ).toEqual(events.slice(1));
      expect(wait).not.toHaveBeenCalled();
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  }, 20_000);

  it('keeps a settled reader scoped to its original root while a later root is active', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [message('A')],
      async () => {
        entered.resolve();
        await release.promise;
        return [message('B')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const first = await session.submit('A');
      const original = await collect(first.events());
      const second = await session.submit('B');
      await entered.promise;
      expect(await collect(first.events())).toEqual(original);
      expect(
        await collect(first.events({ after: original.at(-1)!.sequence })),
      ).toEqual([]);
      release.resolve();
      const later = await collect(second.events());
      expect(later.at(-1)).toMatchObject({ type: 'turn_finished' });
      expect(
        later.every(
          (event) =>
            'submissionId' in event &&
            event.submissionId === second.submissionId,
        ),
      ).toBe(true);
      expect(await collect(first.events())).toEqual(original);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  }, 20_000);

  it('returns a pending reader without cancelling execution or a sibling reader', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('still completed')];
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
      const reader = turn.events();
      expect((await reader.next()).value).toMatchObject({
        type: 'turn_started',
      });
      const pending = reader.next();
      await expect(reader.next()).rejects.toThrow('pending read');
      const sibling = collect(turn.events());
      expect(await reader.return!()).toEqual({ done: true, value: undefined });
      expect(await pending).toEqual({ done: true, value: undefined });
      expect(server.requests).toHaveLength(1);
      release.resolve();
      expect((await sibling).at(-1)).toMatchObject({
        type: 'turn_finished',
        status: 'completed',
      });
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  }, 20_000);

  it.each(['cancel', 'close'] as const)(
    'ends a queued root withdrawn by %s without a fabricated native terminal',
    async (mode) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer([
        async () => {
          entered.resolve();
          await release.promise;
          return [message('active root')];
        },
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session();
      try {
        await session.submit('active');
        await entered.promise;
        const queued = await session.enqueue('never admitted');
        expect(queued.turnId).toBeNull();
        const observed = collect(queued.events());
        if (mode === 'cancel') await queued.cancel();
        else {
          const closing = session.close();
          release.resolve();
          await closing;
        }
        expect(await observed).toEqual([]);
        expect(queued.turnId).toBeNull();
        expect(server.requests).toHaveLength(1);
        release.resolve();
      } finally {
        release.resolve();
      }
    },
    20_000,
  );

  it('observes accepted steering through a real held tool without controlling the turn', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('hold', {}, { callId: 'held-tool' })],
      (request) => {
        expect(JSON.stringify(request.input)).toContain('accepted detail');
        return [message('steered result')];
      },
    ]);
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      async execute() {
        entered.resolve();
        await release.promise;
        return 'tool result';
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
      const turn = await session.submit('A');
      const observed = collect(turn.events());
      await entered.promise;
      await turn.steer('accepted detail');
      release.resolve();
      const events = await observed;
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tool_started', callId: 'held-tool' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_finished',
          callId: 'held-tool',
          status: 'completed',
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: 'turn_finished',
        status: 'completed',
      });
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  }, 20_000);

  it('rejects cursor creation and reads inside the owning tool callback', async () => {
    const deliver = Promise.withResolvers<void>();
    let checked = 0;
    let reader: AsyncIterableIterator<Observation>;
    const server = new ModelServer([
      async () => {
        await deliver.promise;
        return [call('inspect', {}, { callId: 'inspect-owner' })];
      },
      [message('callback completed')],
    ]);
    const inspect = tool({
      name: 'inspect',
      parameters: z.object({}),
      async execute(_args, context) {
        const submission = context.submission;
        if (!(submission instanceof Turn))
          throw new Error('Expected a root Turn');
        expect(() => submission.events()).toThrow('tool callback');
        await expect(reader.next()).rejects.toThrow('tool callback');
        checked++;
        return 'checked';
      },
    });
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [inspect],
    }).session();
    try {
      const turn = await session.submit('A');
      reader = turn.events();
      deliver.resolve();
      const events = await collect(turn.events());
      expect(events.at(-1)).toMatchObject({
        type: 'turn_finished',
        status: 'completed',
      });
      expect(await collect(reader)).toEqual(events);
      expect(checked).toBe(1);
      server.assertExhausted();
    } finally {
      deliver.resolve();
    }
  }, 20_000);

  it('includes owned repair attempts and waits for their cleanup without a public result waiter', async () => {
    const correctionEntered = Promise.withResolvers<void>();
    const correctionRelease = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanupRelease = Promise.withResolvers<void>();
    const server = new ModelServer([
      [message('{"label":"x"}')],
      async () => {
        correctionEntered.resolve();
        await correctionRelease.promise;
        return [message('{"label":"corrected"}')];
      },
      [message('{"label":"later root"}')],
    ]);
    await using provider = await providerFor(server);
    const acquire = provider._acquire.bind(provider);
    let acquisitions = 0;
    vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
      const lease = acquire(captured);
      if (++acquisitions !== 2) return lease;
      const release = lease.release;
      // Hold the actual correction's final lease release after native teardown.
      lease.release = async () => {
        cleanupEntered.resolve();
        await cleanupRelease.promise;
        await release();
      };
      return lease;
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string().min(2) }),
        maxRetries: 1,
      },
    }).session();
    const wait = vi.spyOn(Turn.prototype, 'wait');
    try {
      const turn = await session.submit('original root');
      let ended = false;
      const pending = collect(turn.events()).then((events) => {
        ended = true;
        return events;
      });
      await correctionEntered.promise;
      expect(ended).toBe(false);
      expect(wait).not.toHaveBeenCalled();
      correctionRelease.resolve();
      await cleanupEntered.promise;
      expect(ended).toBe(false);
      expect(wait).not.toHaveBeenCalled();
      cleanupRelease.resolve();
      const events = await pending;
      const correction = events.filter(
        (event) => event.sessionId !== session.id,
      );
      expect(correction[0]).toMatchObject({
        type: 'turn_started',
        parentSubmissionId: turn.submissionId,
      });
      expect(correction.at(-1)).toMatchObject({
        type: 'turn_finished',
        parentSubmissionId: turn.submissionId,
        status: 'completed',
      });
      expect(
        events.every(
          (event) =>
            'submissionId' in event &&
            (event.submissionId === turn.submissionId ||
              event.parentSubmissionId === turn.submissionId),
        ),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: 'turn_finished',
        submissionId: turn.submissionId,
        sessionId: session.id,
        status: 'completed',
      });
      expect(wait).not.toHaveBeenCalled();
      expect((await turn.wait()).finalOutput).toEqual({ label: 'corrected' });
      await collect((await session.submit('later root')).events());
      expect(await collect(turn.events())).toEqual(events);
      server.assertExhausted();
    } finally {
      correctionRelease.resolve();
      cleanupRelease.resolve();
    }
  }, 25_000);

  it('keeps a retired root stream open until entered repair cleanup settles', async () => {
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanupRelease = Promise.withResolvers<void>();
    const readerFailure = new Error('controlled original reader failure');
    const failReader = Promise.withResolvers<never>();
    const server = new ModelServer([
      [message('{"label":"x"}')],
      [message('{"label":"corrected"}')],
    ]);
    await using provider = await providerFor(server);
    const acquire = provider._acquire.bind(provider);
    let acquisitions = 0;
    vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
      const lease = acquire(captured);
      if (++acquisitions !== 2) return lease;
      const release = lease.release;
      lease.release = async () => {
        cleanupEntered.resolve();
        await cleanupRelease.promise;
        await release();
      };
      return lease;
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string().min(2) }),
        maxRetries: 1,
      },
    }).session();
    const native = await binding();
    const next = native.NativeThread.prototype._next_session_event;
    const originalReads = new Set<Promise<string>>();
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_event',
    ).mockImplementation(function (this: NativeThread) {
      const pending = next.call(this);
      // Fail only the original reader; the correction and its cleanup are real.
      if (this.id !== session.id) return pending;
      originalReads.add(pending);
      void pending.finally(() => originalReads.delete(pending)).catch(() => {});
      return Promise.race([pending, failReader.promise]);
    });
    try {
      const turn = await session.submit('original root');
      let ended = false;
      const pending = collect(turn.events()).then((events) => {
        ended = true;
        return events;
      });
      await cleanupEntered.promise;
      failReader.reject(readerFailure);
      await expect(turn.wait()).rejects.toBe(readerFailure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ended).toBe(false);
      cleanupRelease.resolve();
      const events = await pending;
      expect(
        events.some(
          (event) =>
            event.type === 'turn_finished' &&
            event.parentSubmissionId === turn.submissionId,
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === 'turn_finished' &&
            event.submissionId === turn.submissionId,
        ),
      ).toBe(false);
      await session.close();
      await Promise.allSettled(originalReads);
      expect(originalReads.size).toBe(0);
      server.assertExhausted();
    } finally {
      cleanupRelease.resolve();
    }
  }, 25_000);

  it('leaves live manual reply authority exclusively on the Session stream', async () => {
    const decision = manualTool({
      name: 'decision',
      description: 'Ask for a manual decision.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('decision', {}, { callId: 'decision1' })],
      [message('manual reply accepted')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [decision],
    }).session();
    const turn = await session.submit('A');
    const seen: Observation[] = [];
    let ended = false;
    const passive = (async () => {
      for await (const event of turn.events()) seen.push(event);
      ended = true;
    })();
    for await (const event of session.events()) {
      if (event.type !== 'action_requested') continue;
      expect(ended).toBe(false);
      expect(seen.every((item) => !('reply' in item))).toBe(true);
      expect(await session.submit(event.reply('approved'))).toBe(turn);
      await passive;
      expect(seen.every((item) => !('reply' in item))).toBe(true);
      expect(seen.at(-1)).toMatchObject({
        type: 'turn_finished',
        status: 'completed',
      });
      server.assertExhausted();
      return;
    }
    throw new Error('No live manual request');
  }, 20_000);
});
