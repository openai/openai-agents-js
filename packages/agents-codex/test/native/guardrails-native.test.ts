import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  Agent,
  GuardrailTripwire,
  NativeProvider,
  tool,
  type OutputGuardrail,
} from '../../src';

afterEach(() => ModelServer.closeAll());

async function fixture(steps: ConstructorParameters<typeof ModelServer>[0]) {
  const server = new ModelServer(steps);
  const config = await server.config();
  return {
    server,
    provider: new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-guardrails',
    }),
  };
}

it('checks converted output once and retains declaration order despite reversed completion', async () => {
  const { server, provider } = await fixture([[message('{"count":7}')]]);
  await using _resource = provider;
  const completion: string[] = [];
  const raw: unknown[] = [];
  let parsed = 0;
  const secondDone = Promise.withResolvers<void>();
  const first: OutputGuardrail = {
    name: 'run-first',
    async callback(context) {
      await secondDone.promise;
      expect(context.finalOutput).toEqual({ count: 7 });
      (context.finalOutput as { count: number }).count = 99;
      completion.push('first');
      return { tripwireTriggered: false };
    },
  };
  const second: OutputGuardrail = {
    name: 'agent-second',
    callback(context) {
      expect(context.finalOutput).toEqual({ count: 7 });
      completion.push('second');
      secondDone.resolve();
      return { tripwireTriggered: false };
    },
  };
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    outputType: {
      mode: 'prompted',
      schema: z.object({ count: z.number() }).transform((value) => {
        parsed++;
        return value;
      }),
    },
    beforeComplete(context) {
      raw.push(context.text);
    },
    outputGuardrails: [second],
  });
  await using session = await agent.session({ outputGuardrails: [first] });
  const turn = await session.submit('begin');
  const result = await turn.wait();
  expect(result.finalOutput).toEqual({ count: 7 });
  expect(parsed).toBe(1);
  expect(completion).toEqual(['second', 'first']);
  expect(result.guardrailResults?.map((entry) => entry.name)).toEqual([
    'run-first',
    'agent-second',
  ]);
  expect(turn.guardrailResults).toEqual(result.guardrailResults);
  expect(raw).toEqual(['{"count":7}']);
  server.assertExhausted();
});

it('retains arbitrary host diagnostics on a typed tripwire', async () => {
  const { provider } = await fixture([[message('candidate')]]);
  await using _resource = provider;
  const marker = Symbol('host-only');
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    outputGuardrails: [
      {
        name: 'block',
        callback() {
          return { tripwireTriggered: true, outputInfo: marker };
        },
      },
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('begin');
  const error = await turn.wait().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GuardrailTripwire);
  expect((error as GuardrailTripwire).results[0].result.outputInfo).toBe(
    marker,
  );
  expect(turn.guardrailResults).toEqual((error as GuardrailTripwire).results);
});

it('withholds a blocked terminal result from public history and observations', async () => {
  const { provider } = await fixture([
    [call('done', {}, { callId: 'terminal-call' })],
  ]);
  await using _resource = provider;
  const agent = new Agent({
    instructions: 'Use done.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'done',
        parameters: z.object({}),
        finishTurn: true,
        execute() {
          return 'sensitive-terminal-output';
        },
      }),
    ],
    outputGuardrails: [
      {
        name: 'block',
        callback(context) {
          expect(context.finalOutput).toBe('sensitive-terminal-output');
          expect(context.toolCall?.callId).toBe('terminal-call');
          return { tripwireTriggered: true };
        },
      },
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('begin');
  await expect(turn.wait()).rejects.toBeInstanceOf(GuardrailTripwire);
  const items = await Array.fromAsync(session.items());
  const events = await Array.fromAsync(
    turn.events({ includeExecutionDetails: true }),
  );
  expect(JSON.stringify(items)).not.toContain('sensitive-terminal-output');
  expect(JSON.stringify(events)).not.toContain('sensitive-terminal-output');
  expect(JSON.stringify(items).toLowerCase()).toContain('withheld');
});

