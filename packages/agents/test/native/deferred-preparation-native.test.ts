import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  selectMcpTools,
} from '../../src';
import {
  DeferredAuthorizationError,
  DeferredTools,
  type JobBinding,
  type JobContext,
} from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { isManualSessionState } from '../../src/runtime/state';
import { Session as CoreSession } from '../../src/runtime/session';
import { BorrowedPeer } from './fixtures/borrowed-mcp';
import { ModelServer, call, message } from './fixtures/model-server';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const job = (name = 'job') =>
  deferredTool({
    name,
    description: 'Queue a job',
    schemas: (z) => ({
      parameters: z.strictObject({ id: z.string() }),
      result: z.string(),
    }),
  });
function jobs(
  prepare: (
    json: string,
    bindings: readonly JobBinding[],
    context: JobContext,
  ) => Promise<void>,
  declarations: ReturnType<typeof job>[],
) {
  const backend = {
    start: vi.fn(async () => ({ status: 'completed' as const })),
    observe: vi.fn(async () => ({ status: 'unknown' as const })),
    reconcileCreation: vi.fn(async () => ({ status: 'unknown' as const })),
  };
  const coordinator = new DeferredTools({
    tenant: 'tenant',
    runId: 'run',
    journal: {
      prepare,
      claim: vi.fn(),
      authorize: vi.fn(),
      record: vi.fn(),
      saveResult: vi.fn(),
    },
  });
  for (const declaration of declarations)
    coordinator.register(declaration, {
      providerId: `provider-${declaration.name}`,
      provider: backend,
      project: String,
    });
  return { coordinator, backend };
}
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-deferred',
    supportsWebsockets: false,
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'private deferred checkpoint preparation',
  () => {
    it.each(['accepted', 'failed', 'denied'] as const)(
      'prepares an atomic registered batch and exact prompted bytes when storage is %s',
      async (outcome) => {
        const first = job('first');
        const second = job('second');
        const ordinary = manualTool({
          name: 'ordinary',
          description: '',
          parameters: z.object({}),
          result: z.string(),
        });
        const peer = new BorrowedPeer();
        const selected = await selectMcpTools(
          { name: 'crm', server: peer },
          { context: undefined },
        );
        const model = new ModelServer([
          [
            call(
              'lookup',
              { value: 'kept' },
              { namespace: 'crm', callId: 'mcp-completed' },
            ),
            call('first', { id: 'one' }, { callId: 'first-call' }),
            call('ordinary', {}, { callId: 'ordinary-call' }),
            call('second', { id: 'two' }, { callId: 'second-call' }),
          ],
        ]);
        await using provider = await providerFor(model);
        await using session = await new Agent({
          instructions: 'Ask.',
          model: 'gpt-5',
          provider,
          programmaticToolCalling: false,
          tools: [...selected, first, ordinary, second],
          outputType: {
            mode: 'prompted',
            schema: z.object({ answer: z.string() }),
          },
        }).session();
        const turn = await session.submit('PREPARE-ONCE');
        const completion = turn.wait().catch((error: unknown) => error);
        await expect
          .poll(async () => {
            const pending = await turn.wait({ until: 'request' });
            return 'requests' in pending ? pending.requests.length : 0;
          })
          .toBe(3);
        const pending = await turn.wait({ until: 'request' });
        if (!('requests' in pending)) throw new Error('Expected all siblings');
        const request = pending.requests.find((request) =>
          first.match(request),
        )!;
        const stale = pending.requests.map((request) => request.reply('old'));
        const persist = vi.fn(
          async (
            _json: string,
            _bindings: readonly JobBinding[],
            _context: JobContext,
          ) => {
            if (outcome === 'failed') throw new Error('private storage secret');
            if (outcome === 'denied') throw new DeferredAuthorizationError();
          },
        );
        const { coordinator, backend } = jobs(persist, [first, second]);
        if (outcome === 'accepted') await coordinator.prepare(session, request);
        else
          await expect(coordinator.prepare(session, request)).rejects.toThrow(
            outcome === 'denied' ? 'denied' : 'could not be prepared',
          );
        expect(persist).toHaveBeenCalledTimes(1);
        const [exact, bindings, context] = persist.mock.calls[0]!;
        const state = await session.suspend();
        expect(JSON.stringify(state)).toBe(exact);
        if (!isManualSessionState(state) || state.format_version !== 5)
          throw new Error('Expected prompted manual state');
        expect(state.output_context.mode).toBe('prompted');
        expect(
          state.manual_continuation.pending_manual.map(
            (entry) => entry.call_id,
          ),
        ).toEqual(['first-call', 'ordinary-call', 'second-call']);
        expect(JSON.stringify(state)).toContain('mcp-completed');
        expect(JSON.stringify(state)).toContain('kept');
        expect(bindings).toEqual(
          ['first', 'second'].map((name, index) => ({
            tenant: 'tenant',
            runId: 'run',
            providerId: `provider-${name}`,
            sessionId: session.id,
            turnId: turn.turnId,
            callId: `${name}-call`,
            toolName: name,
            requestDigest: sha(
              JSON.stringify({ id: index === 0 ? 'one' : 'two' }),
            ),
            checkpointDigest: sha(exact),
          })),
        );
        expect(Object.isFrozen(bindings)).toBe(true);
        expect(bindings.every(Object.isFrozen)).toBe(true);
        expect(context.signal.aborted).toBe(false);
        for (const reply of stale)
          await expect(session.respond(reply)).rejects.toThrow();
        state.root_metadata.changed = 'detached';
        expect(JSON.stringify(await session.suspend())).toBe(exact);
        expect(await completion).toBeInstanceOf(InteractionRequired);
        expect(peer.callTool).toHaveBeenCalledTimes(1);
        for (const operation of Object.values(backend))
          expect(operation).not.toHaveBeenCalled();
        model.assertExhausted();
      },
      20_000,
    );

    it.each([
      'foreign declaration',
      'native output',
      'already aborted',
      'aborted during readiness',
    ] as const)(
      'refuses %s before commit and preserves ordinary reply authority',
      async (reason) => {
        const declaration = job();
        const model = new ModelServer([
          [call('job', { id: 'one' }, { callId: 'job-call' })],
          [message(reason === 'native output' ? '{"answer":"done"}' : 'done')],
        ]);
        await using provider = await providerFor(model);
        await using session = await new Agent({
          instructions: 'Ask.',
          model: 'gpt-5',
          provider,
          tools: [declaration],
          ...(reason === 'native output'
            ? { outputType: z.object({ answer: z.string() }) }
            : {}),
        }).session();
        const turn = await session.submit('begin');
        const batch = await turn.wait({ until: 'request' });
        if (!('requests' in batch)) throw new Error('Expected pending job');
        const persist = vi.fn(async () => {});
        const { coordinator } = jobs(persist, [
          reason === 'foreign declaration' ? job() : declaration,
        ]);
        const seal = vi.spyOn(
          (await binding()).NativeThread.prototype,
          '_seal_manual_checkpoint',
        );
        const controller = new AbortController();
        if (reason === 'already aborted') controller.abort();
        const readinessEntered = Promise.withResolvers<void>();
        const readinessRelease = Promise.withResolvers<void>();
        if (reason === 'aborted during readiness') {
          const Thread = (await binding()).NativeThread;
          const ready = Thread.prototype._manual_checkpoint_ready;
          vi.spyOn(
            Thread.prototype,
            '_manual_checkpoint_ready',
          ).mockImplementation(async function (this: NativeThread, keys) {
            readinessEntered.resolve();
            await readinessRelease.promise;
            return ready.call(this, keys);
          });
        }
        const preparing = coordinator.prepare(session, batch.requests[0], {
          signal: controller.signal,
        });
        const refused = expect(preparing).rejects.toThrow();
        if (reason === 'aborted during readiness') {
          try {
            await readinessEntered.promise;
            controller.abort();
          } finally {
            readinessRelease.resolve();
          }
        }
        await refused;
        expect(seal).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
        await session.respond(batch.requests[0].reply('ordinary response'));
        expect((await turn.wait()).finalOutput).toEqual(
          reason === 'native output' ? { answer: 'done' } : 'done',
        );
        model.assertExhausted();
      },
      15_000,
    );

    it('checks monotonic expiry before seal even when the timeout callback has not run', async () => {
      const declaration = job();
      const ordinary = manualTool({
        name: 'ordinary',
        description: '',
        parameters: z.object({}),
        result: z.string(),
      });
      const model = new ModelServer([
        [
          call('job', { id: 'one' }, { callId: 'job-call' }),
          call('ordinary', {}, { callId: 'ordinary-call' }),
        ],
        [message('both replies survived')],
      ]);
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [declaration, ordinary],
      }).session();
      const turn = await session.submit('begin');
      await expect
        .poll(async () => {
          const batch = await turn.wait({ until: 'request' });
          return 'requests' in batch ? batch.requests.length : 0;
        })
        .toBe(2);
      const batch = await turn.wait({ until: 'request' });
      if (!('requests' in batch))
        throw new Error('Expected both live requests');
      const selected = batch.requests.find((request) =>
        declaration.match(request),
      )!;
      const replies = batch.requests.map((request) =>
        request.reply('still usable'),
      );
      const Thread = (await binding()).NativeThread;
      const ready = Thread.prototype._manual_checkpoint_ready;
      let now = performance.now();
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      const readiness = vi
        .spyOn(Thread.prototype, '_manual_checkpoint_ready')
        .mockImplementation(async function (this: NativeThread, keys) {
          const result = await ready.call(this, keys);
          // Advance only the monotonic clock. No timeout callback or wall-clock wait is involved.
          if (result) now += 120_000;
          return result;
        });
      const seal = vi.spyOn(Thread.prototype, '_seal_manual_checkpoint');
      const persist = vi.fn(async () => {});
      const { coordinator } = jobs(persist, [declaration]);
      try {
        await expect(
          coordinator.prepare(session, selected, { timeoutMs: 60_000 }),
        ).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(seal).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
        readiness.mockRestore();
      }
      for (const reply of replies) await session.respond(reply);
      expect((await turn.wait()).finalOutput).toBe('both replies survived');
      model.assertExhausted();
    }, 15_000);

    it('uses a fresh bounded journal signal when the clock expires during a committed seal', async () => {
      const declaration = job();
      const model = new ModelServer([
        [call('job', { id: 'one' }, { callId: 'job-call' })],
      ]);
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [declaration],
      }).session();
      const turn = await session.submit('begin');
      const completion = turn.wait().catch((error: unknown) => error);
      const batch = await turn.wait({ until: 'request' });
      if (!('requests' in batch))
        throw new Error('Expected a live job request');
      const staleReply = batch.requests[0].reply('expired');
      let operationSignal: AbortSignal | undefined;
      const prepare = CoreSession.prototype._prepareDeferredCheckpoint;
      vi.spyOn(
        CoreSession.prototype,
        '_prepareDeferredCheckpoint',
      ).mockImplementation(function (
        this: CoreSession,
        request,
        validate,
        signal,
      ) {
        operationSignal = signal;
        return prepare.call(this, request, validate, signal);
      });
      const Thread = (await binding()).NativeThread;
      const seal = Thread.prototype._seal_manual_checkpoint;
      let now = performance.now();
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.spyOn(Thread.prototype, '_seal_manual_checkpoint').mockImplementation(
        async function (this: NativeThread, keys) {
          const result = await seal.call(this, keys);
          // The commit is real; only its elapsed-time observation is controlled.
          now += 120_000;
          return result;
        },
      );
      let storageSignal: AbortSignal | undefined;
      const persist = vi.fn(
        async (
          _json: string,
          _bindings: readonly JobBinding[],
          context: JobContext,
        ) => {
          storageSignal = context.signal;
          expect(context.signal.aborted).toBe(false);
        },
      );
      const { coordinator } = jobs(persist, [declaration]);
      try {
        await expect(
          coordinator.prepare(session, batch.requests[0], {
            timeoutMs: 60_000,
          }),
        ).rejects.toMatchObject({ name: 'TimeoutError' });
      } finally {
        clock.mockRestore();
      }
      expect(persist).toHaveBeenCalledTimes(1);
      expect(operationSignal).toBeDefined();
      expect(storageSignal).toBeDefined();
      expect(storageSignal).not.toBe(operationSignal);
      expect(JSON.stringify(await session.suspend())).toBe(
        persist.mock.calls[0]![0],
      );
      await expect(session.respond(staleReply)).rejects.toThrow();
      expect(await completion).toBeInstanceOf(InteractionRequired);
      model.assertExhausted();
    }, 15_000);

    it.each(['released', 'timed out'] as const)(
      'joins an in-progress seal and one %s journal attempt before returning cancellation',
      async (storage) => {
        const declaration = job();
        const model = new ModelServer([
          [call('job', { id: 'one' }, { callId: 'job-call' })],
        ]);
        await using provider = await providerFor(model);
        await using session = await new Agent({
          instructions: 'Ask.',
          model: 'gpt-5',
          provider,
          tools: [declaration],
        }).session();
        const turn = await session.submit('begin');
        const completion = turn.wait().catch((error: unknown) => error);
        const batch = await turn.wait({ until: 'request' });
        if (!('requests' in batch)) throw new Error('Expected pending job');
        const Thread = (await binding()).NativeThread;
        const seal = Thread.prototype._seal_manual_checkpoint;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.spyOn(
          Thread.prototype,
          '_seal_manual_checkpoint',
        ).mockImplementation(async function (this: NativeThread, keys) {
          entered.resolve();
          await release.promise;
          return seal.call(this, keys);
        });
        const journalEntered = Promise.withResolvers<void>();
        const journalRelease = Promise.withResolvers<void>();
        let storageSignal: AbortSignal | undefined;
        const persist = vi.fn(
          async (
            _json: string,
            _bindings: readonly JobBinding[],
            { signal }: JobContext,
          ) => {
            storageSignal = signal;
            journalEntered.resolve();
            await new Promise<void>((resolve) => {
              const end = () => {
                signal.removeEventListener('abort', end);
                resolve();
              };
              signal.addEventListener('abort', end, { once: true });
              void journalRelease.promise.then(end);
              if (signal.aborted) end();
            });
          },
        );
        const { coordinator, backend } = jobs(persist, [declaration]);
        const controller = new AbortController();
        let finished = false;
        const preparing = coordinator
          .prepare(session, batch.requests[0], {
            signal: controller.signal,
            timeoutMs: 1000,
          })
          .catch((error: unknown) => error)
          .finally(() => {
            finished = true;
          });
        try {
          await entered.promise;
          controller.abort();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(finished).toBe(false);
          expect(persist).not.toHaveBeenCalled();
          release.resolve();
          await journalEntered.promise;
          expect(storageSignal?.aborted).toBe(false);
          expect(finished).toBe(false);
          if (storage === 'released') journalRelease.resolve();
          expect(await preparing).toMatchObject({ name: 'AbortError' });
          expect(persist).toHaveBeenCalledTimes(1);
          expect(JSON.stringify(await session.suspend())).toBe(
            persist.mock.calls[0]![0],
          );
          await expect(
            session.respond(batch.requests[0].reply('expired')),
          ).rejects.toThrow();
          expect(await completion).toBeInstanceOf(InteractionRequired);
          for (const operation of Object.values(backend))
            expect(operation).not.toHaveBeenCalled();
          model.assertExhausted();
        } finally {
          release.resolve();
          journalRelease.resolve();
          await preparing;
        }
      },
      15_000,
    );
  },
);
