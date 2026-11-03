import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  NativeRole,
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
    const target = state.native.descendants.find(
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
