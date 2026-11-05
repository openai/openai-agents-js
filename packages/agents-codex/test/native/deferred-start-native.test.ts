import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  webSearch,
  type ActionRequested,
  type Session,
} from '../../src';
import {
  DeferredTools,
  type JobBinding,
  type JobClaim,
  type JobContext,
  type JobUpdate,
} from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { binding, type JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const PRIVATE_OPENING_ERROR = 'private opening credential and storage detail';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const gate = () => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
});

class FactoryAgent extends Agent {
  readonly receivers: FactoryAgent[] = [];
  readonly opened: Session[] = [];
  readonly restoredRequests: ActionRequested[] = [];
  holdRestore?: ReturnType<typeof gate>;
  openingDefaults?: Parameters<Agent['session']>[0];
  failRestore = false;
  #calls = 0;
  get factoryCalls() {
    return this.#calls;
  }
  override async session(...args: Parameters<Agent['session']>) {
    this.#calls++;
    this.receivers.push(this);
    const opened = await super.session({ ...this.openingDefaults, ...args[0] });
    this.opened.push(opened);
    if (args[0]?.state) {
      this.restoredRequests.push(await nextAction(opened));
      this.holdRestore?.entered.resolve();
      if (this.holdRestore) await this.holdRestore.release.promise;
      if (this.failRestore) throw new Error(PRIVATE_OPENING_ERROR);
    }
    return opened;
  }
}

async function nextAction(session: Session<unknown>): Promise<ActionRequested> {
  for await (const event of session.events())
    if (event.type === 'action_requested') return event;
  throw new Error('Expected a live deferred request');
}