it('runs blocking input siblings concurrently before requesting the model', async () => {
  const { server, provider } = await fixture([[message('accepted')]]);
  await using _provider = provider;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    inputGuardrails: [
      {
        name: 'agent-first',
        runInParallel: false,
        async callback(context) {
          entered.resolve();
          await release.promise;
          expect(server.requests).toHaveLength(0);
          expect(context.input).toBe('original');
          return { tripwireTriggered: false };
        },
      },
    ],
  });
  await using session = await agent.session({
    inputGuardrails: [
      {
        name: 'run-second',
        runInParallel: false,
        async callback(context) {
          await entered.promise;
          expect(server.requests).toHaveLength(0);
          expect(context.agent.name).toBe(agent.name);
          release.resolve();
          return { tripwireTriggered: false };
        },
      },
    ],
  });
  const result = await (await session.submit('original')).wait();
  expect(result.guardrailResults?.map((record) => record.name)).toEqual([
    'run-second',
    'agent-first',
  ]);
  expect(server.requests).toHaveLength(1);
});

it('prevents the first model request on a blocking input tripwire', async () => {
  const { server, provider } = await fixture([]);
  await using _provider = provider;
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    inputGuardrails: [
      {
        name: 'blocked',
        runInParallel: false,
        callback() {
          return { tripwireTriggered: true };
        },
      },
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('original');
  await expect(turn.wait()).rejects.toBeInstanceOf(GuardrailTripwire);
  expect(turn.guardrailResults.map((record) => record.kind)).toEqual(['input']);
  expect(server.requests).toHaveLength(0);
});

it('overlaps parallel input checks with the model and gates completion', async () => {
  const { server, provider } = await fixture([[message('accepted')]]);
  await using _provider = provider;
  const overlapping = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
    inputGuardrails: [
      {
        name: 'parallel',
        async callback() {
          while (!server.requests.length)
            await new Promise((resolve) => setTimeout(resolve, 0));
          overlapping.resolve();
          await release.promise;
          return { tripwireTriggered: false };
        },
      },
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('original');
  let completed = false;
  const result = turn.wait().then((value) => {
    completed = true;
    return value;
  });
  await overlapping.promise;
  expect(completed).toBe(false);
  release.resolve();
  expect((await result).guardrailResults?.map((record) => record.name)).toEqual(
    ['parallel'],
  );
});

it.each([false, true])(
  'owns explicit child input checks (parallel: %s)',
  async (parallel) => {
    const { Environment, NativeAgents, Turn, toolRef } =
      await import('../../src');
    const { startPublicExecutor } = await import('./fixtures/public-executor');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const childrenSeen = new Set<string>();
    let rootId: string | undefined;
    let rootCalls = 0;
    let rootChecks = 0;
    const childCalls = new Set<string>();
    const server = new ModelServer(
      Array.from({ length: 4 }, () => (request: any) => {
        const id = JSON.parse(
          request.client_metadata['x-codex-turn-metadata'],
        ).thread_id;
        rootId ??= id;
        if (id === rootId) {
          if (rootCalls++ === 0)
            return ['alpha', 'beta'].map((name) =>
              call(
                'spawn_agent',
                {
                  task_name: name,
                  message: 'child-input-sentinel',
                  fork_turns: 'none',
                },
                { namespace: 'collaboration', callId: `spawn-${name}` },
              ),
            );
          return [message('root complete')];
        }
        childCalls.add(id);
        return [message('child final before input verdict')];
      }),
    );
    const config = await server.config();
    const executor = await startPublicExecutor();
    try {
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-child-guards',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Spawn both children.',
        model: 'gpt-5.5',
        provider,
        tools: [new NativeAgents({ maxChildren: 2 })],
        inputGuardrails: [
          {
            name: 'initial-input',
            runInParallel: parallel,
            callback({ submission, input }) {
              expect(submission).toBeInstanceOf(Turn);
              expect(input).toBe('root-only-sentinel');
              rootChecks++;
              return { tripwireTriggered: false };
            },
            async childCallback(context) {
              expect(context.stepIndex).toBe(0);
              expect(JSON.stringify(context.input)).toContain(
                'child-input-sentinel',
              );
              expect(JSON.stringify(context.input)).not.toContain(
                'root-only-sentinel',
              );
              childrenSeen.add(context.child.childId);
              if (childrenSeen.size === 2) entered.resolve();
              await release.promise;
              return {
                tripwireTriggered: true,
                outputInfo: context.child.childId,
              };
            },
          },
        ],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const root = await session.submit('root-only-sentinel', {
        beforeStep: ({ stepIndex }) =>
          stepIndex === 0 ? [toolRef('spawn_agent', 'collaboration')] : [],
      });
      await entered.promise;
      expect((await root.wait()).finalOutput).toBe('root complete');
      const children = await Array.fromAsync(session.subagents());
      expect(children).toHaveLength(2);
      if (parallel) {
        const { vi } = await import('vitest');
        await vi.waitFor(() => expect(childCalls.size).toBe(2));
      } else expect(childCalls.size).toBe(0);
      release.resolve();
      for (const child of children) {
        await expect(child.turn!.wait()).rejects.toBeInstanceOf(
          GuardrailTripwire,
        );
        expect(child.turn!.guardrailResults.at(-1)?.subagentId).toBe(child.id);
      }
      expect(rootChecks).toBe(1);
    } finally {
      release.resolve();
      await executor.close();
    }
  },
);

it.each(['approve', 'reject', 'cancel', 'error', 'siblings'] as const)(
  'admits terminal observations once after Core publication: %s',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { provider } = await fixture([
      [call('prior', {}, { callId: 'prior-call' })],
      [
        call('done', {}, { callId: 'terminal-call' }),
        ...(mode === 'siblings'
          ? [call('other', {}, { callId: 'sibling-call' })]
          : []),
      ],
    ]);
    await using _provider = provider;
    await using session = await new Agent({
      instructions: 'Use prior, then done.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'prior',
          parameters: z.object({}),
          execute: () => 'accepted-prior-sibling',
        }),
        tool({
          name: 'done',
          parameters: z.object({}),
          finishTurn: true,
          execute: () => 'terminal-admission-sentinel',
        }),
        tool({
          name: 'other',
          parameters: z.object({}),
          finishTurn: true,
          execute: () => 'separate-terminal-sibling',
        }),
      ],
      outputGuardrails: [
        {
          name: 'admit',
          async callback(context) {
            expect(context.toolCall?.callId).toBe('terminal-call');
            entered.resolve();
            await release.promise;
            if (mode === 'error')
              throw new Error('synthetic guard callback failure');
            return { tripwireTriggered: mode === 'reject' };
          },
        },
      ],
    }).session();
    const turn = await session.submit('begin');
    const events: unknown[] = [];
    const reading = (async () => {
      for await (const event of turn.events({ includeExecutionDetails: true }))
        events.push(event);
    })();
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.stringify(events)).not.toContain(
        'terminal-admission-sentinel',
      );
      expect(
        JSON.stringify(await Array.fromAsync(session.items())),
      ).not.toContain('terminal-admission-sentinel');
      if (mode === 'cancel') {
        const stopped = turn.cancel();
        release.resolve();
        await stopped;
      } else release.resolve();
      if (mode === 'reject')
        await expect(turn.wait()).rejects.toBeInstanceOf(GuardrailTripwire);
      else if (mode === 'error')
        await expect(turn.wait()).rejects.toThrow(
          'synthetic guard callback failure',
        );
      else if (mode === 'cancel') await expect(turn.wait()).rejects.toThrow();
      else
        expect((await turn.wait()).finalOutput).toBe(
          'terminal-admission-sentinel',
        );
      await reading;
      const finished = events.filter(
        (event: any) => event.type === 'tool_finished',
      ) as any[];
      expect(
        finished.filter((event) => event.callId === 'terminal-call'),
      ).toHaveLength(1);
      expect(
        JSON.stringify(finished.find((event) => event.callId === 'prior-call')),
      ).toContain('accepted-prior-sibling');
      if (mode === 'approve' || mode === 'siblings')
        expect(
          JSON.stringify(
            finished.find((event) => event.callId === 'terminal-call'),
          ),
        ).toContain('terminal-admission-sentinel');
      else
        expect(JSON.stringify(events)).not.toContain(
          'terminal-admission-sentinel',
        );
      if (mode === 'siblings') {
        expect(
          finished.filter((event) => event.callId === 'sibling-call'),
        ).toHaveLength(1);
        expect(
          JSON.stringify(
            finished.find((event) => event.callId === 'sibling-call'),
          ),
        ).toContain('separate-terminal-sibling');
      }
    } finally {
      release.resolve();
      await turn.wait().catch(() => {});
      await reading;
    }
  },
);

