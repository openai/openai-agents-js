import OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
  OpenAIDecisions,
  tool,
  type BoundDecide,
  type DecisionProvider,
  type TokenUsage,
} from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());
const usage: TokenUsage = {
  inputTokens: 7,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 3,
  reasoningOutputTokens: 0,
  totalTokens: 10,
};
const wireUsage = (total: number) =>
  JSON.stringify({
    input_tokens: total,
    output_tokens: 0,
    total_tokens: total,
  });
async function providerFor(server: ModelServer) {
  const config = await server.config();
  const baseUrl = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  return new NativeProvider({
    baseUrl,
    apiKey: 'synthetic-decisions',
    supportsWebsockets: false,
  });
}
function decisionProvider(value = true): DecisionProvider {
  return {
    getDecision: vi.fn(async () => ({
      value: { response: value },
      usage,
      requestId: 'physical-decision',
      model: 'resolved-decision',
    })),
  };
}
function decisionReply(request: JsonObject, probability: number) {
  expect(request.model).toBe('gpt-6-luna');
  const questions = request.questions as JsonObject[];
  expect(questions).toHaveLength(1);
  expect(questions[0].type).toBe('predicate');
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'decision-http',
    },
    body: JSON.stringify({
      model: 'resolved-decision',
      answers: questions.map((question) => ({
        name: question.name,
        type: question.type,
        probability,
      })),
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }),
  };
}

nativeIt(
  'checks repaired prompted output through the original completion hook',
  async () => {
    const checked: string[] = [];
    const server = new ModelServer([
      [message('invalid JSON')],
      [message('{"label":"unchecked"}')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 1,
      },
      beforeComplete(context) {
        checked.push(context.text!);
        if (context.text!.includes('unchecked'))
          throw new Error('Rejected repaired candidate');
      },
    });
    await expect(agent.run('Return the report.')).rejects.toThrow(
      'Rejected repaired candidate',
    );
    expect(checked).toEqual(['invalid JSON', '{"label":"unchecked"}']);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'continues the original turn after a repaired proposal and expires prior helpers',
  async () => {
    const checked: {
      text: string | null;
      turn: string;
      session: string;
      count: number;
    }[] = [];
    const rootProvider = decisionProvider(false);
    const override = decisionProvider(true);
    let previous: BoundDecide | undefined;
    const applicationContext = { owner: 'original context' };
    const server = new ModelServer(
      [
        [message('invalid JSON')],
        [message('{"label":"blocked"}')],
        [message('{"label":"accepted"}')],
      ],
      [wireUsage(14), wireUsage(14), wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent<{ owner: string }, { label: string }>({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      decisions: rootProvider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 1,
      },
      beforeComplete: async (context) => {
        expect(context.context).toBe(applicationContext);
        expect(context.model).toBe('gpt-5.5');
        expect(context.subagentId).toBeUndefined();
        if (previous)
          await expect(
            previous('Expired?', { input: 'Explicit input.' }),
          ).rejects.toThrow(/no longer|abort/i);
        previous = context.decide;
        checked.push({
          text: context.text,
          turn: context.turnId,
          session: context.sessionId,
          count: context.continuationCount,
        });
        expect(
          await context.decide('Approved?', { input: context.text! }),
        ).toBe(true);
        if (context.text!.includes('blocked'))
          return {
            action: 'continue',
            instructions: 'Produce an accepted report.',
          };
      },
    });
    const result = await agent.run('Return a report.', {
      context: applicationContext,
      decisions: override,
    });
    expect(result.finalOutput).toEqual({ label: 'accepted' });
    expect(checked.map((value) => value.text)).toEqual([
      'invalid JSON',
      '{"label":"blocked"}',
      '{"label":"accepted"}',
    ]);
    expect(checked.map((value) => value.count)).toEqual([0, 0, 1]);
    expect(new Set(checked.map((value) => value.turn)).size).toBe(1);
    expect(new Set(checked.map((value) => value.session)).size).toBe(1);
    expect(rootProvider.getDecision).not.toHaveBeenCalled();
    expect(override.getDecision).toHaveBeenCalledTimes(3);
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(58);
    expect(result.repairAttempts).toHaveLength(1);
    expect(result.repairAttempts[0].usage?.totalTokens).toBe(14);
    server.assertExhausted();
  },
  30000,
);

nativeIt.each(['missing', 'blank'] as const)(
  'checks a repaired %s completion candidate',
  async (kind) => {
    const checked: (string | null)[] = [];
    const server = new ModelServer([
      [message('')],
      [message('{"label":"accepted"}')],
    ]);
    const native = await binding();
    const next = native.NativeThread.prototype._next_session_events;
    const spy =
      kind === 'missing'
        ? vi
            .spyOn(native.NativeThread.prototype, '_next_session_events')
            .mockImplementation(async function (this: NativeThread) {
              return (await next.call(this)).map((wire) => {
                const event = JSON.parse(wire);
                if (event.msg.type === '_sdk_before_complete')
                  event.msg.text = null;
                return JSON.stringify(event);
              });
            })
        : undefined;
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 1,
      },
      beforeComplete: (context) => {
        checked.push(context.text);
      },
    });
    try {
      const result = await agent.run('Return the report.');
      expect(result.finalOutput).toEqual({ label: 'accepted' });
      expect(checked).toHaveLength(2);
      expect([null, '']).toContain(checked[0]);
      expect(checked[1]).toBe('{"label":"accepted"}');
      server.assertExhausted();
    } finally {
      spy?.mockRestore();
    }
  },
  30000,
);

