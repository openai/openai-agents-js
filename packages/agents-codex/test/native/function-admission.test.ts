import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeAgents,
  NativeProvider,
  ToolOutput,
  Environment,
  type ChildTurn,
  manualTool,
  tool,
} from '@openai/agents';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import { nativeDescendantModel } from './fixtures/native-descendant-model';

afterEach(() => ModelServer.closeAll());

async function childEnvironment() {
  const executor = await startPublicExecutor();
  onTestFinished(() => executor.close());
  return new Environment({
    url: executor.url,
    cwd: executor.cwd,
    headers: executor.headers,
    tools: ['exec_command', 'write_stdin', 'apply_patch'],
  });
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

it.each([undefined, 1, 2])(
  'uses maxFunctionConcurrency=%s through cleanup and recovers permits on another turn',
  async (maxFunctionConcurrency) => {
    const expected = maxFunctionConcurrency ?? 3;
    const bodies = Promise.withResolvers<void>(),
      cleanup = Promise.withResolvers<void>();
    const validated: number[] = [],
      entered: number[] = [];
    let active = 0,
      maximum = 0,
      afterCount = 0;
    const batch = (prefix: string) =>
      [1, 2, 3].map((id) =>
        call('work', { id }, { callId: `${prefix}-${id}` }),
      );
    const server = new ModelServer([
      batch('first'),
      [message('first')],
      batch('next'),
      [message('next')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use work.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'work',
          parameters: z.object({ id: z.number() }).transform((args) => {
            validated.push(args.id);
            active++;
            maximum = Math.max(maximum, active);
            return args;
          }),
          before: () => ({ action: 'allow' }),
          async execute({ id }) {
            entered.push(id);
            await bodies.promise;
            return new ToolOutput(
              [{ type: 'inputText', text: `work-${id}` }],
              id !== 2,
            );
          },
          async after(output) {
            afterCount++;
            await cleanup.promise;
            active--;
            return output;
          },
        }),
      ],
    });
    const options = { maxFunctionConcurrency };
    await using session = await agent.session(options);
    options.maxFunctionConcurrency =
      maxFunctionConcurrency === undefined ? 1 : 3;
    try {
      const turn = await session.submit('first');
      await vi.waitFor(() => expect(entered).toHaveLength(expected));
      expect(validated).toHaveLength(expected);
      bodies.resolve();
      await vi.waitFor(() => expect(afterCount).toBe(expected));
      expect(validated).toHaveLength(expected);
      cleanup.resolve();
      expect((await turn.wait()).finalOutput).toBe('first');
      expect(entered).toHaveLength(3);
      expect(maximum).toBe(expected);
      expect((await (await session.submit('next')).wait()).finalOutput).toBe(
        'next',
      );
      expect(entered).toHaveLength(6);
      expect(maximum).toBe(expected);
      server.assertExhausted();
    } finally {
      bodies.resolve();
      cleanup.resolve();
    }
  },
);

it('cancels queued functions before validation and joins an entered callback cleanup', async () => {
  const started = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>(),
    cleanup = Promise.withResolvers<void>();
  const validated: number[] = [],
    bodies: number[] = [];
  const server = new ModelServer([
    [1, 2, 3].map((id) => call('work', { id }, { callId: `cancel-${id}` })),
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use work.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'work',
        parameters: z.object({ id: z.number() }).transform((args) => {
          validated.push(args.id);
          return args;
        }),
        async execute({ id }, ctx) {
          bodies.push(id);
          started.resolve();
          try {
            await new Promise<void>((resolve) =>
              ctx.signal.addEventListener(
                'abort',
                () => {
                  aborted.resolve();
                  resolve();
                },
                { once: true },
              ),
            );
          } finally {
            await cleanup.promise;
          }
          return 'late';
        },
      }),
    ],
  });
  await using session = await agent.session({ maxFunctionConcurrency: 1 });
  try {
    const turn = await session.submit('cancel');
    let settled = false;
    const result = turn.wait().then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await started.promise;
    const stopped = turn.cancel();
    await aborted.promise;
    expect(settled).toBe(false);
    expect(validated).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    cleanup.resolve();
    await stopped;
    expect(await result).toBeInstanceOf(Error);
    expect(validated).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  } finally {
    cleanup.resolve();
  }
});