it.each([false, true])(
  'routes equal terminal call IDs through child owners (reject one: %s)',
  async (rejectOne) => {
    const { Environment, NativeAgents, toolRef } = await import('../../src');
    const { startPublicExecutor } = await import('./fixtures/public-executor');
    let rootId: string | undefined;
    let rootCalls = 0;
    let blockedId: string | undefined;
    const server = new ModelServer(
      Array.from({ length: 4 }, () => (request: any) => {
        const id = JSON.parse(
          request.client_metadata['x-codex-turn-metadata'],
        ).thread_id;
        rootId ??= id;
        if (id === rootId) {
          if (rootCalls++ === 0)
            return ['alpha', 'beta'].map((name) =>
              call(
                'spawn_agent',
                {
                  task_name: name,
                  message: 'Finish through done.',
                  fork_turns: 'none',
                },
                { namespace: 'collaboration', callId: `spawn-${name}` },
              ),
            );
          return [message('root complete')];
        }
        return [call('done', {}, { callId: 'same-child-terminal-call' })];
      }),
    );
    const config = await server.config();
    const executor = await startPublicExecutor();
    try {
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-child-terminal',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Spawn alpha and beta.',
        model: 'gpt-5.5',
        provider,
        tools: [
          new NativeAgents({ maxChildren: 2 }),
          tool({
            name: 'done',
            parameters: z.object({}),
            finishTurn: true,
            execute(_, context) {
              return `child-output:${context.call!.childId}`;
            },
          }),
        ],
        outputGuardrails: [
          {
            name: 'child-output',
            callback(context) {
              if (context.toolCall)
                expect(context.finalOutput).toBe(
                  `child-output:${context.subagentId}`,
                );
              if (rejectOne && context.toolCall)
                blockedId ??= context.subagentId;
              return {
                tripwireTriggered:
                  rejectOne &&
                  context.subagentId === blockedId &&
                  !!context.toolCall,
              };
            },
          },
        ],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const root = await session.submit('start', {
        beforeStep: ({ stepIndex }) =>
          stepIndex === 0 ? [toolRef('spawn_agent', 'collaboration')] : [],
      });
      expect((await root.wait()).finalOutput).toBe('root complete');
      const children = await Array.fromAsync(session.subagents());
      expect(children).toHaveLength(2);
      for (const child of children) {
        if (child.id === blockedId)
          await expect(child.turn!.wait()).rejects.toBeInstanceOf(
            GuardrailTripwire,
          );
        else
          expect((await child.turn!.wait()).finalOutput).toBe(
            `child-output:${child.id}`,
          );
        const events = await Array.fromAsync(
          child.turn!.events({ includeExecutionDetails: true }),
        );
        const finished = events.filter(
          (event) =>
            event.type === 'tool_finished' &&
            event.callId === 'same-child-terminal-call',
        );
        expect(finished).toHaveLength(1);
        if (child.id === blockedId)
          expect(JSON.stringify(events)).not.toContain(
            `child-output:${child.id}`,
          );
        else
          expect(JSON.stringify(finished)).toContain(
            `child-output:${child.id}`,
          );
        expect(JSON.stringify(finished)).not.toContain(
          `child-output:${children.find((other) => other.id !== child.id)!.id}`,
        );
      }
    } finally {
      await executor.close();
    }
  },
);