nativeIt(
  'checks each malformed correction before the next repair',
  async () => {
    const checked: (string | null)[] = [];
    const server = new ModelServer([
      [message('initial invalid')],
      [message('still invalid')],
      [message('{"label":"accepted"}')],
    ]);
    await using provider = await providerFor(server);
    const result = await new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 2,
      },
      beforeComplete: (context) => {
        checked.push(context.text);
      },
    }).run('Return the report.');
    expect(checked).toEqual([
      'initial invalid',
      'still invalid',
      '{"label":"accepted"}',
    ]);
    expect(result.finalOutput).toEqual({ label: 'accepted' });
    expect(result.repairAttempts).toHaveLength(2);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'closes a repaired decision provider after abort and retains its root usage once',
  async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const decisions: DecisionProvider = {
      getDecision: vi.fn(async (_request, { signal }) => {
        if (signal!.aborted) aborted.resolve();
        else
          signal!.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
        entered.resolve();
        await aborted.promise;
        await release.promise;
        return {
          value: { response: true },
          usage,
          requestId: 'late-repaired-check',
        };
      }),
    };
    const server = new ModelServer(
      [[message('initial invalid')], [message('{"label":"accepted"}')]],
      [wireUsage(14), wireUsage(14)],
    );
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      decisions,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 1,
      },
      beforeComplete: async (context) => {
        if (context.text?.includes('accepted'))
          await context.decide('Approved?', { input: context.text });
      },
    }).session();
    const turn = await session.submit('Return the report.');
    const result = turn.wait();
    void result.catch(() => {});
    const usageEvents: TokenUsage['totalTokens'][] = [];
    const observation = (async () => {
      for await (const event of turn.events())
        if (event.type === 'usage_updated' && event.usage)
          usageEvents.push(event.usage.totalTokenUsage.totalTokens);
    })();
    void observation.catch(() => {});
    const watchdog = setTimeout(() => {
      entered.reject(new Error('Repaired decision was not entered'));
      aborted.reject(new Error('Repaired decision was not aborted'));
      release.resolve();
    }, 20000);
    try {
      await entered.promise;
      let closed = false;
      const closing = session.close().then(() => {
        closed = true;
      });
      await aborted.promise;
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      await expect(result).rejects.toThrow();
      await observation;
      expect(usageEvents.at(-1)).toBe(24);
      expect(decisions.getDecision).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    } finally {
      clearTimeout(watchdog);
      release.resolve();
    }
  },
  40000,
);

nativeIt.each([
  ['force', 'correction'],
  ['force', 'repaired hook'],
  ['graceful', 'correction'],
  ['graceful', 'repaired hook'],
] as const)(
  'joins %s cancellation during a %s without another model admission',
  async (mode, stage) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [message('initial invalid')],
      async () => {
        if (stage === 'correction') {
          entered.resolve();
          await release.promise;
        }
        return [message('{"label":"blocked"}')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 2,
      },
      beforeComplete: async (context) => {
        if (context.text?.includes('blocked')) {
          if (stage === 'repaired hook') {
            entered.resolve();
            await release.promise;
          }
          return { action: 'continue', instructions: 'Try another report.' };
        }
      },
    }).session();
    const turn = await session.submit('Return the report.');
    const result = turn.wait();
    void result.catch(() => {});
    const watchdog = setTimeout(() => {
      entered.reject(new Error('Repair cancellation stage was not entered'));
      release.resolve();
    }, 20000);
    try {
      await entered.promise;
      const stopping = turn.cancel({ mode });
      release.resolve();
      await stopping;
      const error = await result.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(
        /completion callback failed|Output repair stopped/i,
      );
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    } finally {
      clearTimeout(watchdog);
      release.resolve();
    }
  },
  40000,
);

