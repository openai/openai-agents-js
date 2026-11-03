import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  manualTool,
  tool,
  type ActionRequested,
  type ToolCallInfo,
  type ToolContext,
  type ExecutorContext,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import type { JsonObject } from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

function metadata(context: { call?: ToolCallInfo }): ToolCallInfo {
  expect(context.call).toBeDefined();
  expect(Object.isFrozen(context.call)).toBe(true);
  expect(Object.isFrozen(context.call!.tool)).toBe(true);
  return context.call!;
}

it('separates provider identity from code execution IDs on actual function calls', async () => {
  const seen: ToolContext[] = [];
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'outer-provider',
        input: 'text(await tools.lookup({key:"code"}));',
      },
    ],
    (request) => {
      expect(JSON.stringify(request.input)).toContain('accepted-code');
      return [message('code done')];
    },
    [call('lookup', { key: 'direct' }, { callId: 'direct-provider' })],
    (request) => {
      expect(JSON.stringify(request.input)).toContain('accepted-direct');
      return [message('direct done')];
    },
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5.5',
    provider,
    programmaticToolCalling: true,
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({ key: z.string() }),
        execute(args, context) {
          seen.push(context);
          return `accepted-${args.key}`;
        },
      }),
    ],
  });
  await using session = await agent.session();
  const first = await session.submit('code');
  expect((await first.wait()).finalOutput).toBe('code done');
  const second = await session.submit('direct');
  expect((await second.wait()).finalOutput).toBe('direct done');
  expect(seen).toHaveLength(2);
  const code = metadata(seen[0]);
  const direct = metadata(seen[1]);
  expect(code).toMatchObject({
    tool: { name: 'lookup', namespace: null },
    sessionId: session.id,
    turnId: first.turnId,
    callId: null,
    outerCallId: null,
    childId: null,
    childIncarnation: null,
    role: null,
    route: 'code',
    model: server.requests[0].model,
  });
  expect(code.cellId).toEqual(expect.any(String));
  expect(code.nestedCallId).toEqual(expect.any(String));
  expect(code.cellId).not.toBe(code.nestedCallId);
  expect(seen[0].callId).toEqual(expect.any(String));
  expect(seen[0].submission).toBe(first);
  expect(direct).toEqual({
    tool: { name: 'lookup', namespace: null },
    sessionId: session.id,
    turnId: second.turnId,
    callId: 'direct-provider',
    outerCallId: null,
    childId: null,
    childIncarnation: null,
    role: null,
    route: 'direct',
    model: server.requests[2].model,
    cellId: null,
    nestedCallId: null,
  });
  expect(seen[1].callId).toBe('direct-provider');
  server.assertExhausted();
}, 30_000);

it('keeps overlapping code manual calls separate when replied to in reverse order', async () => {
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'manual-outer',
        input:
          'const values = await Promise.all([tools.lookup({key:"a"}), tools.lookup({key:"b"})]); text(JSON.stringify(values));',
      },
    ],
    (request) => {
      expect(JSON.stringify(request.input)).toContain('accepted-a');
      expect(JSON.stringify(request.input)).toContain('accepted-b');
      return [message('both accepted')];
    },
  ]);
  await using provider = await providerFor(server);
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read a key.',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5.5',
    provider,
    tools: [lookup],
    programmaticToolCalling: true,
  });
  await using session = await agent.session();
  const turn = await session.submit('both');
  const requests: ActionRequested<{ key: string }, string>[] = [];
  for await (const event of session.events()) {
    const request = lookup.match(event);
    if (request) requests.push(request);
    if (requests.length === 2) break;
  }
  expect(requests.map((r) => r.arguments.key).sort()).toEqual(['a', 'b']);
  for (const request of requests) {
    expect(metadata(request)).toMatchObject({
      sessionId: session.id,
      turnId: turn.turnId,
      route: 'code',
      callId: null,
      outerCallId: null,
      model: server.requests[0].model,
      role: null,
    });
    expect(metadata(request).cellId).toEqual(expect.any(String));
    expect(metadata(request).nestedCallId).toEqual(expect.any(String));
    expect(lookup.match({ ...request })).toBeUndefined();
  }
  expect(new Set(requests.map((r) => r.callId)).size).toBe(2);
  expect(new Set(requests.map((r) => metadata(r).nestedCallId)).size).toBe(2);
  for (const request of requests.toReversed())
    await session.submit(request.reply(`accepted-${request.arguments.key}`));
  expect((await turn.wait()).finalOutput).toBe('both accepted');
  server.assertExhausted();
}, 30_000);