async function fixture(
  options: {
    pending?: boolean;
    promptedOverride?: boolean;
    laterPlain?: boolean;
    envKey?: boolean;
    hostedSearch?: boolean;
    openingOverride?: boolean;
    perOpening?: 'overrides' | 'undefined';
    updatedModel?: boolean;
    repair?: boolean;
    repairGate?: ReturnType<typeof gate>;
    changedSession?: 'tools' | 'instructions';
  } = {},
) {
  const tool = deferredTool({
    name: 'job',
    description: 'Read one deferred result',
    schemas: (builder) => ({
      parameters: builder.strictObject({ id: builder.string() }),
      result: builder.string(),
    }),
  });
  const responses = [
    [call('job', { id: 'one' }, { callId: 'job-call' })],
    [
      message(
        options.repair
          ? '{"answer":0}'
          : options.promptedOverride
            ? '{"answer":"done"}'
            : 'done',
      ),
    ],
    ...(options.repair
      ? [
          async () => {
            options.repairGate?.entered.resolve();
            if (options.repairGate) await options.repairGate.release.promise;
            return [message('{"answer":"done"}')];
          },
        ]
      : []),
    ...(options.laterPlain ? [[message('later plain')]] : []),
  ];
  const model = new ModelServer(
    responses,
    options.repair
      ? [
          '{"input_tokens":5,"output_tokens":2,"total_tokens":7}',
          '{"input_tokens":5,"output_tokens":2,"total_tokens":7}',
          '{"input_tokens":8,"output_tokens":3,"total_tokens":11}',
        ]
      : [],
  );
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    supportsWebsockets: false,
    ...(options.envKey ? {} : { apiKey: 'synthetic-deferred-start' }),
  });
  let stateJson = '';
  let bindings: readonly JobBinding[] = [];
  const journal = {
    prepare: vi.fn(
      async (
        json: string,
        batch: readonly JobBinding[],
        _context: JobContext,
      ) => {
        stateJson = json;
        bindings = batch;
      },
    ),
    claim: vi.fn(
      async (
        binding: JobBinding,
        _operation: 'advance' | 'respond' | 'cancel',
        _context: JobContext,
      ): Promise<JobClaim> => ({
        binding,
        key: 'private-start-job-key',
        generation: '18446744073709551615',
        action: 'start',
      }),
    ),
    authorize: vi.fn(
      async (_claim: JobClaim, _action: string, _context: JobContext) => {},
    ),
    record: vi.fn(
      async (_claim: JobClaim, _update: JobUpdate, _context: JobContext) => {},
    ),
    saveResult: vi.fn(
      async (_claim: JobClaim, _json: string, _context: JobContext) => {},
    ),
  };
  const backend = {
    start: vi.fn(
      async (
        _claim: JobClaim,
        _input: { id: string },
        _context: JobContext,
      ): Promise<JobUpdate> =>
        options.pending
          ? { status: 'pending', receipt: 'private-start-receipt' }
          : {
              status: 'completed',
              receipt: 'private-start-receipt',
              value: 'safe-result',
            },
    ),
    observe: vi.fn(
      async (_claim: JobClaim, _context: JobContext): Promise<JobUpdate> => ({
        status: 'unknown',
      }),
    ),
    reconcileCreation: vi.fn(
      async (
        _claim: JobClaim,
        _input: { id: string },
        _context: JobContext,
      ): Promise<JobUpdate> => ({ status: 'unknown' }),
    ),
  };
  const jobs = new DeferredTools({ tenant: 'tenant', runId: 'run', journal });
  jobs.register(tool, {
    providerId: 'provider-job',
    provider: backend,
    project(value) {
      if (typeof value !== 'string')
        throw new TypeError('Expected string fixture result');
      return value;
    },
  });
  const defaultProvider = options.perOpening
    ? new NativeProvider({
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'unused-default',
      })
    : undefined;
  await defaultProvider?.close();
  const agent = new FactoryAgent({
    instructions: 'Use the original job declaration, then answer.',
    model: options.perOpening === 'undefined' ? undefined : 'gpt-5',
    modelSettings:
      options.perOpening === 'overrides'
        ? {
            reasoningEffort: 'low',
            reasoningSummary: 'concise',
            serviceTier: 'flex',
          }
        : undefined,
    provider: defaultProvider ?? provider,
    tools: options.openingOverride
      ? []
      : [
          tool,
          ...(options.hostedSearch
            ? [webSearch({ mode: 'cached', route: 'hosted' })]
            : []),
          ...(options.changedSession === 'tools'
            ? [
                manualTool({
                  name: 'extra',
                  description: '',
                  parameters: z.object({}),
                  result: z.string(),
                }),
              ]
            : []),
        ],
    programmaticToolCalling: false,
  });
  if (options.perOpening === 'overrides')
    agent.openingDefaults = {
      provider: defaultProvider,
      model: 'factory-default',
      modelSettings: { reasoningEffort: 'medium' },
    };
  try {
    const session = await agent.session({
      ...(options.openingOverride ? { tools: [tool] } : {}),
      ...(options.perOpening ? { provider } : {}),
      ...(options.perOpening === 'overrides'
        ? {
            model: 'gpt-5.2',
            modelSettings: Object.defineProperty(
              { reasoningEffort: undefined, serviceTier: null },
              'reasoningSummary',
              { value: 'detailed' },
            ),
          }
        : {}),
    });
    if (options.updatedModel)
      await session.update({
        model: 'gpt-5.5',
        modelSettings: {
          reasoningEffort: 'high',
          reasoningSummary: 'concise',
          serviceTier: 'priority',
        },
      });
    if (options.changedSession === 'instructions')
      await session.update({ instructions: 'Updated Session instructions.' });
    if (options.changedSession === 'tools')
      await session.update({ tools: [tool] });
    const turn = options.promptedOverride
      ? await session.submitWithOutput('ASK', {
          mode: 'prompted',
          schema: z.object({ answer: z.string() }),
          ...(options.repair ? { maxRetries: 1 } : {}),
        })
      : await session.submit('ASK');
    const completion = turn.wait().catch((error: unknown) => error);
    const request = await nextAction(session);
    return {
      jobs,
      journal,
      backend,
      model,
      provider,
      defaultProvider,
      agent,
      session,
      turn,
      request,
      completion,
      persisted: () => ({ stateJson, bindings }),
      async [Symbol.asyncDispose]() {
        agent.holdRestore?.release.resolve();
        options.repairGate?.release.resolve();
        try {
          for (const opened of agent.opened) await opened.close();
        } finally {
          await provider.close();
        }
      },
    };
  } catch (error) {
    try {
      for (const opened of agent.opened) await opened.close();
    } finally {
      await provider.close();
    }
    throw error;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'private deferred start ownership',
  () => {
    it('prepares and reopens with the original durable binding and a fresh request, then closes the borrowed Session', async () => {
      await using f = await fixture({ openingOverride: true });
      let borrowed: Session<unknown> | undefined;
      const value = await f.jobs.start(
        f.session,
        f.request,
        {},
        async ({ session, outcome }) => {
          borrowed = session;
          expect(session).not.toBe(f.session);
          expect(outcome.status).toBe('continued');
          if (outcome.status !== 'continued')
            throw new Error('Expected continuation');
          expect((await outcome.turn.wait()).finalOutput).toBe('done');
          return { application: 'value' };
        },
      );
      expect(value).toEqual({ application: 'value' });
      expect(await f.completion).toBeInstanceOf(InteractionRequired);
      const { stateJson, bindings } = f.persisted();
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        sessionId: f.request.sessionId,
        turnId: f.request.turnId,
        callId: f.request.callId,
        requestDigest: sha('{"id":"one"}'),
        checkpointDigest: sha(stateJson),
      });
      expect(f.journal.claim.mock.calls[0]![0]).toEqual(bindings[0]);
      expect(borrowed).toBeDefined();
      await expect(borrowed!.pendingInteractions()).rejects.toThrow('closed');
      await expect(
        f.session.respond(f.request.reply('stale')),
      ).rejects.toThrow();
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      expect(f.agent.restoredRequests).toHaveLength(1);
      expect(f.agent.restoredRequests[0]).not.toBe(f.request);
      expect(f.agent.restoredRequests[0]!.callId).toBe(f.request.callId);
      expect(f.agent.factoryCalls).toBe(2);
      expect(f.agent.receivers).toEqual([f.agent, f.agent]);
      f.model.assertExhausted();
    }, 20_000);

    it('closes the borrowed Session and preserves an application callback error', async () => {
      await using f = await fixture({ pending: true });
      const error = new Error('application callback failure');
      let borrowed: Session<unknown> | undefined;
      await expect(
        f.jobs.start(f.session, f.request, {}, async ({ session, outcome }) => {
          borrowed = session;
          expect(outcome).toEqual({ status: 'pending' });
          throw error;
        }),
      ).rejects.toBe(error);
      await expect(borrowed!.pendingInteractions()).rejects.toThrow('closed');
      expect(f.backend.start).toHaveBeenCalledTimes(1);
    }, 20_000);

    it('uses the captured factory, original receiver, provider and effective key despite later Agent and environment changes', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'captured-opening-key');
      await using f = await fixture({ envKey: true, hostedSearch: true });
      await using replacement = new NativeProvider({
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'replacement-key',
      });
      const acquire = vi.spyOn(replacement, '_acquire');
      const replacementFactory = vi.fn<Agent['session']>(async () => {
        throw new Error('replacement factory must not run');
      });
      f.agent.session = replacementFactory;
      f.agent.provider = replacement;
      f.agent.instructions = 'MUTATED AGENT INSTRUCTIONS';
      f.agent.model = 'mutated-model';
      f.agent.tools = [];
      f.agent.outputType = { mode: 'prompted', schema: z.string() };
      f.agent.programmaticToolCalling = true;
      vi.stubEnv('OPENAI_API_KEY', 'later-ambient-key');
      await f.jobs.start(f.session, f.request, {}, async ({ outcome }) => {
        if (outcome.status !== 'continued')
          throw new Error('Expected captured continuation');
        expect((await outcome.turn.wait()).finalOutput).toBe('done');
      });
      expect(replacementFactory).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(f.agent.factoryCalls).toBe(2);
      expect(f.agent.receivers).toEqual([f.agent, f.agent]);
      expect(
        f.model.requestHeaders.map((headers) => headers.authorization),
      ).toEqual(['Bearer captured-opening-key', 'Bearer captured-opening-key']);
      expect(JSON.stringify(f.model.requests[1])).not.toContain(
        'MUTATED AGENT INSTRUCTIONS',
      );
      expect(JSON.stringify(f.model.requests[1])).not.toContain(
        'mutated-model',
      );
      for (const request of f.model.requests) {
        const hosted = (
          (request.tools as JsonObject[] | undefined) ?? []
        ).filter((tool) => String(tool.type).startsWith('web_search'));
        expect(hosted).toHaveLength(1);
        expect(hosted[0].external_web_access).toBe(false);
      }
      f.model.assertExhausted();
    }, 20_000);

    it.each(['overrides', 'undefined'] as const)(
      'captures effective per-opening configuration through a factory and later mutations: %s',
      async (perOpening) => {
        await using f = await fixture({
          perOpening,
          hostedSearch: perOpening === 'overrides',
        });
        const fallback = vi.spyOn(f.defaultProvider!, '_acquire');
        f.agent.model = 'mutated-model';
        f.agent.modelSettings = {
          reasoningEffort:
            perOpening === 'undefined' ? 'invalid-after-capture' : 'medium',
          serviceTier: 'flex',
        };
        f.agent.openingDefaults = {
          provider: f.defaultProvider,
          model: 'mutated-factory',
          modelSettings: { reasoningEffort: 'high' },
        };
        vi.stubEnv('OPENAI_API_KEY', 'later-ambient-key');
        await f.jobs.start(f.session, f.request, {}, async ({ outcome }) => {
          if (outcome.status !== 'continued')
            throw new Error('Expected continuation');
          expect((await outcome.turn.wait()).finalOutput).toBe('done');
        });
        expect(fallback).not.toHaveBeenCalled();
        expect(f.agent.factoryCalls).toBe(2);
        expect(f.agent.receivers).toEqual([f.agent, f.agent]);
        expect(
          f.model.requestHeaders.map((headers) => headers.authorization),
        ).toEqual([
          'Bearer synthetic-deferred-start',
          'Bearer synthetic-deferred-start',
        ]);
        for (const request of f.model.requests) {
          expect(request.model).toBe(
            perOpening === 'overrides' ? 'gpt-5.2' : f.model.requests[0]!.model,
          );
          if (perOpening === 'overrides') {
            expect(request.reasoning).toEqual({
              effort: 'low',
              summary: 'detailed',
            });
            expect(request).not.toHaveProperty('service_tier');
          } else {
            expect(request.reasoning).toMatchObject(
              f.model.requests[0]!.reasoning as JsonObject,
            );
            expect(request).not.toHaveProperty('service_tier');
          }
          const hosted = (
            (request.tools as JsonObject[] | undefined) ?? []
          ).filter((tool) => String(tool.type).startsWith('web_search'));
          expect(hosted).toHaveLength(perOpening === 'overrides' ? 1 : 0);
          if (perOpening === 'overrides')
            expect(hosted[0]!.external_web_access).toBe(false);
        }
        f.model.assertExhausted();
      },
      20_000,
    );

    it('refuses start before sealing when the original opening captured no key', async () => {
      vi.stubEnv('OPENAI_API_KEY', undefined);
      const acquire = NativeProvider.prototype._acquire;
      const opening = vi
        .spyOn(NativeProvider.prototype, '_acquire')
        .mockImplementationOnce(function (this: NativeProvider, ...args) {
          const lease = acquire.apply(this, args);
          // Model a key appearing during the asynchronous original opening.
          vi.stubEnv('OPENAI_API_KEY', 'original-opening-race-key');
          return lease;
        });
      await using f = await fixture({ envKey: true });
      opening.mockRestore();
      vi.stubEnv('OPENAI_API_KEY', 'later-ambient-key');
      const callback = vi.fn(async () => 'must not run');
      await expect(
        f.jobs.start(f.session, f.request, {}, callback),
      ).rejects.toThrow();
      expect(f.journal.prepare).not.toHaveBeenCalled();
      expect(f.journal.claim).not.toHaveBeenCalled();
      expect(f.backend.start).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(f.agent.factoryCalls).toBe(1);
      await f.session.respond(f.request.reply('ordinary-safe'));
      expect((await f.turn.wait()).finalOutput).toBe('done');
      expect(
        f.model.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer original-opening-race-key',
        'Bearer original-opening-race-key',
      ]);
      f.model.assertExhausted();
    }, 20_000);

    it('closes a base-opened resource when its captured factory throws and hides private opening details', async () => {
      await using f = await fixture({ perOpening: 'overrides' });
      const fallback = vi.spyOn(f.defaultProvider!, '_acquire');
      f.agent.failRestore = true;
      const callback = vi.fn(async () => 'must not run');
      const error = await f.jobs
        .start(f.session, f.request, {}, callback)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(inspect(error)).not.toContain(PRIVATE_OPENING_ERROR);
      expect(String(error)).not.toContain(PRIVATE_OPENING_ERROR);
      expect(callback).not.toHaveBeenCalled();
      expect(f.backend.start).not.toHaveBeenCalled();
      expect(f.agent.opened).toHaveLength(2);
      await expect(f.agent.opened[1]!.pendingInteractions()).rejects.toThrow(
        'closed',
      );
      expect(f.journal.prepare).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
      await expect(f.provider.close()).rejects.toThrow('open or opening');
      await f.session.close();
      const reused = await new Agent({
        instructions: 'Reuse the selected provider.',
        provider: f.provider,
      }).session();
      await reused.close();
      await expect(f.provider.close()).resolves.toBeUndefined();
    }, 20_000);

    it.each(['tools', 'instructions'] as const)(
      'refuses changed Session %s before sealing and preserves its ordinary reply',
      async (changedSession) => {
        await using f = await fixture({ changedSession });
        const seal = vi.spyOn(
          (await binding()).NativeThread.prototype,
          '_seal_manual_checkpoint',
        );
        const callback = vi.fn(async () => 'must not run');
        await expect(
          f.jobs.start(f.session, f.request, {}, callback),
        ).rejects.toThrow();
        expect(seal).not.toHaveBeenCalled();
        expect(f.journal.prepare).not.toHaveBeenCalled();
        expect(f.backend.start).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        await f.session.respond(f.request.reply('ordinary-safe'));
        expect((await f.turn.wait()).finalOutput).toBe('done');
        f.model.assertExhausted();
      },
      20_000,
    );

    it('restores the active prompted override and returns to the original plain opening default', async () => {
      await using f = await fixture({
        promptedOverride: true,
        laterPlain: true,
        perOpening: 'overrides',
        updatedModel: true,
      });
      await f.jobs.start(
        f.session,
        f.request,
        {},
        async ({ session, outcome }) => {
          if (outcome.status !== 'continued')
            throw new Error('Expected prompted continuation');
          expect((await outcome.turn.wait()).finalOutput).toEqual({
            answer: 'done',
          });
          expect(
            (await (await session.submit('LATER')).wait()).finalOutput,
          ).toBe('later plain');
        },
      );
      expect(f.model.requests).toHaveLength(3);
      for (const request of f.model.requests) {
        expect(request.model).toBe('gpt-5.5');
        expect(request.reasoning).toEqual({
          effort: 'high',
          summary: 'concise',
        });
        expect(request.service_tier).toBe('priority');
      }
      expect(f.model.requests[2]).not.toHaveProperty('text.format');
      f.model.assertExhausted();
    }, 25_000);

    it('repairs the restored active output with captured opening authority after the setup signal is aborted in the callback', async () => {
      const held = gate();
      await using f = await fixture({
        promptedOverride: true,
        laterPlain: true,
        perOpening: 'overrides',
        updatedModel: true,
        repair: true,
        repairGate: held,
      });
      const controller = new AbortController();
      f.agent.provider = f.defaultProvider!;
      f.agent.model = 'mutated-agent';
      f.agent.modelSettings = { reasoningEffort: 'low', serviceTier: 'flex' };
      f.agent.openingDefaults = {
        provider: f.defaultProvider,
        model: 'mutated-factory',
      };
      vi.stubEnv('OPENAI_API_KEY', 'later-key');
      const fallback = vi.spyOn(f.defaultProvider!, '_acquire');
      try {
        await f.jobs.start(
          f.session,
          f.request,
          { signal: controller.signal },
          async ({ session, outcome }) => {
            if (outcome.status !== 'continued')
              throw new Error('Expected continued repair');
            await held.entered.promise;
            controller.abort();
            held.release.resolve();
            const result = await outcome.turn.wait();
            expect(result.finalOutput).toEqual({ answer: 'done' });
            expect(result.usage?.totalTokenUsage.totalTokens).toBe(14);
            expect(result.repairAttempts).toHaveLength(1);
            expect(result.repairAttempts[0]!.usage?.totalTokens).toBe(11);
            expect(result.repairAttempts[0]!.sessionId).not.toBe(session.id);
            expect(
              (await (await session.submit('LATER')).wait()).finalOutput,
            ).toBe('later plain');
          },
        );
      } finally {
        held.release.resolve();
      }
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      expect(f.journal.saveResult).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
      expect(f.model.requests).toHaveLength(4);
      for (const request of f.model.requests) {
        expect(request.model).toBe('gpt-5.5');
        expect(request.reasoning).toMatchObject({
          effort: 'high',
          summary: 'concise',
        });
        expect(request.service_tier).toBe('priority');
      }
      expect(
        f.model.requestHeaders.map((headers) => headers.authorization),
      ).toEqual(Array(4).fill('Bearer synthetic-deferred-start'));
      const correction = f.model.requests[2]!;
      expect(correction.tools).toEqual([]);
      expect(JSON.stringify(correction.input)).not.toContain('safe-result');
      expect(JSON.stringify(correction.input)).not.toContain(
        'private-start-job-key',
      );
      expect(JSON.stringify(correction.input)).not.toContain(
        'Use the original job declaration',
      );
      expect(f.model.requests[3]).not.toHaveProperty('text.format');
      f.model.assertExhausted();
    }, 25_000);

    it('joins borrowed repair cleanup before propagating a Deferred callback failure', async () => {
      const held = gate();
      const cleanup = gate();
      await using f = await fixture({
        promptedOverride: true,
        perOpening: 'overrides',
        repair: true,
        repairGate: held,
      });
      const error = new Error('application callback failure during repair');
      let settled = false;
      const operation = f.jobs
        .start(f.session, f.request, {}, async ({ session, outcome }) => {
          if (outcome.status !== 'continued')
            throw new Error('Expected active repair');
          await held.entered.promise;
          const close = session.close.bind(session);
          vi.spyOn(session, 'close').mockImplementationOnce(async () => {
            cleanup.entered.resolve();
            await cleanup.release.promise;
            return close();
          });
          throw error;
        })
        .catch((failure: unknown) => failure)
        .finally(() => {
          settled = true;
        });
      try {
        await cleanup.entered.promise;
        expect(settled).toBe(false);
        expect(f.backend.start).toHaveBeenCalledTimes(1);
        cleanup.release.resolve();
        expect(await operation).toBe(error);
        await expect(f.agent.opened[1]!.pendingInteractions()).rejects.toThrow(
          'closed',
        );
        expect(f.model.requests).toHaveLength(3);
        await f.session.close();
        await expect(f.provider.close()).resolves.toBeUndefined();
      } finally {
        cleanup.release.resolve();
        held.release.resolve();
        await operation;
      }
    }, 25_000);

    it('joins a late real opening and closes it after setup expiry without invoking provider or callback', async () => {
      await using f = await fixture({ perOpening: 'overrides' });
      const fallback = vi.spyOn(f.defaultProvider!, '_acquire');
      const held = gate();
      f.agent.holdRestore = held;
      const callback = vi.fn(async () => 'must not run');
      let settled = false;
      const operation = f.jobs
        .start(f.session, f.request, { timeoutMs: 1000 }, callback)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        await held.entered.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 1100));
        expect(settled).toBe(false);
        expect(callback).not.toHaveBeenCalled();
        expect(f.backend.start).not.toHaveBeenCalled();
      } finally {
        held.release.resolve();
      }
      expect(await operation).toMatchObject({ name: 'TimeoutError' });
      expect(fallback).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(f.backend.start).not.toHaveBeenCalled();
      await expect(f.agent.opened[1]!.pendingInteractions()).rejects.toThrow(
        'closed',
      );
      await f.session.close();
      const reused = await new Agent({
        instructions: 'Reuse the selected provider.',
        provider: f.provider,
      }).session();
      await reused.close();
      await expect(f.provider.close()).resolves.toBeUndefined();
    }, 20_000);

    it('leaves the application callback outside the setup deadline', async () => {
      await using f = await fixture({ pending: true });
      const value = await f.jobs.start(
        f.session,
        f.request,
        { timeoutMs: 1000 },
        async ({ session, outcome }) => {
          expect(outcome).toEqual({ status: 'pending' });
          await new Promise<void>((resolve) => setTimeout(resolve, 1100));
          expect(await session.pendingInteractions()).toHaveLength(1);
          return 'callback-completed';
        },
      );
      expect(value).toBe('callback-completed');
      expect(f.backend.start).toHaveBeenCalledTimes(1);
    }, 20_000);
  },
);