nativeIt(
  'revokes the exact completion delivery and joins its pending correction',
  async () => {
    const native = await binding();
    const prototype = native.NativeThread.prototype;
    const next = prototype._next_session_events;
    const reply = prototype._reply_natural_completion;
    const close = prototype._close_report;
    const correcting = Promise.withResolvers<void>();
    const releaseServer = Promise.withResolvers<void>();
    const injected = Promise.withResolvers<string>();
    const correctionClosed = Promise.withResolvers<void>();
    void correctionClosed.promise.catch(() => {});
    const root: { id?: string } = {};
    let completion: { id: string; msg: JsonObject } | undefined;
    let pendingRead: Promise<string[]> | undefined;
    let injectedOnce = false,
      revoked = false,
      holdReply = true;
    let deferredReply: { thread: NativeThread; wire: string } | undefined;
    // Preserve the one physical reader when injecting a delivery-only cancellation.
    const readSpy = vi
      .spyOn(prototype, '_next_session_events')
      .mockImplementation(function (this: NativeThread) {
        const read = () =>
          next.call(this).then((batch) => {
            for (const wire of batch) {
              const event = JSON.parse(wire) as { id: string; msg: JsonObject };
              if (
                this.id === root.id &&
                event.msg.type === '_sdk_before_complete'
              )
                completion = event;
            }
            return batch;
          });
        if (this.id !== root.id) return read();
        pendingRead ??= read();
        const current = pendingRead;
        const physical = current.then((batch) => {
          if (pendingRead === current) pendingRead = undefined;
          return batch;
        });
        return injectedOnce
          ? physical
          : Promise.race([
              physical,
              injected.promise.then((wire) => {
                injectedOnce = true;
                return [wire];
              }),
            ]);
      });
    const replySpy = vi
      .spyOn(prototype, '_reply_natural_completion')
      .mockImplementation(function (this: NativeThread, wire) {
        // Keep the original native task alive: its cancellation cannot mask whether
        // the delivery's own signal stops the separate correction task.
        if (this.id === root.id && revoked && holdReply)
          deferredReply = { thread: this, wire };
        else reply.call(this, wire);
      });
    const closeSpy = vi
      .spyOn(prototype, '_close_report')
      .mockImplementation(async function (this: NativeThread) {
        const result = await close.call(this);
        if (revoked && this.id !== root.id) correctionClosed.resolve();
        return result;
      });
    const server = new ModelServer([
      [message('initial invalid')],
      async () => {
        correcting.resolve();
        await releaseServer.promise;
        return [message('{"label":"unchecked"}')];
      },
    ]);
    await using provider = await providerFor(server);
    const checked: (string | null)[] = [];
    await using session = await new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 2,
      },
      beforeComplete(context) {
        checked.push(context.text);
      },
    }).session();
    root.id = session.id;
    const turn = await session.submit('Return the report.');
    const result = turn.wait();
    void result.catch(() => {});
    const watchdog = setTimeout(() => {
      correcting.reject(new Error('Correction was not entered'));
      correctionClosed.reject(
        new Error('Delivery cancellation did not close correction'),
      );
      releaseServer.resolve();
    }, 20000);
    try {
      await correcting.promise;
      expect(completion).toBeDefined();
      revoked = true;
      injected.resolve(
        JSON.stringify({
          id: completion!.id,
          msg: {
            type: '_sdk_callback_cancel',
            receipt: completion!.msg._sdk_callback,
          },
        }),
      );
      await correctionClosed.promise;
      expect(deferredReply).toBeDefined();
      expect(checked).toEqual(['initial invalid']);
      expect(server.requests).toHaveLength(2);
      holdReply = false;
      reply.call(deferredReply!.thread, deferredReply!.wire);
      deferredReply = undefined;
      await expect(result).rejects.toThrow();
      server.assertExhausted();
    } finally {
      clearTimeout(watchdog);
      holdReply = false;
      if (deferredReply) {
        try {
          reply.call(deferredReply.thread, deferredReply.wire);
        } catch {
          // Native cancellation may already have retired this exact receipt.
        }
      }
      releaseServer.resolve();
      await session.close();
      readSpy.mockRestore();
      replySpy.mockRestore();
      closeSpy.mockRestore();
    }
  },
  40000,
);

