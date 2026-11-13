import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailTripwire,
  Handoff,
  InteractionRequired,
  NativeError,
  NativeProvider,
  OutputValidationError,
  RecoverRun,
  RunDiagnosticError,
  manualTool,
  tool,
  type RunFailure,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-run-recovery',
    supportsWebsockets: false,
  });
}

it.each([true, false])(
  'recovers validated output with history=%s without another model request',
  async (includeInHistory) => {
    const server = new ModelServer([[message('{"answer":42}')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      outputType: z.object({ answer: z.string() }),
    });
    let captured: RunFailure | undefined;
    const result = await agent.run('begin', {
      returnHistory: true,
      returnItems: true,
      errorHandler: (failure) => {
        captured = failure;
        expect(failure.kind).toBe('invalid_output');
        expect(failure.error).toBeInstanceOf(OutputValidationError);
        expect(JSON.stringify(failure)).toBe('{"kind":"invalid_output"}');
        expect(failure.details.history.length).toBeGreaterThan(0);
        return new RecoverRun({ answer: 'recovered' }, includeInHistory);
      },
    });
    expect(result.finalOutput).toEqual({ answer: 'recovered' });
    expect(await result.turn.wait()).toMatchObject({
      finalOutput: { answer: 'recovered' },
    });
    const synthetic =
      result.items?.filter(({ item }) =>
        JSON.stringify(item).includes('recovered'),
      ) ?? [];
    expect(synthetic).toHaveLength(includeInHistory ? 1 : 0);
    if (includeInHistory) {
      expect(
        result.history?.find((item) => item.id === synthetic[0]!.item.id),
      ).toMatchObject({ role: 'assistant' });
    }
    expect(JSON.stringify(captured!.details.history)).not.toContain(
      'recovered',
    );
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it('recovers an admitted request ceiling with zero provider requests', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Answer.', provider });
  const result = await agent.run('begin', {
    budget: { maxRequests: 0 },
    captureErrorDetails: true,
    errorHandler: (failure) => {
      expect(failure.kind).toBe('max_requests');
      return new RecoverRun('budget fallback');
    },
  });
  expect(result.finalOutput).toBe('budget fallback');
  expect(server.requests).toHaveLength(0);
});

it('validates a zero-request recovery with the native default model', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const guard = vi.fn(({ model }: { model: string }) => {
    expect(model).toBeTruthy();
    return { tripwireTriggered: false, outputInfo: null };
  });
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    outputGuardrails: [{ name: 'budget fallback', callback: guard }],
  });
  const result = await agent.run('begin', {
    budget: { maxRequests: 0 },
    errorHandler: () => new RecoverRun('budget fallback'),
  });
  expect(result.finalOutput).toBe('budget fallback');
  expect(guard).toHaveBeenCalledOnce();
  expect(server.requests).toHaveLength(0);
});

it('recovers an explicit provider refusal without retry', async () => {
  const server = new ModelServer([
    [
      {
        type: 'message',
        id: 'refused-message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'cannot answer' }],
      },
    ],
  ]);
  await using provider = await providerFor(server);
  const result = await new Agent({ instructions: 'Answer.', provider }).run(
    'begin',
    {
      errorHandler: (failure) => {
        expect(failure.kind).toBe('model_refusal');
        return new RecoverRun('refusal fallback');
      },
    },
  );
  expect(result.finalOutput).toBe('refusal fallback');
  expect(server.requests).toHaveLength(1);
});

it.each([false, true])(
  'preserves decline and diagnostics=%s',
  async (captureErrorDetails) => {
    const server = new ModelServer([[message('{"answer":42}')]]);
    await using provider = await providerFor(server);
    const handler = vi.fn(() => undefined);
    const error = await new Agent({
      instructions: 'Answer.',
      provider,
      outputType: z.object({ answer: z.string() }),
    })
      .run('begin', { captureErrorDetails, errorHandler: handler })
      .catch((error: unknown) => error);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(
      captureErrorDetails ? RunDiagnosticError : OutputValidationError,
    );
    expect(server.requests).toHaveLength(1);
  },
);

