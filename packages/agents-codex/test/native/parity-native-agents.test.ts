import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  NativeRole,
  manualTool,
  parseSessionState,
  tool,
  type ChildInvocation,
  type ExecutorContext,
  type Session,
  type ToolContext,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it.each([true, false])(
  'returns the selected role tool result only after collaboration approval (%s)',
  async (allowed) => {
    const executor = await startPublicExecutor();
    let ordinaryCalls = 0;
    const approvals: string[] = [];
    let childRequest: JsonObject | undefined;
    let finalRequest: JsonObject | undefined;
    try {
      const server = new ModelServer([
        () => [call('research_topic', {}, { callId: 'ordinary' })],
        () => [
          call(
            'research_topic',
            { input: 'Read the requested record.' },
            { namespace: 'collaboration', callId: 'managed' },
          ),
        ],
        ...(allowed
          ? [
              (request: JsonObject) => {
                childRequest = request;
                return [message('managed child result')];
              },
              (request: JsonObject) => {
                finalRequest = request;
                return [message('parent final result')];
              },
            ]
          : []),
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Call the research tool.',
        model: 'gpt-5.5',
        provider,
        tools: [
          tool({
            name: 'research_topic',
            parameters: z.object({}),
            execute: () => {
              ordinaryCalls++;
              return 'ordinary application result';
            },
          }),
          new NativeAgents({
            additionalRoles: [
              new NativeRole({
                name: 'research',
                description: 'Research a topic.',
                instructions: 'MANAGED_ROLE_INSTRUCTIONS',
              }),
            ],
            managedTools: [
              {
                name: 'research_topic',
                role: 'research',
                description: 'Research a topic.',
              },
            ],
            approval(_context, request) {
              approvals.push(request.name);
              return allowed;
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
      const root = await session.submit('Research the record.');
      if (!allowed) {
        await expect(root.wait()).rejects.toBeInstanceOf(NativeError);
        expect(ordinaryCalls).toBe(1);
        expect(approvals).toEqual(['research_topic']);
        expect(server.requests).toHaveLength(2);
        server.assertExhausted();
        return;
      }
      expect((await root.wait()).finalOutput).toBe('parent final result');
      expect(ordinaryCalls).toBe(1);
      expect(approvals).toEqual(['research_topic']);
      if (!childRequest || !finalRequest)
        throw new Error('Expected the child and parent model requests');
      const items = finalRequest.input as JsonObject[];
      const output = items.find(
        (item) =>
          item.type === 'function_call_output' && item.call_id === 'managed',
      );
      expect(output).toBeDefined();
      expect(JSON.stringify(output)).toContain('managed child result');
      const metadata = childRequest.client_metadata as Record<string, string>;
      expect(JSON.parse(metadata['x-codex-turn-metadata']).root_turn_id).toBe(
        root.turnId,
      );
      expect(JSON.stringify(childRequest)).toContain(
        'MANAGED_ROLE_INSTRUCTIONS',
      );
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
);

it('keeps the completed role tool result across a root manual checkpoint', async () => {
  const server = new ModelServer([
    [
      call(
        'research_topic',
        { input: 'Read the record.' },
        { namespace: 'collaboration', callId: 'managed' },
      ),
    ],
    [message('managed result before checkpoint')],
    [call('lookup', { key: 'A' }, { callId: 'root-manual' })],
    [message('resumed parent result')],
  ]);
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read a record.',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const executor = await startPublicExecutor();
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Research before requesting the record.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new NativeAgents({
          additionalRoles: [
            new NativeRole({
              name: 'research',
              description: 'Research a topic.',
              instructions: 'Read the requested record.',
            }),
          ],
          managedTools: [
            {
              name: 'research_topic',
              role: 'research',
              description: 'Research a topic.',
            },
          ],
        }),
        lookup,
      ],
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    await using original = await agent.session({ environment });
    const root = await original.submit('Read the record.');
    const boundary = await root.wait({ until: 'manual_tool' });
    if (!('requests' in boundary) || !lookup.match(boundary.requests[0]))
      throw new Error('Expected the root manual boundary');
    const state = parseSessionState(JSON.stringify(await original.suspend()));
    await original.close();

    await using restored = await agent.session({ state, environment });
    const continuation = restored.restoredTurn;
    if (!continuation) throw new Error('Expected a restored turn');
    const pending = await continuation.wait({ until: 'manual_tool' });
    if (!('requests' in pending))
      throw new Error('Expected a restored request');
    const request = lookup.match(pending.requests[0]);
    if (!request) throw new Error('Expected the same root manual boundary');
    await restored.respond(request.reply('verified'));
    const result = await continuation.wait();
    expect(result.turn.turnId).toBe(root.turnId);
    expect(result.finalOutput).toBe('resumed parent result');
    expect(server.requests).toHaveLength(4);
    const restoredInput = JSON.stringify(server.requests[3].input);
    expect(restoredInput).toContain('managed result before checkpoint');
    expect(restoredInput).toContain('verified');
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30000);

it('retires the exact managed child when its parent turn is cancelled', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    [
      call(
        'research_topic',
        { input: 'Wait for the record.' },
        { namespace: 'collaboration', callId: 'managed' },
      ),
    ],
    async () => {
      started.resolve();
      await release.promise;
      return [message('abandoned child result')];
    },
    [message('next root result')],
  ]);
  const executor = await startPublicExecutor();
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Call the research tool.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new NativeAgents({
          managedTools: [
            {
              name: 'research_topic',
              role: 'default',
              description: 'Research a topic.',
            },
          ],
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
    const root = await session.submit('Research the record.');
    await started.promise;
    const [child] = await Array.fromAsync(session.subagents());
    if (!child?.turn) throw new Error('Expected the exact managed child turn');
    const outcome = child.turn.wait().catch((error: unknown) => error);
    await root.cancel({ mode: 'force' });
    expect(await outcome).toBeInstanceOf(NativeError);
    const next = await session.submit('Continue without the tool.');
    expect((await next.wait()).finalOutput).toBe('next root result');
    server.assertExhausted();
  } finally {
    release.resolve();
    await executor.close();
  }
}, 30000);

it('inherits JS tools and context into a declared role and submits to the exact live child', async () => {
  const executor = await startPublicExecutor();
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  let childRequest: JsonObject | undefined;
  const reply = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId)
      return count === 1
        ? [
            call(
              'spawn_agent',
              {
                task_name: 'research',
                message: 'Check the record.',
                agent_type: 'research',
              },
              { namespace: 'collaboration', callId: 'spawn-research' },
            ),
          ]
        : [message('root finished')];
    childRequest = request;
    if (count === 1)
      return [call('lookup', { key: 'record' }, { callId: 'child-lookup' })];
    if (count === 4)
      return [
        call('exec_command', { cmd: 'true' }, { callId: 'child-command' }),
      ];
    return [message(count === 2 ? 'child finished' : 'child followed up')];
  };
  const server = new ModelServer(Array.from({ length: 6 }, () => reply));
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  const context = { value: 'found' };
  let observed: ToolContext<typeof context> | undefined;
  const executorApprovals: ExecutorContext<typeof context>[] = [];
  let called!: () => void;
  const callback = new Promise<void>((resolve) => {
    called = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const approvals: string[] = [];
  const agent = new Agent<typeof context>({
    instructions: 'Delegate to research.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new NativeAgents({
        additionalRoles: [
          new NativeRole({
            name: 'research',
            description: 'Checks records',
            instructions: 'ROLE_RESEARCH_MARKER',
          }),
        ],
        approval(ctx, call) {
          expect(ctx.context).toBe(context);
          expect(ctx.call).toMatchObject({
            sessionId: ctx.submission.sessionId,
            turnId: call.turnId,
            callId: call.callId,
            tool: { namespace: 'collaboration', name: call.name },
            role: call.agentRole,
            model: call.model,
            childId: null,
            childIncarnation: null,
          });
          expect(call.model).toBe('gpt-5.5');
          expect(call.agentRole).toBeNull();
          expect(Object.isFrozen(ctx.call)).toBe(true);
          approvals.push(call.name);
          return true;
        },
      }),
      tool({
        name: 'lookup',
        parameters: z.object({ key: z.string() }),
        async execute(_, ctx: ToolContext<typeof context>) {
          observed = ctx;
          called();
          await held;
          return ctx.context.value;
        },
      }),
    ],
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session({
      context,
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
        approval(ctx) {
          executorApprovals.push(ctx);
          return false;
        },
      }),
    });
    const root = await session.submit('begin');
    expect((await root.wait()).finalOutput).toBe('root finished');
    await callback;
    const children = [];
    for await (const child of session.subagents()) children.push(child);
    expect(children).toHaveLength(1);
    const child = children[0];
    expect(child.isLive).toBe(true);
    const original = child.turn!;
    const steered = await child.submit('STEER_CURRENT_CHILD');
    expect(steered).toBe(original);
    release();
    expect((await original.wait()).finalOutput).toBe('child finished');
    expect(observed?.context).toBe(context);
    expect((observed?.submission as ChildInvocation).childId).toBe(child.id);
    expect(original.childId).toBe(child.id);
    expect(observed?.call).toMatchObject({
      sessionId: session.id,
      turnId: original.turnId,
      childId: child.id,
      childIncarnation: original.submissionId.split(':').at(-2),
      callId: 'child-lookup',
      role: null,
      model: childRequest!.model,
      route: 'direct',
      outerCallId: null,
      cellId: null,
      nestedCallId: null,
    });
    expect(JSON.stringify(childRequest)).toContain('ROLE_RESEARCH_MARKER');
    expect(JSON.stringify(childRequest)).toContain('STEER_CURRENT_CHILD');
    const followup = await child.submit('Check again.');
    expect(followup.turnId).not.toBe(original.turnId);
    expect((await followup.wait()).finalOutput).toBe('child followed up');
    expect((await original.wait()).finalOutput).toBe('child finished');
    expect(approvals).toEqual(['spawn_agent']);
    const denied = await child.submit('Run a command.');
    await expect(denied.wait()).rejects.toBeInstanceOf(NativeError);
    for await (const event of session.events()) {
      if (event.type === 'turn_finished' && event.turnId === denied.turnId) {
        expect(event).toMatchObject({
          submissionId: denied.submissionId,
          status: 'failed',
          errorType: 'NativeError',
        });
        break;
      }
    }
    expect(executorApprovals).toHaveLength(1);
    const approval = executorApprovals[0];
    expect(approval.context).toBe(context);
    expect(approval.toolName).toBe('exec_command');
    expect(approval.call).toMatchObject({
      sessionId: session.id,
      turnId: denied.turnId,
      childId: child.id,
      childIncarnation: denied.submissionId.split(':').at(-2),
      tool: { name: 'exec_command' },
      callId: approval.callId,
      role: approval.agentRole,
      model: approval.model,
      route: 'direct',
      outerCallId: null,
      cellId: null,
      nestedCallId: null,
    });
    expect(approval.agentRole).toBe('research');
    expect(approval.model).toBe('gpt-5.5');
    expect(approval.submission).toMatchObject({
      childId: child.id,
      turnId: denied.turnId,
      sessionId: session.id,
    } satisfies Partial<ChildInvocation>);
    expect(
      executor.requests.filter((request) => request.method === 'process/start'),
    ).toHaveLength(0);
    server.assertExhausted();
  } finally {
    release();
    try {
      await session?.close();
    } finally {
      try {
        await provider.close();
      } finally {
        await executor.close();
      }
    }
  }
}, 20000);

it('captures a reloaded child when its row is issued by an open iterator', async () => {
  let rootId: string | undefined;
  let rootCalls = ['alpha', 'beta'].map((name) =>
    call(
      'spawn_agent',
      { task_name: name, message: 'Finish.' },
      { namespace: 'collaboration', callId: name },
    ),
  );
  let childRequests = 0;
  const reply = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId)
      return rootCalls.length
        ? rootCalls.splice(0)
        : [message('root complete')];
    childRequests++;
    return [message('child response ' + childRequests)];
  };
  async function finishChildren(
    session: Session,
    input: string,
    count: number,
  ) {
    const root = await session.submit(input);
    await root.wait();
    const finished = new Set<string>();
    for await (const event of session.events()) {
      if (
        event.type === 'turn_finished' &&
        event.submissionId !== root.submissionId
      ) {
        finished.add(event.submissionId);
        if (finished.size === count) return;
      }
    }
    throw new Error('Session closed before the children finished');
  }
  const server = new ModelServer(Array.from({ length: 8 }, () => reply));
  const config = await server.config();
  const executor = await startPublicExecutor();
  try {
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const agent = new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents()],
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    let state;
    {
      await using source = await agent.session({ environment });
      await finishChildren(source, 'Start both workers.', 2);
      state = await source.saveState();
    }
    await using restored = await agent.session({ environment, state });
    const iterator = restored.subagents();
    const first = (await iterator.next()).value!;
    expect(first.isLive).toBe(false);
    const target = state.descendants.find(
      (child) => child.thread_id !== first.id,
    )!.thread_id;
    rootCalls = [
      call(
        'followup_task',
        { target, message: 'Run again.' },
        { namespace: 'collaboration', callId: 'wake' },
      ),
    ];
    await finishChildren(restored, 'Wake the other worker.', 1);
    const second = (await iterator.next()).value!;
    expect(second.id).toBe(target);
    expect(second.isLive).toBe(true);
    expect((await second.turn!.wait()).finalOutput).toBe('child response 3');
    const next = await second.submit('Follow up.');
    expect(next.instanceId).toBe(second.turn!.instanceId);
    expect((await next.wait()).finalOutput).toBe('child response 4');
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 20_000);