it('seals admission on fatal failure before a queued validator can start', async () => {
  const started = Promise.withResolvers<void>(),
    fail = Promise.withResolvers<void>();
  const validated: number[] = [];
  const failure = new Error('fatal work failure');
  const server = new ModelServer([
    [1, 2, 3].map((id) => call('work', { id }, { callId: `fatal-${id}` })),
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use work.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'work',
        parameters: z.object({ id: z.number() }).transform((args) => {
          validated.push(args.id);
          return args;
        }),
        async execute() {
          started.resolve();
          await fail.promise;
          throw failure;
        },
      }),
    ],
  });
  await using session = await agent.session({ maxFunctionConcurrency: 1 });
  try {
    const turn = await session.submit('fail');
    const result = turn.wait();
    await started.promise;
    fail.resolve();
    await expect(result).rejects.toBe(failure);
    expect(validated).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  } finally {
    fail.resolve();
  }
});

it('does not charge a manual sibling to the automatic function cap and forwards Agent.run options', async () => {
  const entered = Promise.withResolvers<void>(),
    manualAnswered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const decision = manualTool({
    name: 'decision',
    description: 'Ask.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [
      call('hold', {}, { callId: 'hold' }),
      call('decision', {}, { callId: 'decision' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use both.',
    model: 'gpt-5',
    provider,
    tools: [
      decision,
      tool({
        name: 'hold',
        parameters: z.object({}),
        async execute() {
          entered.resolve();
          await release.promise;
          return 'held';
        },
      }),
    ],
  });
  const result = agent.run('both', {
    maxFunctionConcurrency: 1,
    onInteraction(action) {
      const request = decision.match(action);
      if (!request) throw new Error('Unexpected request');
      manualAnswered.resolve();
      return request.reply('yes');
    },
  });
  try {
    await entered.promise;
    await manualAnswered.promise;
    release.resolve();
    expect((await result).finalOutput).toBe('done');
    server.assertExhausted();
  } finally {
    release.resolve();
  }
});

it('gives a native child its own permits while a parent function awaits it', async () => {
  const rootEntered = Promise.withResolvers<void>(),
    childEntered = Promise.withResolvers<void>();
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const seen: (string | null)[] = [];
  const reply = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId) {
      if (count === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Call work.' },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      if (count === 2) return [call('work', {}, { callId: 'parent-work' })];
      return [message('root done')];
    }
    if (count === 1) {
      await rootEntered.promise;
      return [call('work', {}, { callId: 'child-work' })];
    }
    return [message('child done')];
  };
  const server = new ModelServer(Array.from({ length: 5 }, () => reply));
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Delegate and use work.',
    model: nativeDescendantModel,
    provider,
    tools: [
      new NativeAgents(),
      tool({
        name: 'work',
        parameters: z.object({}),
        async execute(_, ctx) {
          expect(ctx.call).toBeDefined();
          seen.push(ctx.call!.childId);
          if (ctx.call!.childId) {
            childEntered.resolve();
            return 'child';
          }
          rootEntered.resolve();
          await childEntered.promise;
          return 'parent';
        },
      }),
    ],
  });
  const session = await agent.session({
    maxFunctionConcurrency: 1,
    environment: await childEnvironment(),
  });
  try {
    const turn = await session.submit('begin');
    expect((await turn.wait()).finalOutput).toBe('root done');
    expect(seen).toHaveLength(2);
    expect(seen.filter((id) => id !== null)).toHaveLength(1);
    server.assertExhausted();
  } finally {
    rootEntered.resolve();
    childEntered.resolve();
    await session.close();
  }
});