nativeIt(
  'closes an opened correction after graceful stop before repair admission',
  async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const server = new ModelServer([[message('initial invalid')]]);
    await using provider = await providerFor(server);
    const acquire = provider._acquire.bind(provider);
    let acquisitions = 0;
    const correctionReleased = vi.fn<() => Promise<void>>();
    const spy = vi
      .spyOn(provider, '_acquire')
      .mockImplementation((captured) => {
        const lease = acquire(captured);
        if (++acquisitions !== 2) return lease;
        const open = lease.open.bind(lease);
        correctionReleased.mockImplementation(lease.release);
        lease.release = correctionReleased;
        lease.open = async () => {
          entered.resolve();
          await release.promise;
          return open();
        };
        return lease;
      });
    await using session = await new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 1,
      },
      beforeComplete: () => {},
    }).session();
    const turn = await session.submit('Return the report.');
    const result = turn.wait();
    void result.catch(() => {});
    const watchdog = setTimeout(() => {
      entered.reject(new Error('Correction opening was not entered'));
      release.resolve();
    }, 20000);
    try {
      await entered.promise;
      const stopping = turn.cancel({ mode: 'graceful' });
      expect(correctionReleased).not.toHaveBeenCalled();
      release.resolve();
      await stopping;
      await expect(result).rejects.toThrow(/stopped|interrupt|cancel/i);
      expect(correctionReleased).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    } finally {
      clearTimeout(watchdog);
      release.resolve();
      spy.mockRestore();
    }
  },
  30000,
);

nativeIt.each([false, true] as const)(
  'keeps Decisions upstream request identity separate from body response identity (%s)',
  async (withRequestId) => {
    const server = new ModelServer(
      [
        [message('candidate')],
        (request) => {
          const response = decisionReply(request, 0.75);
          if (!withRequestId)
            delete (response.headers as Record<string, string>)['x-request-id'];
          return response;
        },
      ],
      [wireUsage(14)],
    );
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      decisions: new OpenAIDecisions({
        client: new OpenAI({ apiKey: 'synthetic', baseURL, maxRetries: 0 }),
      }),
      beforeComplete: async (context) => {
        expect(await context.decide('Ready?', { input: context.text! })).toBe(
          true,
        );
      },
    }).session();
    const result = await (await session.submit('Answer.')).wait();
    expect(result.finalOutput).toBe('candidate');
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(24);
    const turns = [];
    for await (const turn of session.turns()) turns.push(turn);
    expect(turns).toHaveLength(1);
    const responses = turns[0].responses ?? [];
    expect(responses).toHaveLength(2);
    const ordinary = responses.find((row) => row.responseId === 'response-1')!;
    const decision = responses.find((row) => row !== ordinary)!;
    expect(ordinary.responseId).toBe('response-1');
    expect(ordinary).not.toHaveProperty('upstreamRequestId');
    expect(decision.responseId).toBeNull();
    if (withRequestId)
      expect(decision).toHaveProperty('upstreamRequestId', 'decision-http');
    else expect(decision).not.toHaveProperty('upstreamRequestId');
    expect(decision.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(new Set(responses.map((row) => row.id)).size).toBe(2);
    server.assertExhausted();
  },
  30000,
);