it('rejects invalid fallback through the captured application schema', async () => {
  const server = new ModelServer([[message('{"answer":42}')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    outputType: z.object({ answer: z.string() }),
  });
  await expect(
    agent.run('begin', {
      errorHandler: () => new RecoverRun({ answer: 3 } as never),
    }),
  ).rejects.toBeInstanceOf(OutputValidationError);
  expect(server.requests).toHaveLength(1);
});

it.each(['token', 'spoofed_budget', 'spoofed_output', 'handler_throw'])(
  'keeps %s outside recovery or preserves its policy error',
  async (mode) => {
    const server = new ModelServer(
      mode === 'token' ? [] : [[message('{"answer":42}')]],
    );
    await using provider = await providerFor(server);
    const sentinel = new Error('policy error');
    const handler = vi.fn(() => {
      if (mode === 'handler_throw') throw sentinel;
      return new RecoverRun('fallback');
    });
    const beforeStep =
      mode === 'spoofed_budget'
        ? () => {
            throw new NativeError('application budget-shaped error', {
              code: 'run_budget_exceeded',
            });
          }
        : mode === 'spoofed_output'
          ? () => {
              throw new OutputValidationError('application callback');
            }
          : undefined;
    const options = { instructions: 'Answer.', provider };
    const agent =
      mode === 'handler_throw'
        ? new Agent({
            ...options,
            outputType: z.object({ answer: z.string() }),
          })
        : new Agent(options);
    const error = await agent
      .run('begin', {
        budget: mode === 'token' ? { maxTokens: 0 } : undefined,
        beforeStep,
        errorHandler: handler as never,
      })
      .catch((error: unknown) => error);
    if (mode === 'handler_throw') {
      expect(handler).toHaveBeenCalledTimes(1);
      expect(error).toBe(sentinel);
    } else {
      expect(handler).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(Error);
    }
  },
);

it.each([true, false])(
  'rejects changed canonical history while recovery waits, history=%s',
  async (includeInHistory) => {
    const server = new ModelServer([[message('{"answer":42}')]]);
    await using provider = await providerFor(server);
    let owned: Session<any>;
    class CapturedAgent extends Agent<undefined, { answer: string }> {
      override async session(
        ...args: Parameters<Agent<undefined, { answer: string }>['session']>
      ) {
        return (owned = await super.session(...args));
      }
    }
    const agent = new CapturedAgent({
      instructions: 'Answer.',
      provider,
      outputType: z.object({ answer: z.string() }),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = agent.run('begin', {
      errorHandler: async () => {
        entered.resolve();
        await release.promise;
        return new RecoverRun({ answer: 'stale fallback' }, includeInHistory);
      },
    });
    await entered.promise;
    const before = await owned!.historySnapshot({ limit: 0 });
    await owned!.transactHistory({
      expectedRevision: before.revision,
      keep: before.total,
      items: [
        {
          type: 'message',
          id: 'external-append',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'newer canonical record' }],
        },
      ],
    });
    release.resolve();
    await expect(pending).rejects.toThrow('Canonical history changed');
    expect(server.requests).toHaveLength(1);
  },
);

it.each(
  ['root', 'queued', 'update'].flatMap((change) =>
    [true, false].map((includeInHistory) => ({ change, includeInHistory })),
  ),
)(
  'rejects $change ownership changes while recovery waits, history=$includeInHistory',
  async ({ change, includeInHistory }) => {
    const responses = [
      [message('{"answer":42}')],
      ...Array.from(
        { length: change === 'queued' ? 2 : change === 'root' ? 1 : 0 },
        () => [message('{"answer":"newer"}')],
      ),
    ];
    const server = new ModelServer(responses);
    await using provider = await providerFor(server);
    let owned: Session<{ answer: string }>;
    class CapturedAgent extends Agent<undefined, { answer: string }> {
      override async session(
        ...args: Parameters<Agent<undefined, { answer: string }>['session']>
      ) {
        return (owned = await super.session(...args));
      }
    }
    const agent = new CapturedAgent({
      instructions: 'Answer.',
      provider,
      outputType: z.object({ answer: z.string() }),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = agent.run('begin', {
      errorHandler: async () => {
        entered.resolve();
        await release.promise;
        return new RecoverRun({ answer: 'stale fallback' }, includeInHistory);
      },
    });
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Expected recovery entry');
      }),
    ]);
    if (change === 'update')
      await owned!.update({ instructions: 'Updated instructions.' });
    else if (change === 'root') await (await owned!.submit('new root')).wait();
    else {
      const first = owned!.enqueue('queued first');
      const second = owned!.enqueue('queued second');
      await Promise.all([
        first.then((turn) => turn.wait()),
        second.then((turn) => turn.wait()),
      ]);
    }
    const append = vi.spyOn(owned!, 'transactHistory');
    release.resolve();
    await expect(pending).rejects.toThrow('no longer current');
    expect(append).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(responses.length);
    server.assertExhausted();
  },
);

