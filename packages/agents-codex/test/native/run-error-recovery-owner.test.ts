import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  OutputValidationError,
  RecoverRun,
  RunDiagnosticError,
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

it('keeps configured output guardrails outside output recovery', async () => {
  const server = new ModelServer([[message('{"answer":42}')]]);
  await using provider = await providerFor(server);
  const handler = vi.fn(() => new RecoverRun({ answer: 'fallback' }));
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    outputType: z.object({ answer: z.string() }),
    outputGuardrails: [
      {
        name: 'out',
        callback: () => ({ tripwireTriggered: false, outputInfo: null }),
      },
    ],
  });
  await expect(
    agent.run('begin', { errorHandler: handler }),
  ).rejects.toBeInstanceOf(Error);
  expect(handler).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
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