nativeIt.each([false, true] as const)(
  'checks repaired output using the active profile and explicit override (%s)',
  async (outputOverride) => {
    const rootDecision = decisionProvider(false),
      targetDecision = decisionProvider(true);
    const checked: string[] = [];
    const server = new ModelServer(
      [
        [call('transfer_to_b', {}, { callId: 'handoff' })],
        [message('target invalid')],
        (request) => {
          const input = JSON.stringify(request.input);
          expect(input).toContain(
            outputOverride ? 'override_value' : 'target_value',
          );
          expect(input).not.toContain('Root-only instructions.');
          return [
            message(
              JSON.stringify(
                outputOverride
                  ? { override_value: 'accepted' }
                  : { target_value: 'accepted' },
              ),
            ),
          ];
        },
      ],
      [wireUsage(14), wireUsage(14), wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const destination = new Agent({
      name: 'B',
      instructions: 'Return the target report.',
      model: 'gpt-5.5',
      provider,
      decisions: targetDecision,
      outputType: {
        mode: 'prompted',
        schema: z.object({ target_value: z.string() }),
        maxRetries: 1,
      },
      beforeComplete: async (context) => {
        checked.push(context.text!);
        expect(
          await context.decide('Approved?', { input: context.text! }),
        ).toBe(true);
      },
    });
    const agent = new Agent({
      instructions: 'Root-only instructions.',
      model: 'gpt-5.5',
      provider,
      decisions: rootDecision,
      outputType: {
        mode: 'prompted',
        schema: z.object({ target_value: z.string() }),
        maxRetries: 0,
      },
      beforeComplete: () => {
        throw new Error('Wrong completion owner');
      },
      handoffs: [destination],
    });
    await using session = await agent.session();
    const result = outputOverride
      ? await (
          await session.submit('Return a report.', {
            outputType: {
              mode: 'prompted',
              schema: z.object({ override_value: z.string() }),
              maxRetries: 1,
            },
          })
        ).wait()
      : await (await session.submit('Return a report.')).wait();
    expect(result.finalOutput).toEqual(
      outputOverride
        ? { override_value: 'accepted' }
        : { target_value: 'accepted' },
    );
    expect(checked).toHaveLength(2);
    expect(rootDecision.getDecision).not.toHaveBeenCalled();
    expect(targetDecision.getDecision).toHaveBeenCalledTimes(2);
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(48);
    expect(result.repairAttempts).toHaveLength(1);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'bounds formatting repair across original completion continuations',
  async () => {
    const checked: string[] = [];
    const server = new ModelServer([
      [message('initial invalid')],
      [message('{"label":"blocked"}')],
      [message('next invalid')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Return the report.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries: 1,
      },
      beforeComplete: (context) => {
        checked.push(context.text!);
        if (context.text!.includes('blocked'))
          return { action: 'continue', instructions: 'Try another report.' };
      },
    });
    await expect(agent.run('Return the report.')).rejects.toThrow(
      /output|valid|JSON/i,
    );
    expect(checked).toEqual([
      'initial invalid',
      '{"label":"blocked"}',
      'next invalid',
    ]);
    server.assertExhausted();
  },
  30000,
);

nativeIt.each([false, true] as const)(
  'decides a mixed boolean/string choice without fallback (%s)',
  async (selected) => {
    const paths: string[] = [];
    const server = new ModelServer([
      (request) => {
        expect(request.model).toBe('gpt-6-luna');
        const questions = request.questions as JsonObject[];
        expect(questions).toHaveLength(1);
        const question = questions[0];
        expect(question.type).toBe('choice');
        const choices = question.choices as JsonObject[];
        expect(
          choices.map((choice) => JSON.parse(choice.description as string)),
        ).toEqual([selected, 'unknown']);
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'resolved-decision',
            usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
            answers: [
              {
                type: 'choice',
                name: question.name,
                choice: choices[0].value,
                confidence: 1,
                probabilities: choices.map((choice, index) => ({
                  value: choice.value,
                  probability: index === 0 ? 1 : 0,
                })),
              },
            ],
          }),
        };
      },
    ]);
    server.onRecord = (phase, detail) => {
      if (phase === 'MODEL_REQUEST')
        paths.push((detail as { path: string }).path);
    };
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    const decisions = new OpenAIDecisions({
      client: new OpenAI({ apiKey: 'synthetic', baseURL, maxRetries: 0 }),
    });
    const result = await new Agent({
      instructions: 'Answer.',
      decisions,
    }).decide('Is the request ready?', {
      input: 'Explicit request.',
      choices: [selected, 'unknown'] as const,
    });
    expect(result).toBe(selected);
    expect(paths).toEqual(['/v1/decisions']);
    server.assertExhausted();
  },
);

nativeIt(
  'continues one turn through completion decisions with native accounting and the real shared compiler',
  async () => {
    const paths: string[] = [],
      counts: number[] = [],
      turns: string[] = [];
    let retained: BoundDecide | undefined;
    const server = new ModelServer(
      [
        [message('An explanation.')],
        (request) => decisionReply(request, 0.25),
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'Give one concrete next step.',
          );
          return [message('Open your account settings.')];
        },
        (request) => decisionReply(request, 0.75),
      ],
      [wireUsage(14), () => undefined, wireUsage(14)],
    );
    server.onRecord = (phase, detail) => {
      if (phase === 'MODEL_REQUEST')
        paths.push((detail as { path: string }).path);
    };
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Answer the customer.',
      decisions: new OpenAIDecisions({
        client: new OpenAI({ apiKey: 'synthetic', baseURL, maxRetries: 0 }),
      }),
      beforeComplete: async (context) => {
        counts.push(context.continuationCount);
        turns.push(context.turnId);
        retained = context.decide;
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.subagentId).toBeUndefined();
        const clear = await context.decide(
          'Does the customer have a clear next step?',
          { input: context.text! },
        );
        if (!clear)
          return {
            action: 'continue',
            instructions: 'Give one concrete next step.',
          };
      },
    });
    const result = await agent.run('Help with my account.');
    expect(result.finalOutput).toBe('Open your account settings.');
    expect(counts).toEqual([0, 1]);
    expect(new Set(turns).size).toBe(1);
    expect(paths).toEqual([
      '/v1/responses',
      '/v1/decisions',
      '/v1/responses',
      '/v1/decisions',
    ]);
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(48);
    expect(result.threadUsage?.lastTokenUsage.totalTokens).toBe(14);
    await expect(retained!('Expired?', { input: 'Explicit.' })).rejects.toThrow(
      /no longer active|abort/i,
    );
    server.assertExhausted();
  },
  30000,
);