it('keeps a failed provider request outside output recovery', async () => {
  const server = new ModelServer([
    { status: 400, body: '{"error":{"message":"invalid request"}}' },
  ]);
  await using provider = await providerFor(server);
  const handler = vi.fn(() => new RecoverRun('fallback'));
  await expect(
    new Agent({ instructions: 'Answer.', provider }).run('begin', {
      errorHandler: handler,
    }),
  ).rejects.toBeInstanceOf(NativeError);
  expect(handler).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
});

it.each([false, true])(
  'checks synthesized output before history admission (tripwire=%s)',
  async (tripwire) => {
    const server = new ModelServer([[message('{"answer":42}')]]);
    await using provider = await providerFor(server);
    const context = { tenant: 'current' };
    const seen: string[] = [];
    const agent = new Agent<typeof context, { answer: string }>({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      outputType: z.object({ answer: z.string() }),
      outputGuardrails: [
        {
          name: 'agent-check',
          callback: (request, source) => {
            expect(source).toBe(agent);
            expect(request.context).toBe(context);
            expect(request.model).toBe('gpt-5.5');
            expect(request.finalOutput).toEqual({ answer: 'safe fallback' });
            seen.push('agent');
            return { tripwireTriggered: tripwire, outputInfo: 'agent verdict' };
          },
        },
      ],
    });
    const originalSession = agent.session.bind(agent);
    let retainedHistory: unknown;
    vi.spyOn(agent, 'session').mockImplementation(async (options) => {
      const session = await originalSession(options);
      const close = session.close.bind(session);
      vi.spyOn(session, 'close').mockImplementation(async () => {
        try {
          retainedHistory = await session.historySnapshot();
        } finally {
          await close();
        }
      });
      return session;
    });
    const pending = agent.run('begin', {
      context,
      returnHistory: true,
      errorHandler: (failure) => {
        expect(failure.kind).toBe('invalid_output');
        seen.push('handler');
        return new RecoverRun({ answer: 'safe fallback' });
      },
      outputGuardrails: [
        {
          name: 'run-check',
          callback: (request, source) => {
            expect(source).toBe(agent);
            expect(request.finalOutput).toEqual({ answer: 'safe fallback' });
            seen.push('run');
            return { tripwireTriggered: false, outputInfo: 'run verdict' };
          },
        },
      ],
    });
    if (tripwire) {
      await expect(pending).rejects.toBeInstanceOf(GuardrailTripwire);
      await expect(pending).rejects.toMatchObject({
        record: { name: 'agent-check' },
      });
      expect(retainedHistory).toBeDefined();
      expect(JSON.stringify(retainedHistory)).not.toContain('safe fallback');
    } else {
      const result = await pending;
      expect(result.finalOutput).toEqual({ answer: 'safe fallback' });
      expect(result.guardrailResults?.map((record) => record.name)).toEqual([
        'run-check',
        'agent-check',
      ]);
      expect(result.turn.guardrailResults).toEqual(result.guardrailResults);
      expect(JSON.stringify(result.history)).toContain('safe fallback');
    }
    expect(seen).toEqual(['handler', 'run', 'agent']);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it('uses the destination guardrail and model for recovery after a handoff', async () => {
  const server = new ModelServer([
    [call('route', {}, { callId: 'recovery-handoff' })],
    [message('{"answer":42}')],
  ]);
  await using provider = await providerFor(server);
  const outputType = z.object({ answer: z.string() });
  const sourceGuard = vi.fn(() => ({
    tripwireTriggered: false,
    outputInfo: null,
  }));
  const target = new Agent({
    instructions: 'Resolve.',
    model: 'gpt-5.5',
    outputType,
    outputGuardrails: [
      {
        name: 'destination',
        callback(request, source) {
          expect(source).toBe(target);
          expect(request.model).toBe('gpt-5.5');
          expect(request.finalOutput).toEqual({ answer: 'fallback' });
          return { tripwireTriggered: false, outputInfo: null };
        },
      },
    ],
  });
  const route = tool({
    name: 'route',
    parameters: z.object({}),
    execute: () => 'accepted',
  });
  const agent = new Agent({
    instructions: 'Route.',
    model: 'gpt-5.5',
    provider,
    outputType,
    outputGuardrails: [{ name: 'source', callback: sourceGuard }],
    handoffs: [new Handoff(target, route)],
  });
  const result = await agent.run('begin', {
    errorHandler: ({ details }) => {
      expect(details.lastAgent).toBe(target);
      return new RecoverRun({ answer: 'fallback' });
    },
  });
  expect(result.finalOutput).toEqual({ answer: 'fallback' });
  expect(result.guardrailResults?.map(({ name }) => name)).toEqual([
    'destination',
  ]);
  expect(sourceGuard).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it('validates synthesized output after restoring a manual checkpoint', async () => {
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'recovered-manual' })],
    [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'declined restored request' }],
      },
    ],
  ]);
  await using provider = await providerFor(server);
  const guard = vi.fn(() => ({ tripwireTriggered: false, outputInfo: null }));
  const agent = new Agent({
    instructions: 'Ask lookup, then answer.',
    provider,
    outputGuardrails: [{ name: 'restored', callback: guard }],
    tools: [
      manualTool({
        name: 'lookup',
        description: 'Ask lookup.',
        parameters: z.object({}),
        result: z.string(),
      }),
    ],
  });
  const interrupted = await agent
    .run('Original question', {
      captureErrorDetails: true,
    })
    .catch((error: unknown) => error);
  const interaction =
    interrupted instanceof RunDiagnosticError ? interrupted.cause : interrupted;
  if (!(interaction instanceof InteractionRequired)) throw interaction;
  const state = (interaction as InteractionRequired).state!;
  expect(state).toBeDefined();
  const result = await agent.run(null, {
    state,
    returnHistory: true,
    onInteraction: (event) => {
      if (event.type !== 'action_requested')
        throw new Error('Expected manual request');
      return event.reply('accepted manual answer');
    },
    errorHandler: ({ kind, details }) => {
      expect(kind).toBe('model_refusal');
      expect(details.input).toBe('Original question');
      return new RecoverRun('restored fallback');
    },
  });
  expect(result.finalOutput).toBe('restored fallback');
  expect(guard).toHaveBeenCalledOnce();
  expect(result.guardrailResults?.map(({ name }) => name)).toEqual([
    'restored',
  ]);
  expect(JSON.stringify(result.history)).toContain('restored fallback');
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it('cancels a waiting recovery guardrail and discards its late verdict', async () => {
  const server = new ModelServer([[message('{"answer":42}')]]);
  await using provider = await providerFor(server);
  const controller = new AbortController();
  const reason = new Error('cancel recovery guardrail');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    outputType: z.object({ answer: z.string() }),
    outputGuardrails: [
      {
        name: 'wait',
        async callback({ signal }) {
          entered.resolve();
          await release.promise;
          expect(signal.reason).toBe(reason);
          exited.resolve();
          return { tripwireTriggered: false, outputInfo: null };
        },
      },
    ],
  });
  const pending = agent.run('begin', {
    signal: controller.signal,
    errorHandler: () => new RecoverRun({ answer: 'late fallback' }),
  });
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Expected recovery guardrail entry');
      }),
    ]);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  } finally {
    release.resolve();
  }
  await exited.promise;
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});