it('restores direct manual metadata from the original turn model', async () => {
  const server = new ModelServer([
    [call('decision', {}, { callId: 'original-provider' })],
    [message('accepted')],
  ]);
  await using provider = await providerFor(server);
  const decision = manualTool({
    name: 'decision',
    description: 'Get a decision.',
    parameters: z.object({}),
    result: z.string(),
  });
  const declaration = {
    instructions: 'Ask decision.',
    model: 'gpt-5.5',
    provider,
    tools: [decision],
  };
  const agent = new Agent(declaration);
  const session = await agent.session();
  let state;
  let original: ToolCallInfo | undefined;
  try {
    await session.submit('ask');
    for await (const event of session.events()) {
      if (event.type === 'action_requested') {
        original = metadata(event);
        break;
      }
    }
    expect(original?.model).toBe(server.requests[0].model);
    state = await session.suspend();
  } finally {
    await session.close();
  }
  const reopened = new Agent({ ...declaration, model: 'gpt-5' });
  await using restored = await reopened.session({ state });
  for await (const event of restored.events()) {
    const request = decision.match(event);
    if (!request) continue;
    expect(metadata(request)).toEqual({ ...original, sessionId: restored.id });
    expect(metadata(request).model).toBe('gpt-5.5');
    expect(metadata(request).route).toBe('direct');
    expect(metadata(request).callId).toBe('original-provider');
    const turn = await restored.submit(request.reply('accepted'));
    expect((await turn.wait()).finalOutput).toBe('accepted');
    break;
  }
  server.assertExhausted();
}, 30_000);

it('keeps sibling manual owners distinct when their provider call IDs match', async () => {
  const executor = await startPublicExecutor();
  let rootId: string | undefined;
  const counts = new Map<string, number>();
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === rootId)
      return count === 1
        ? ['alpha', 'beta'].map((name) =>
            call(
              'spawn_agent',
              { task_name: name, message: 'Ask decision.' },
              { namespace: 'collaboration', callId: `spawn-${name}` },
            ),
          )
        : [message('root done')];
    if (count === 1)
      return [call('decision', { key: id }, { callId: 'same-provider' })];
    expect(JSON.stringify(request.input)).toContain(`accepted-${id}`);
    return [message(`child-${id}`)];
  };
  const server = new ModelServer(Array.from({ length: 6 }, () => respond));
  try {
    await using provider = await providerFor(server);
    const decision = manualTool({
      name: 'decision',
      description: 'Get a decision.',
      parameters: z.object({ key: z.string() }),
      result: z.string(),
    });
    const agent = new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents(), decision],
    });
    await using session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
      'root done',
    );
    const requests: ActionRequested<{ key: string }, string>[] = [];
    for await (const event of session.events()) {
      const request = decision.match(event);
      if (request) requests.push(request);
      if (requests.length === 2) break;
    }
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((r) => r.callId)).size).toBe(1);
    expect(new Set(requests.map((r) => metadata(r).childId)).size).toBe(2);
    expect(
      new Set(requests.map((r) => metadata(r).childIncarnation)).size,
    ).toBe(2);
    for (const request of requests.toReversed()) {
      const info = metadata(request);
      expect(info).toMatchObject({
        sessionId: session.id,
        childId: request.arguments.key,
        turnId: request.turnId,
        callId: 'same-provider',
        role: null,
        route: 'direct',
        model: 'gpt-5.5',
      });
      const turn = await session.submit(
        request.reply(`accepted-${request.arguments.key}`),
      );
      expect(turn.childId).toBe(info.childId);
      expect(turn.submissionId.split(':').at(-2)).toBe(info.childIncarnation);
      expect(turn.instanceId).not.toBe(info.childIncarnation);
      expect((await turn.wait()).finalOutput).toBe(
        `child-${request.arguments.key}`,
      );
    }
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);

it('preserves outer, cell and nested identities when a denied code executor stops its turn', async () => {
  const executor = await startPublicExecutor();
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'executor-outer',
        input:
          'try { text(await tools.exec_command({cmd:"true"})); } catch { text("denied"); }',
      },
    ],
  ]);
  const seen: ExecutorContext[] = [];
  try {
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Try the command.',
      model: 'gpt-5.5',
      provider,
      programmaticToolCalling: true,
    });
    await using session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        approval(context) {
          seen.push(context);
          return false;
        },
      }),
    });
    const turn = await session.submit('try');
    const completion = turn.wait();
    await expect(completion).rejects.toBeInstanceOf(NativeError);
    await expect(completion).rejects.toThrow('Turn stopped by executor policy');
    expect(server.requests).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const info = metadata(seen[0]);
    expect(info).toMatchObject({
      sessionId: session.id,
      turnId: turn.turnId,
      childId: null,
      childIncarnation: null,
      callId: null,
      outerCallId: 'executor-outer',
      route: 'code',
      role: null,
      model: server.requests[0].model,
      tool: { name: 'exec_command' },
    });
    expect(info.cellId).toEqual(expect.any(String));
    expect(info.nestedCallId).toEqual(expect.any(String));
    expect(
      new Set([info.outerCallId, info.cellId, info.nestedCallId]).size,
    ).toBe(3);
    expect(seen[0].outerCallId).toBe(info.outerCallId);
    expect(seen[0].runtimeToolCallId).toBe(info.nestedCallId);
    expect(
      executor.requests.filter((request) => request.method === 'process/start'),
    ).toHaveLength(0);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);