nativeIt.each(['root', 'target', 'opening'] as const)(
  'keeps provider precedence across an active handoff (%s)',
  async (mode) => {
    const root = decisionProvider(false),
      target = decisionProvider(true),
      opening = decisionProvider(true);
    const server = new ModelServer(
      [[call('transfer_to_b', {}, { callId: 'handoff' })], [message('done')]],
      [wireUsage(14), wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const destination = new Agent({
      name: 'B',
      instructions: 'Finish.',
      ...(mode !== 'root' ? { decisions: target } : {}),
    });
    const agent = new Agent({
      model: 'gpt-5.5',
      name: 'A',
      instructions: 'Transfer.',
      provider,
      decisions: root,
      handoffs: [destination],
    });
    const observed: boolean[] = [];
    const result = await agent.run('Handle this.', {
      ...(mode === 'opening' ? { decisions: opening } : {}),
      beforeStep: async (context) => {
        observed.push(
          await context.decide('Ready?', { input: 'Explicit input only.' }),
        );
        return undefined;
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(observed).toEqual(
      mode === 'root'
        ? [false, false]
        : mode === 'target'
          ? [false, true]
          : [true, true],
    );
    expect(root.getDecision).toHaveBeenCalledTimes(
      mode === 'opening' ? 0 : mode === 'target' ? 1 : 2,
    );
    expect(target.getDecision).toHaveBeenCalledTimes(mode === 'target' ? 1 : 0);
    expect(opening.getDecision).toHaveBeenCalledTimes(
      mode === 'opening' ? 2 : 0,
    );
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(48);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'captures the root provider before a session wrapper suspends',
  async () => {
    const original = decisionProvider(false),
      replacement = decisionProvider(true);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const server = new ModelServer([[message('done')]], [wireUsage(14)]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions: original,
    });
    const open = agent.session.bind(agent);
    agent.session = (async (options: Parameters<typeof agent.session>[0]) => {
      entered.resolve();
      await release.promise;
      return open(options);
    }) as typeof agent.session;
    let observed: boolean | undefined;
    const run = agent.run('Go.', {
      beforeStep: async (context) => {
        observed = await context.decide('Ready?', { input: 'Explicit.' });
        return undefined;
      },
    });
    await entered.promise;
    agent.decisions = replacement;
    release.resolve();
    await run;
    expect(observed).toBe(false);
    expect(original.getDecision).toHaveBeenCalledTimes(1);
    expect(replacement.getDecision).not.toHaveBeenCalled();
  },
  30000,
);

nativeIt(
  'charges completion decisions before the next root budget gate',
  async () => {
    const decisions = decisionProvider();
    const server = new ModelServer([[message('candidate')]], [wireUsage(14)]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
      beforeComplete: async (context) => {
        await context.decide('Ready?', { input: context.text! });
        return { action: 'continue', instructions: 'Try again.' };
      },
    });
    await expect(
      agent.run('Go.', { budget: { maxTokens: 24 } }),
    ).rejects.toMatchObject({ code: 'run_budget_exceeded' });
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
  },
  30000,
);

nativeIt.each(['turn', 'session'] as const)(
  'joins %s cancellation with completed decision accounting and expires the callback helper',
  async (mode) => {
    const entered = Promise.withResolvers<void>(),
      aborted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let retained: BoundDecide | undefined;
    const decisions: DecisionProvider = {
      getDecision: vi.fn(async (_request, { signal }) => {
        signal!.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return {
          value: { response: true },
          usage,
          requestId: 'cancelled-decision',
        };
      }),
    };
    const server = new ModelServer([[message('unexpected')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
    }).session();
    const turn = await session.submit('Go.', {
      beforeStep: async (context) => {
        retained = context.decide;
        await context.decide('Ready?', { input: 'Explicit.' });
        return undefined;
      },
    });
    const result = turn.wait();
    const usageEvents: unknown[] = [];
    const observation = (async () => {
      for await (const event of turn.events())
        if (event.type === 'usage_updated' && event.usage)
          usageEvents.push(event.usage.totalTokenUsage.totalTokens);
    })();
    void observation.catch(() => {});
    void result.catch(() => {});
    void entered.promise.catch(() => {});
    void aborted.promise.catch(() => {});
    const watchdog = setTimeout(() => {
      const error = new Error('Decision cancellation fixture did not complete');
      entered.reject(error);
      aborted.reject(error);
      release.resolve();
    }, 20000);
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error('Turn completed before decision admission');
        }),
      ]);
      let stopped = false;
      const stopping = (mode === 'turn' ? turn.cancel() : session.close()).then(
        () => {
          stopped = true;
        },
      );
      await aborted.promise;
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      await expect(result).rejects.toThrow();
      await observation;
      expect(usageEvents.at(-1)).toBe(10);
      await expect(
        retained!('Expired?', { input: 'Explicit.' }),
      ).rejects.toThrow();
      expect(decisions.getDecision).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(0);
    } finally {
      clearTimeout(watchdog);
      release.resolve();
    }
  },
  40000,
);

