import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type ToolContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each(['Body failed', ''])(
  'recovers a callback-body failure with %j without accepting a terminal result',
  async (text) => {
    const server = new ModelServer([
      [call('lookup', { key: 'value' }, { callId: 'body-error' })],
      [message('recovered')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-body-recovery',
      supportsWebsockets: false,
    });
    const application = { label: 'owning-run' };
    const original = new Error('synthetic-private-body-error');
    let effects = 0;
    let formatted = 0;
    let after = 0;
    const checked = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      result: z.object({ accepted: z.boolean() }),
      finishTurn: true,
      execute() {
        effects++;
        throw original;
      },
      errorFunction(context: ToolContext<typeof application>, error) {
        expect(error).toBe(original);
        expect(context.context).toBe(application);
        expect(context.callId).toBe('body-error');
        expect(context.originalArguments).toEqual({ key: 'value' });
        expect(context.effectiveArguments).toEqual({ key: 'value' });
        formatted++;
        return text;
      },
      after(output) {
        after++;
        return output;
      },
    });
    await using session = await new Agent<typeof application>({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [checked],
    }).session({ context: application });
    expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
      'recovered',
    );
    expect({ effects, formatted, after }).toEqual({
      effects: 1,
      formatted: 1,
      after: 0,
    });
    expect(server.requests).toHaveLength(2);
    expect(JSON.stringify(server.requests[1]!.input)).not.toContain(
      original.message,
    );
    if (text) expect(JSON.stringify(server.requests[1]!.input)).toContain(text);
    server.assertExhausted();
  },
);

it.each([
  'default',
  'formatter throws',
  'formatter invalid',
  'before',
  'effective input',
  'result',
  'after',
  'approval',
] as const)('keeps %s failures outside body recovery', async (phase) => {
  const server = new ModelServer([
    [call('lookup', { key: 'value' }, { callId: 'body-error' })],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-body-recovery',
    supportsWebsockets: false,
  });
  let effects = 0;
  let formatted = 0;
  const checked = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    result: z.object({ accepted: z.boolean() }),
    ...(phase === 'approval'
      ? {
          needsApproval: () => {
            throw new Error('approval failed');
          },
        }
      : {}),
    before: () => {
      if (phase === 'before') throw new Error('policy failed');
      if (phase === 'effective input')
        return {
          action: 'replaceArguments' as const,
          arguments: { key: 7 } as unknown as { key: string },
        };
      return { action: 'allow' as const };
    },
    execute: () => {
      effects++;
      if (phase === 'result')
        return { accepted: 'invalid' } as unknown as { accepted: boolean };
      if (phase === 'after') return { accepted: true };
      throw new Error('body failed');
    },
    after: (output) => {
      if (phase === 'after') throw new Error('after failed');
      return output;
    },
    ...(phase === 'default'
      ? {}
      : {
          errorFunction: () => {
            formatted++;
            if (phase === 'formatter throws')
              throw new Error('formatter failed');
            if (phase === 'formatter invalid') return 7 as unknown as string;
            return 'unexpected recovery';
          },
        }),
  });
  await using session = await new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider,
    tools: [checked],
  }).session();
  await expect((await session.submit('begin')).wait()).rejects.toBeDefined();
  expect(effects).toBe(
    ['before', 'effective input', 'approval'].includes(phase) ? 0 : 1,
  );
  expect(formatted).toBe(phase.startsWith('formatter') ? 1 : 0);
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});

it.each(['body', 'formatter'] as const)(
  'joins cancellation during the asynchronous %s without publishing recovery',
  async (phase) => {
    const server = new ModelServer([
      [call('lookup', { key: 'value' }, { callId: 'body-error' })],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-body-recovery',
      supportsWebsockets: false,
    });
    const entered = Promise.withResolvers<void>();
    let exited = false;
    let formatted = 0;
    const waitForAbort = async (context: ToolContext) => {
      entered.resolve();
      try {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
      } finally {
        exited = true;
      }
    };
    const checked = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      async execute(_args, context) {
        if (phase === 'body') await waitForAbort(context);
        throw new Error('body failed');
      },
      async errorFunction(context) {
        formatted++;
        await waitForAbort(context);
        return 'late recovery';
      },
    });
    await using session = await new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [checked],
    }).session();
    const turn = await session.submit('begin');
    const outcome = turn.wait().catch(() => undefined);
    await entered.promise;
    await turn.cancel();
    await outcome;
    expect(exited).toBe(true);
    expect(formatted).toBe(phase === 'body' ? 0 : 1);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it('formats a managed callback failure only after its exact approval', async () => {
  const server = new ModelServer([
    [call('lookup', { key: 'value' }, { callId: 'body-error' })],
    [message('recovered')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-body-recovery',
    supportsWebsockets: false,
  });
  let effects = 0;
  let formatted = 0;
  const checked = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    needsApproval: true,
    execute() {
      effects++;
      throw new Error('body failed');
    },
    errorFunction() {
      formatted++;
      return 'Body failed';
    },
  });
  await using session = await new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider,
    tools: [checked],
  }).session();
  const turn = await session.submit('begin');
  let approved = false;
  for await (const request of session.interactions()) {
    if (!isFunctionApprovalRequest(request)) continue;
    expect({ effects, formatted }).toEqual({ effects: 0, formatted: 0 });
    await session.respond(request.approve());
    approved = true;
    break;
  }
  expect(approved).toBe(true);
  expect((await turn.wait()).finalOutput).toBe('recovered');
  expect({ effects, formatted }).toEqual({ effects: 1, formatted: 1 });
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});