it('seals a child gate on result validation failure before its queued sibling starts', async () => {
  const callback = Promise.withResolvers<void>();
  const childTurn = Promise.withResolvers<ChildTurn>();
  const fail = Promise.withResolvers<void>(),
    childSettled = Promise.withResolvers<void>();
  const validated: number[] = [];
  const failure = new Error('fatal child result validation');
  let rootId: string | undefined;
  let rootRequests = 0;
  const reply = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId) {
      if (++rootRequests === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Call work twice.' },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      await childSettled.promise;
      return [message('root done')];
    }
    return [1, 2].map((id) => call('work', { id }, { callId: `child-${id}` }));
  };
  const server = new ModelServer(Array.from({ length: 3 }, () => reply));
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Delegate.',
    model: nativeDescendantModel,
    provider,
    tools: [
      new NativeAgents({
        beforeStep(ctx) {
          childTurn.resolve(ctx.submission);
          return undefined;
        },
      }),
      tool({
        name: 'work',
        parameters: z.object({ id: z.number() }).transform((args) => {
          validated.push(args.id);
          return args;
        }),
        result: z.string().transform(() => {
          throw failure;
        }),
        async execute() {
          callback.resolve();
          await fail.promise;
          return 'answer';
        },
      }),
    ],
  });
  const session = await agent.session({
    maxFunctionConcurrency: 1,
    environment: await childEnvironment(),
  });
  try {
    const root = await session.submit('begin');
    await callback.promise;
    const result = (await childTurn.promise).wait();
    fail.resolve();
    await expect(result).rejects.toThrow('Tool result failed validation');
    expect(validated).toHaveLength(1);
    childSettled.resolve();
    expect((await root.wait()).finalOutput).toBe('root done');
    server.assertExhausted();
  } finally {
    fail.resolve();
    childSettled.resolve();
    await session.close();
  }
});

it('starts the body timeout after admission and releases an error-as-result permit after cleanup', async () => {
  const aborted = Promise.withResolvers<void>(),
    cleanup = Promise.withResolvers<void>();
  const entered: number[] = [];
  const server = new ModelServer([
    [
      call('work', { id: 1 }, { callId: 'slow' }),
      call('work', { id: 2 }, { callId: 'fast' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use work.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'work',
        parameters: z.object({ id: z.number() }),
        callbackTimeout: 0.02,
        timeoutBehavior: 'error_as_result',
        async execute({ id }, ctx) {
          entered.push(id);
          if (entered.length === 2) return 'fast result';
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener(
              'abort',
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true },
            ),
          );
          await cleanup.promise;
          return 'late result';
        },
      }),
    ],
  });
  await using session = await agent.session({ maxFunctionConcurrency: 1 });
  try {
    const turn = await session.submit('begin');
    await aborted.promise;
    expect(entered).toHaveLength(1);
    cleanup.resolve();
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(entered).toHaveLength(2);
    expect(JSON.stringify(server.requests[1].input)).toContain('fast result');
    expect(JSON.stringify(server.requests[1].input)).not.toContain(
      'late result',
    );
    server.assertExhausted();
  } finally {
    cleanup.resolve();
  }
});

it.each([0, -1, 1.5])(
  'rejects maxFunctionConcurrency=%s before opening',
  async (maxFunctionConcurrency) => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({ instructions: 'No request.', provider });
    await expect(agent.session({ maxFunctionConcurrency })).rejects.toThrow(
      'positive integer',
    );
    expect(server.requests).toHaveLength(0);
  },
);

it('holds admission through native reply settlement before publishing another ToolStarted', async () => {
  const pendingReply = Promise.withResolvers<void>(),
    releaseReply = Promise.withResolvers<void>();
  let validated = 0;
  const starts: string[] = [];
  const server = new ModelServer([
    [
      call('work', {}, { callId: 'reply-a' }),
      call('work', {}, { callId: 'reply-b' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const addon = await binding();
  const respond = addon.NativeThread.prototype._respond_python_tool;
  const held = vi
    .spyOn(addon.NativeThread.prototype, '_respond_python_tool')
    .mockImplementationOnce(async function (this: NativeThread, request) {
      pendingReply.resolve();
      await releaseReply.promise;
      return respond.call(this, request);
    });
  const agent = new Agent({
    instructions: 'Use work.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'work',
        parameters: z.object({}).refine(() => {
          validated++;
          return true;
        }),
        execute: () => 'answer',
      }),
    ],
  });
  const session = await agent.session({ maxFunctionConcurrency: 1 });
  let observations: Promise<void> | undefined;
  try {
    const turn = await session.submit('begin');
    observations = (async () => {
      for await (const event of turn.events())
        if (event.type === 'tool_started') starts.push(event.callId);
    })();
    await pendingReply.promise;
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(validated).toBe(1);
    releaseReply.resolve();
    expect((await turn.wait()).finalOutput).toBe('done');
    await observations;
    expect(starts.sort()).toEqual(['reply-a', 'reply-b']);
    expect(validated).toBe(2);
    server.assertExhausted();
  } finally {
    releaseReply.resolve();
    await session.close();
    held.mockRestore();
    await observations;
  }
});