nativeIt(
  'keeps a native child decision on the child usage ledger and out of the root budget',
  async () => {
    const executor = await startPublicExecutor();
    const approvalDecisions = decisionProvider();
    vi.mocked(approvalDecisions.getDecision).mockResolvedValue({
      value: { response: true },
      usage: { ...usage, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      requestId: 'approval-check',
    });
    const completed = Promise.withResolvers<void>();
    void completed.promise.catch(() => {});
    const watchdog = setTimeout(
      () =>
        completed.reject(new Error('Child decision callback did not complete')),
      20000,
    );
    let rootId: string | undefined;
    const counts = new Map<string, number>();
    const thread = (request: JsonObject) =>
      String(
        JSON.parse(
          (request.client_metadata as Record<string, string>)[
            'x-codex-turn-metadata'
          ],
        ).thread_id,
      );
    const reply = (request: JsonObject) => {
      const id = thread(request);
      rootId ??= id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (id !== rootId) return [message('Child candidate.')];
      if (count === 1)
        return [
          call(
            'spawn_agent',
            {
              task_name: 'research',
              message: 'Check.',
              agent_type: 'research',
            },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      if (count === 2)
        return [call('wait_for_child', {}, { callId: 'join-child' })];
      return [message('{"label":"Root finished."}')];
    };
    const server = new ModelServer(
      Array.from({ length: 4 }, () => reply),
      Array.from(
        { length: 4 },
        () => (request: JsonObject) =>
          wireUsage(thread(request) === rootId ? 14 : 7),
      ),
    );
    try {
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use research.',
        outputType: {
          mode: 'prompted',
          schema: z.object({ label: z.string() }),
          maxRetries: 1,
        },
        decisions: decisionProvider(),
        beforeComplete: async (context) => {
          if (context.subagentId !== undefined) {
            try {
              await context.decide('Child ready?', { input: context.text! });
            } finally {
              completed.resolve();
            }
          }
        },
        tools: [
          new NativeAgents({
            approval: async (context, call) => {
              expect(call.name).toBe('spawn_agent');
              return context.decide('Permit this delegation?', {
                input: JSON.stringify(call.input),
                provider: approvalDecisions,
              });
            },
            additionalRoles: [
              new NativeRole({
                name: 'research',
                description: 'Checks.',
                instructions: 'Check the research.',
              }),
            ],
          }),
          tool({
            name: 'wait_for_child',
            parameters: z.object({}),
            execute: async () => {
              await completed.promise;
              return 'Child checked.';
            },
          }),
        ],
      });
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const result = await (
        await session.submit('Use research.', { budget: { maxTokens: 29 } })
      ).wait();
      expect(result.finalOutput).toEqual({ label: 'Root finished.' });
      expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(42);
      const children = [];
      for await (const child of session.subagents()) children.push(child);
      expect(children).toHaveLength(1);
      const child = await children[0].turn!.wait();
      expect(child.finalOutput).toBe('Child candidate.');
      expect(child.threadUsage?.totalTokenUsage.totalTokens).toBe(17);
      expect(child.threadUsage?.lastTokenUsage.totalTokens).toBe(7);
      expect(approvalDecisions.getDecision).toHaveBeenCalledTimes(1);
      server.assertExhausted();
    } finally {
      clearTimeout(watchdog);
      completed.resolve();
      await executor.close();
    }
  },
  40000,
);

nativeIt(
  'inherits decisions in request preparation and scopes a tool provider override to that call',
  async () => {
    const inherited = decisionProvider(false),
      override = decisionProvider(true);
    const effects: boolean[] = [];
    const server = new ModelServer(
      [[call('check', {}, { callId: 'check' })], [message('done')]],
      [wireUsage(14), wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Check then finish.',
      decisions: inherited,
      tools: [
        tool({
          name: 'check',
          parameters: z.object({}),
          execute: async (_, context) => {
            const result = await context.decide('Ready?', {
              input: 'Tool input only.',
              provider: override,
            });
            effects.push(result);
            return result;
          },
        }),
      ],
    });
    const result = await agent.run('Go.', {
      budget: { maxRequests: 2, maxTokens: 100 },
      prepareRequest: async (context) => {
        expect(
          await context.decide('Ready?', { input: 'Preparation input only.' }),
        ).toBe(false);
        return undefined;
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(effects).toEqual([true]);
    expect(inherited.getDecision).toHaveBeenCalledTimes(2);
    expect(override.getDecision).toHaveBeenCalledTimes(1);
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(58);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'returns a typed Agent-bound value through the actual shared compiler with one physical request',
  async () => {
    const server = new ModelServer([(request) => decisionReply(request, 0.75)]);
    const config = await server.config();
    const baseURL = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    const decisions = new OpenAIDecisions({
      client: new OpenAI({ apiKey: 'synthetic', baseURL, maxRetries: 0 }),
    });
    await expect(
      new Agent({ instructions: 'Answer.', decisions }).decide('Ready?', {
        input: 'Explicit input.',
        outputType: z.strictObject({ ready: z.boolean() }),
      }),
    ).resolves.toEqual({ ready: true });
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'stops before HTTP when a beforeStep decision reaches the token budget',
  async () => {
    const decisions = decisionProvider();
    const server = new ModelServer([[message('unexpected')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
    });
    await expect(
      agent.run('Go.', {
        beforeStep: async (context) => {
          await context.decide('Ready?', { input: 'Explicit.' });
          return undefined;
        },
        budget: { maxRequests: 1, maxTokens: 10 },
      }),
    ).rejects.toMatchObject({ code: 'run_budget_exceeded' });
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(0);
  },
  30000,
);

nativeIt.each(['final', 'continue'] as const)(
  'preserves admitted preparation and checks auxiliary usage at the next gate (%s)',
  async (mode) => {
    const decisions = decisionProvider();
    let effects = 0;
    const server = new ModelServer(
      [
        [
          mode === 'final'
            ? message('done')
            : call('step', {}, { callId: 'step' }),
        ],
      ],
      [wireUsage(14)],
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      decisions,
      tools: [
        tool({
          name: 'step',
          parameters: z.object({}),
          execute: () => ++effects,
        }),
      ],
    });
    const result = agent.run('Go.', {
      prepareRequest: async (context) => {
        await context.decide('Ready?', { input: 'Explicit.' });
        return undefined;
      },
      budget:
        mode === 'final'
          ? { maxRequests: 1, maxTokens: 10 }
          : { maxRequests: 2, maxTokens: 24 },
    });
    if (mode === 'final') {
      const completed = await result;
      expect(completed.finalOutput).toBe('done');
      expect(completed.threadUsage?.totalTokenUsage.totalTokens).toBe(24);
    } else {
      await expect(result).rejects.toMatchObject({
        code: 'run_budget_exceeded',
      });
      expect(effects).toBe(1);
    }
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    server.assertExhausted();
  },
  30000,
);

nativeIt(
  'replies to a failing completion callback and rejects its original turn',
  async () => {
    const server = new ModelServer([[message('candidate')]], [wireUsage(14)]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'gpt-5.5',
      provider,
      instructions: 'Answer.',
      beforeComplete: () => {
        throw new Error('Synthetic completion failure');
      },
    });
    await expect(agent.run('Go.')).rejects.toThrow(
      'Synthetic completion failure',
    );
    server.assertExhausted();
  },
  15000,
);

nativeIt(
  'binds terminal completion decisions to the exact proposal and accounts once',
  async () => {
    const decisions = decisionProvider();
    const server = new ModelServer(
      [[call('finish', {}, { callId: 'terminal-decision' })]],
      [wireUsage(14)],
    );
    await using provider = await providerFor(server);
    let retained: BoundDecide | undefined;
    const result = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Finish with the report.',
      decisions,
      outputType: z.object({ ready: z.boolean() }),
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: () => ({ ready: true }),
        }),
      ],
      beforeComplete: async (context) => {
        expect(context.text).toBeNull();
        expect(context.toolCall?.callId).toBe('terminal-decision');
        retained = context.decide;
        expect(
          await context.decide('Ready?', {
            input: JSON.stringify(context.finalOutput),
          }),
        ).toBe(true);
      },
    }).run('Finish.');
    expect(result.finalOutput).toEqual({ ready: true });
    expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(24);
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    await expect(retained!('Expired?', { input: 'Explicit.' })).rejects.toThrow(
      /no longer|abort/i,
    );
    server.assertExhausted();
  },
  30000,
);