it('cancels a waiting recovery policy and ignores its late fallback', async () => {
  const server = new ModelServer([[message('{"answer":42}')]]);
  await using provider = await providerFor(server);
  const controller = new AbortController();
  const reason = new Error('cancel recovery');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<RecoverRun<{ answer: string }>>();
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    outputType: z.object({ answer: z.string() }),
  });
  const pending = agent.run('begin', {
    signal: controller.signal,
    errorHandler: () => {
      entered.resolve();
      return release.promise;
    },
  });
  await Promise.race([
    entered.promise,
    pending.then(() => {
      throw new Error('Expected recovery entry');
    }),
  ]);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  release.resolve(new RecoverRun({ answer: 'late fallback' }));
  expect(server.requests).toHaveLength(1);
});

it('leaves successful runs and their result identity unchanged', async () => {
  const server = new ModelServer([[message('normal answer')]]);
  await using provider = await providerFor(server);
  const handler = vi.fn(() => new RecoverRun('fallback'));
  const result = await new Agent({ instructions: 'Answer.', provider }).run(
    'begin',
    { errorHandler: handler },
  );
  expect(result.finalOutput).toBe('normal answer');
  expect(handler).not.toHaveBeenCalled();
  expect((await result.turn.wait()).finalOutput).toBe('normal answer');
  expect(server.requests).toHaveLength(1);
});

it('recovers after a request ceiling while retaining exactly one accepted tool effect', async () => {
  let effects = 0;
  const step = tool({
    name: 'step',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'accepted';
    },
  });
  const server = new ModelServer([
    [call('step', {}, { callId: 'settled-budget-effect' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Call step then answer.',
    provider,
    tools: [step],
  });
  const result = await agent.run('begin', {
    budget: { maxRequests: 1 },
    returnItems: true,
    errorHandler: (failure) => {
      expect(failure.kind).toBe('max_requests');
      expect(
        failure.details.items.some(
          ({ item }) => item.type === 'function_call_output',
        ),
      ).toBe(true);
      return new RecoverRun('budget summary');
    },
  });
  expect(result.finalOutput).toBe('budget summary');
  expect(effects).toBe(1);
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});
