import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  type ObservedEvent,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const report = z.object({ label: z.string().min(2) });

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-repair-lifecycle-key',
    supportsWebsockets: false,
  });
}

function agentFor(provider: NativeProvider) {
  return new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    outputType: { mode: 'prompted', schema: report, maxRetries: 2 },
  });
}

function observe(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'bounded native prompted-output repair lifecycle',
  () => {
    it.each([
      { stop: 'Turn.cancel', label: 'x', valid: false },
      { stop: 'Session.interrupt(root)', label: 'x', valid: false },
      { stop: 'Turn.cancel', label: 'natural valid', valid: true },
      { stop: 'Session.interrupt(root)', label: 'natural valid', valid: true },
    ])(
      'graceful $stop before repair allocation preserves valid=$valid without acquiring a correction',
      async ({ stop, label, valid }) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const server = new ModelServer([
          async () => {
            entered.resolve();
            await release.promise;
            return [message(JSON.stringify({ label }))];
          },
          // A forbidden correction gets a finite answer, so a regression fails
          // the acquisition/request assertions instead of retrying fixture 500s.
          [message('{"label":"UNWANTED_CORRECTION"}')],
        ]);
        await using provider = await providerFor(server);
        // A plain spy retains the actual method, its receiver and the real lease.
        const acquire = vi.spyOn(provider, '_acquire');
        await using session = await agentFor(provider).session();
        try {
          const root = await session.submit('original held response');
          const outcome = root.wait().then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          await entered.promise;
          expect(acquire).toHaveBeenCalledTimes(1);
          expect(server.requests).toHaveLength(1);
          const stopping =
            stop === 'Turn.cancel'
              ? root.cancel({ mode: 'graceful' })
              : session.interrupt({ scope: 'root', mode: 'graceful' });
          observe(stopping);
          const passive = observe(root.wait());
          expect(await session.pendingInteractions()).toEqual([]);
          expect(passive.settled).toBe(false);
          expect(acquire).toHaveBeenCalledTimes(1);
          release.resolve();
          await stopping;
          const completed = await outcome;
          expect(acquire).toHaveBeenCalledTimes(1);
          expect(acquire.mock.contexts).toEqual([provider]);
          expect(server.requests).toHaveLength(1);
          if (valid) {
            if (!('result' in completed))
              throw new Error('Expected a naturally valid original completion');
            expect(completed.result.finalOutput).toEqual({ label });
            expect(completed.result.repairAttempts).toEqual([]);
            expect(await root.wait()).toBe(completed.result);
          } else {
            if (!('error' in completed))
              throw new Error(
                'Expected graceful stop to prevent output repair',
              );
            expect(completed.error).toBeInstanceOf(NativeError);
            await expect(root.wait()).rejects.toBe(completed.error);
          }
          const turns = [];
          for await (const turn of session.turns()) turns.push(turn);
          expect(turns).toHaveLength(1);
          expect(turns.filter((turn) => 'parentTurnId' in turn)).toEqual([]);
          // The second scripted response is intentionally unused; closeAll still
          // verifies that the ModelServer itself had no fixture failures.
        } finally {
          release.resolve();
        }
      },
      25000,
    );

    it('retains failed correction opening cleanup for joined parent close without releasing the shared provider', async () => {
      const originalEntered = Promise.withResolvers<void>();
      const originalRelease = Promise.withResolvers<void>();
      const server = new ModelServer([
        async () => {
          originalEntered.resolve();
          await originalRelease.promise;
          return [message('{"label":"x"}')];
        },
      ]);
      await using provider = await providerFor(server);
      const providerClose = vi.spyOn(provider, 'close');
      const acquire = provider._acquire.bind(provider);
      const openingFailure = new Error(
        'injected correction lease opening failure',
      );
      const cleanupFailure = new Error(
        'injected first correction lease cleanup failure',
      );
      const cleanupEntered = Promise.withResolvers<void>();
      const cleanupRelease = Promise.withResolvers<void>();
      const released = vi.fn<() => Promise<void>>();
      let acquisitions = 0;
      let cleanups = 0;
      // Inject only the pre-Session lease boundary. The original inference and
      // the retained lease/release owner remain real native/provider work.
      vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
        const lease = acquire(captured);
        if (++acquisitions !== 2) return lease;
        released.mockImplementation(lease.release);
        lease.retainOpeningCleanup(async () => {
          cleanups++;
          if (cleanups === 1) throw cleanupFailure;
          cleanupEntered.resolve();
          await cleanupRelease.promise;
          await released();
        });
        vi.spyOn(lease, 'open').mockRejectedValue(openingFailure);
        return lease;
      });
      const session = await agentFor(provider).session();
      const events: ObservedEvent[] = [];
      const reading = (async () => {
        for await (const event of session.events()) events.push(event);
      })();
      try {
        const root = await session.submit('original');
        await originalEntered.promise;
        const queued = await session.enqueue('must not promote', {
          outputType: z.string(),
        });
        originalRelease.resolve();
        const queuedFailure = queued.wait().catch((error: unknown) => error);
        const failure = await root.wait().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toHaveProperty('cause', openingFailure);
        expect((failure as AggregateError).errors).toEqual([
          openingFailure,
          cleanupFailure,
        ]);
        await expect(root.wait()).rejects.toBe(failure);
        expect(await queuedFailure).toBeInstanceOf(Error);
        expect(queued.turnId).toBeNull();
        expect(cleanups).toBe(1);
        expect(released).not.toHaveBeenCalled();
        expect(providerClose).not.toHaveBeenCalled();
        expect(server.requests).toHaveLength(1);
        await expect(session.saveState()).rejects.toThrow();
        expect(
          events.filter((event) => event.type === 'turn_finished'),
        ).toEqual([]);

        const closing = session.close();
        const closeState = observe(closing);
        await cleanupEntered.promise;
        const repeated = session.close();
        const repeatedState = observe(repeated);
        await expect(session.submit('late')).rejects.toThrow();
        expect(closeState.settled).toBe(false);
        expect(repeatedState.settled).toBe(false);
        expect(cleanups).toBe(2);
        expect(released).not.toHaveBeenCalled();
        expect(
          events.filter((event) => event.type === 'turn_finished'),
        ).toEqual([]);
        expect(server.requests).toHaveLength(1);
        cleanupRelease.resolve();
        await Promise.all([closing, repeated]);
        await reading;
        expect(cleanups).toBe(2);
        expect(released).toHaveBeenCalledTimes(1);
        expect(providerClose).not.toHaveBeenCalled();
        expect(server.requests).toHaveLength(1);
        // A new real lease proves parent.close did not close the borrowed provider.
        const probe = provider._acquire();
        await probe.release();
        server.assertExhausted();
      } finally {
        originalRelease.resolve();
        cleanupRelease.resolve();
        await session.close();
        await reading;
      }
    }, 25000);

    it.each(['force', 'graceful', 'close'] as const)(
      '%s during correction opening joins the lease and submits no correction',
      async (action) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const server = new ModelServer([[message('{"label":"x"}')]]);
        await using provider = await providerFor(server);
        const acquire = provider._acquire.bind(provider);
        let acquisitions = 0;
        const correctionRelease = vi.fn<() => Promise<void>>();
        // Hold the real second lease before its native Session can open. This
        // injected owner boundary does not replace inference or public results.
        vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
          const lease = acquire(captured);
          if (++acquisitions !== 2) return lease;
          const open = lease.open.bind(lease);
          correctionRelease.mockImplementation(lease.release);
          lease.release = correctionRelease;
          lease.open = async () => {
            entered.resolve();
            await release.promise;
            return open();
          };
          return lease;
        });
        await using session = await agentFor(provider).session();
        try {
          const root = await session.submit('original');
          await entered.promise;
          const outcome = root.wait().catch((error: unknown) => error);
          const passive = observe(root.wait());
          const stopping =
            action === 'close'
              ? session.close()
              : root.cancel({ mode: action });
          const stopState = observe(stopping);
          if (action === 'close') {
            await expect(session.pendingInteractions()).rejects.toThrow();
          } else {
            expect(await session.pendingInteractions()).toEqual([]);
          }
          expect(passive.settled).toBe(false);
          expect(stopState.settled).toBe(false);
          expect(correctionRelease).not.toHaveBeenCalled();
          expect(server.requests).toHaveLength(1);
          release.resolve();
          await stopping;
          const error = await outcome;
          expect(error).toBeInstanceOf(Error);
          await expect(root.wait()).rejects.toBe(error);
          expect(correctionRelease).toHaveBeenCalledTimes(1);
          expect(server.requests).toHaveLength(1);
          server.assertExhausted();
        } finally {
          release.resolve();
        }
      },
      25000,
    );

    it('keeps repeated waits passive and FIFO roots queued while correction inference is held', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer([
        [message('{"label":"x"}')],
        async () => {
          entered.resolve();
          await release.promise;
          return [message('{"label":"corrected"}')];
        },
        [message('queued plain root')],
      ]);
      await using provider = await providerFor(server);
      await using session = await agentFor(provider).session();
      try {
        const root = await session.submit('original');
        await entered.promise;
        const first = root.wait();
        const second = root.wait();
        const sessionWait = session.wait();
        const states = [first, second, sessionWait].map(observe);
        const queued = await session.enqueue('queued', {
          outputType: z.string(),
        });
        await expect(session.saveState()).rejects.toThrow();
        expect(await session.pendingInteractions()).toEqual([]);
        expect(states.every((state) => !state.settled)).toBe(true);
        expect(queued.turnId).toBeNull();
        expect(server.requests).toHaveLength(2);
        release.resolve();
        const [result, again, fromSession] = await Promise.all([
          first,
          second,
          sessionWait,
        ]);
        expect(result).toBe(again);
        expect(fromSession).toBe(result);
        expect(result.finalOutput).toEqual({ label: 'corrected' });
        expect(result.repairAttempts).toHaveLength(1);
        expect((await queued.wait()).finalOutput).toBe('queued plain root');
        expect(await root.wait()).toBe(result);
        expect(server.requests).toHaveLength(3);
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    }, 25000);

    it.each(['cancel', 'close'] as const)(
      'force %s during a confirmed correction request prevents another attempt',
      async (action) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const server = new ModelServer([
          [message('{"label":"x"}')],
          async () => {
            entered.resolve();
            await release.promise;
            return [message('{"label":"y"}')];
          },
        ]);
        await using provider = await providerFor(server);
        await using session = await agentFor(provider).session();
        try {
          const root = await session.submit('original');
          await entered.promise;
          const outcome = root.wait().catch((error: unknown) => error);
          const stopping =
            action === 'cancel'
              ? root.cancel({ mode: 'force' })
              : session.close();
          // The exact stop is initiated while the request is held. Releasing
          // the fixture lets transport teardown finish without a server leak.
          release.resolve();
          await stopping;
          const error = await outcome;
          expect(error).toBeInstanceOf(Error);
          await expect(root.wait()).rejects.toBe(error);
          expect(server.requests).toHaveLength(2);
          server.assertExhausted();
        } finally {
          release.resolve();
        }
      },
      25000,
    );

    it.each([
      { label: 'corrected', succeeds: true },
      { label: 'y', succeeds: false },
    ])(
      'graceful stop accepts current correction label=$label and prevents another attempt',
      async ({ label, succeeds }) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const server = new ModelServer([
          [message('{"label":"x"}')],
          async () => {
            entered.resolve();
            await release.promise;
            return [message(JSON.stringify({ label }))];
          },
        ]);
        await using provider = await providerFor(server);
        await using session = await agentFor(provider).session();
        try {
          const root = await session.submit('original');
          await entered.promise;
          const outcome = root.wait().then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          const stopping = root.cancel({ mode: 'graceful' });
          observe(stopping);
          release.resolve();
          await stopping;
          const completed = await outcome;
          if (succeeds) {
            expect(completed).toHaveProperty('result.finalOutput', { label });
            if (!('result' in completed))
              throw new Error('Expected current correction to complete');
            expect(completed.result.repairAttempts).toHaveLength(1);
            expect(await root.wait()).toBe(completed.result);
          } else {
            if (!('error' in completed))
              throw new Error(
                'Expected graceful stop to prevent another repair',
              );
            expect(completed.error).toBeInstanceOf(Error);
            await expect(root.wait()).rejects.toBe(completed.error);
          }
          expect(server.requests).toHaveLength(2);
          server.assertExhausted();
        } finally {
          release.resolve();
        }
      },
      25000,
    );
  },
);
