import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  type ObservedEvent,
  type Session,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const report = z.object({ label: z.string().min(2) });

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-correction-cleanup-key',
    supportsWebsockets: false,
  });
}

function agentFor(provider: NativeProvider) {
  return new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
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

function recordEvents(session: Pick<Session, 'events'>) {
  const events: ObservedEvent[] = [];
  const reading = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  return { events, reading };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native correction cleanup retains original root ownership',
  () => {
    it('fences original completion, its terminal, and FIFO admission until successful correction lease release', async () => {
      const cleanupEntered = Promise.withResolvers<void>();
      const cleanupRelease = Promise.withResolvers<void>();
      const originalEntered = Promise.withResolvers<void>();
      const originalRelease = Promise.withResolvers<void>();
      const server = new ModelServer([
        async () => {
          originalEntered.resolve();
          await originalRelease.promise;
          return [message('{"label":"x"}')];
        },
        [message('{"label":"corrected"}')],
        [message('queued root complete')],
      ]);
      await using provider = await providerFor(server);
      const providerClose = vi.spyOn(provider, 'close');
      const acquire = provider._acquire.bind(provider);
      const realRelease = vi.fn<() => Promise<void>>();
      let acquisitions = 0;
      let cleanupCalls = 0;
      vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
        const lease = acquire(captured);
        if (++acquisitions !== 2) return lease;
        realRelease.mockImplementation(lease.release);
        // Inject only the correction's final provider-release boundary. Its
        // native inference, receipt collection and preceding teardown are real.
        lease.release = async () => {
          cleanupCalls++;
          cleanupEntered.resolve();
          await cleanupRelease.promise;
          await realRelease();
        };
        return lease;
      });
      const session = await agentFor(provider).session();
      const { events, reading } = recordEvents(session);
      try {
        const root = await session.submit('original root');
        await originalEntered.promise;
        const queued = await session.enqueue('queued root', {
          outputType: z.string(),
        });
        const first = root.wait();
        const second = root.wait();
        const states = [first, second].map(observe);
        originalRelease.resolve();
        await cleanupEntered.promise;
        await expect(session.saveState()).rejects.toThrow();
        expect(await session.pendingInteractions()).toEqual([]);
        expect(states.every((state) => !state.settled)).toBe(true);
        expect(queued.turnId).toBeNull();
        expect(server.requests).toHaveLength(2);
        expect(server.completedFrames).toHaveLength(2);
        expect(cleanupCalls).toBe(1);
        expect(realRelease).not.toHaveBeenCalled();
        expect(providerClose).not.toHaveBeenCalled();
        expect(
          events.some(
            (event) =>
              event.type === 'turn_finished' &&
              event.submissionId === root.submissionId,
          ),
        ).toBe(false);
        cleanupRelease.resolve();
        const [result, again] = await Promise.all([first, second]);
        expect(result).toBe(again);
        expect(result.finalOutput).toEqual({ label: 'corrected' });
        expect(result.repairAttempts).toHaveLength(1);
        expect((await queued.wait()).finalOutput).toBe('queued root complete');
        expect(cleanupCalls).toBe(1);
        expect(realRelease).toHaveBeenCalledTimes(1);
        expect(providerClose).not.toHaveBeenCalled();
        expect(server.requests).toHaveLength(3);
        await session.close();
        await reading;
        const terminals = events.filter(
          (event) => event.type === 'turn_finished',
        );
        expect(
          terminals.findIndex(
            (event) => event.submissionId === root.submissionId,
          ),
        ).toBeLessThan(
          terminals.findIndex(
            (event) => event.submissionId === queued.submissionId,
          ),
        );
        expect(
          terminals.filter((event) => event.submissionId === root.submissionId),
        ).toEqual([
          expect.objectContaining({ status: 'completed', turnId: root.turnId }),
        ]);
        expect(realRelease).toHaveBeenCalledTimes(1);
        expect(providerClose).not.toHaveBeenCalled();
        server.assertExhausted();
      } finally {
        originalRelease.resolve();
        cleanupRelease.resolve();
        await session.close();
        await reading;
      }
    }, 25000);

    it('retains failed correction close for one joined parent cleanup retry without inference replay or shared provider close', async () => {
      const firstEntered = Promise.withResolvers<void>();
      const firstRelease = Promise.withResolvers<void>();
      const retryEntered = Promise.withResolvers<void>();
      const retryRelease = Promise.withResolvers<void>();
      const originalEntered = Promise.withResolvers<void>();
      const originalRelease = Promise.withResolvers<void>();
      const cleanupFailure = new Error(
        'injected correction provider release failure',
      );
      const server = new ModelServer([
        async () => {
          originalEntered.resolve();
          await originalRelease.promise;
          return [message('{"label":"x"}')];
        },
        [message('{"label":"corrected"}')],
      ]);
      await using provider = await providerFor(server);
      const providerClose = vi.spyOn(provider, 'close');
      const acquire = provider._acquire.bind(provider);
      const realRelease = vi.fn<() => Promise<void>>();
      let acquisitions = 0;
      let cleanupCalls = 0;
      vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
        const lease = acquire(captured);
        if (++acquisitions !== 2) return lease;
        realRelease.mockImplementation(lease.release);
        // A fail-once hook preserves this actual correction Session and lease.
        // Parent.close must return to this exact unfinished release operation.
        lease.release = async () => {
          cleanupCalls++;
          if (cleanupCalls === 1) {
            firstEntered.resolve();
            await firstRelease.promise;
            throw cleanupFailure;
          }
          retryEntered.resolve();
          await retryRelease.promise;
          await realRelease();
        };
        return lease;
      });
      const session = await agentFor(provider).session();
      const { events, reading } = recordEvents(session);
      try {
        const root = await session.submit('original root');
        await originalEntered.promise;
        const queued = await session.enqueue('must never promote', {
          outputType: z.string(),
        });
        const queuedOutcome = queued.wait().catch((error: unknown) => error);
        const first = root.wait();
        const second = root.wait();
        const outcome = first.catch((error: unknown) => error);
        const states = [first, second].map(observe);
        originalRelease.resolve();
        await firstEntered.promise;
        await expect(session.saveState()).rejects.toThrow();
        expect(states.every((state) => !state.settled)).toBe(true);
        expect(queued.turnId).toBeNull();
        expect(server.completedFrames).toHaveLength(2);
        expect(server.requests).toHaveLength(2);
        expect(cleanupCalls).toBe(1);
        expect(realRelease).not.toHaveBeenCalled();
        expect(
          events.some(
            (event) =>
              event.type === 'turn_finished' &&
              event.submissionId === root.submissionId,
          ),
        ).toBe(false);
        firstRelease.resolve();
        const failure = await outcome;
        expect(failure).toBe(cleanupFailure);
        await expect(second).rejects.toBe(failure);
        await expect(root.wait()).rejects.toBe(failure);
        expect(await queuedOutcome).toBeInstanceOf(Error);
        expect(queued.turnId).toBeNull();
        expect(cleanupCalls).toBe(1);
        expect(server.requests).toHaveLength(2);
        expect(providerClose).not.toHaveBeenCalled();
        await expect(session.saveState()).rejects.toThrow();
        const closing = session.close();
        const closingState = observe(closing);
        await retryEntered.promise;
        const joined = session.close();
        const joinedState = observe(joined);
        await expect(session.submit('late root')).rejects.toThrow();
        expect(closingState.settled).toBe(false);
        expect(joinedState.settled).toBe(false);
        expect(cleanupCalls).toBe(2);
        expect(realRelease).not.toHaveBeenCalled();
        expect(server.requests).toHaveLength(2);
        expect(providerClose).not.toHaveBeenCalled();
        expect(
          events.some(
            (event) =>
              event.type === 'turn_finished' &&
              event.submissionId === root.submissionId,
          ),
        ).toBe(false);
        retryRelease.resolve();
        await Promise.all([closing, joined]);
        await reading;
        expect(cleanupCalls).toBe(2);
        expect(realRelease).toHaveBeenCalledTimes(1);
        expect(server.requests).toHaveLength(2);
        expect(providerClose).not.toHaveBeenCalled();
        await expect(root.wait()).rejects.toBe(failure);
        const probe = provider._acquire();
        await probe.release();
        server.assertExhausted();
      } finally {
        originalRelease.resolve();
        firstRelease.resolve();
        retryRelease.resolve();
        await session.close();
        await reading;
      }
    }, 25000);
  },
);
