import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  HttpMCP,
  checklist,
  localStorage,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
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
const update = (
  plan: { step: string; status: string }[],
  callId: string,
  explanation?: string,
) =>
  call(
    'update_plan',
    { plan, ...(explanation === undefined ? {} : { explanation }) },
    { callId },
  );
const nativePlan = (request: JsonObject) =>
  (request.tools as { type: string; name?: string }[]).some(
    (t) => t.type === 'function' && t.name === 'update_plan',
  );

it('reads accepted whole-list updates, keeps invalid updates out and preserves the fixed grant across leaf updates', async () => {
  const first = [
    { step: 'Inspect', status: 'in_progress' },
    { step: 'Report', status: 'pending' },
  ];
  const last = [{ step: 'Report', status: 'completed' }];
  const server = new ModelServer([
    [update(first, 'first', 'phase one')],
    [message('first')],
    [update([{ step: 'invalid', status: 'done' }], 'invalid')],
    [message('unchanged')],
    [call('lookup', {}, { callId: 'lookup' })],
    [update([], 'empty', '')],
    [message('empty')],
    [update(last, 'last')],
    [message('last')],
  ]);
  await using provider = await providerFor(server);
  const effects: string[] = [];
  const lookup = (value: string) =>
    tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => {
        effects.push(value);
        return value;
      },
    });
  const agent = new Agent({
    instructions: 'Inspect.',
    model: 'gpt-5',
    provider,
    tools: [checklist(), lookup('old')],
  });
  const session = await agent.session();
  try {
    expect(await session.checklist()).toBeNull();
    expect(server.requests).toHaveLength(0);
    const firstTurn = await session.submit('Begin.');
    await firstTurn.wait();
    const accepted = {
      threadId: session.id,
      turnId: firstTurn.turnId,
      explanation: 'phase one',
      plan: first,
    };
    expect(await session.checklist()).toEqual(accepted);
    expect(nativePlan(server.requests[0])).toBe(true);
    expect(JSON.stringify(server.requests[1].input)).toContain('Plan updated');
    const count = server.requests.length;
    const snapshot = (await session.checklist())!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot.plan[0], 'step', 'changed')).toBe(false);
    expect(server.requests).toHaveLength(count);
    await (await session.submit('Invalid update.')).wait();
    expect(await session.checklist()).toEqual(accepted);
    const rejected = (server.requests[3].input as JsonObject[]).find(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'invalid',
    );
    expect(rejected).toBeDefined();
    expect(JSON.stringify(rejected!.output)).not.toContain('Plan updated');
    await expect(
      session.update({ tools: [checklist()] }),
    ).rejects.toBeInstanceOf(TypeError);
    await session.update({ tools: [lookup('current')] });
    const emptyTurn = await session.submit('Empty the list.');
    await emptyTurn.wait();
    expect(effects).toEqual(['current']);
    expect(await session.checklist()).toEqual({
      threadId: session.id,
      turnId: emptyTurn.turnId,
      explanation: '',
      plan: [],
    });
    await session.update({ tools: [] });
    const lastTurn = await session.submit('Replace it.');
    await lastTurn.wait();
    expect(nativePlan(server.requests[7])).toBe(true);
    expect(await session.checklist()).toEqual({
      threadId: session.id,
      turnId: lastTurn.turnId,
      explanation: null,
      plan: last,
    });
    const saved = await session.saveState();
    expect(saved.native.root_checklist?.plan).toEqual(last);
    server.assertExhausted();
  } finally {
    await session.close();
  }
  await expect(session.checklist()).rejects.toThrow();
});

it('does not treat a same-named application callback as native checklist state', async () => {
  const server = new ModelServer([
    [call('update_plan', {}, { callId: 'ordinary' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  let calls = 0;
  const agent = new Agent({
    instructions: 'Inspect.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'update_plan',
        parameters: z.object({}),
        execute: () => {
          calls++;
          return 'Plan updated';
        },
      }),
    ],
  });
  await using session = await agent.session();
  await (await session.submit('Use the application tool.')).wait();
  expect(calls).toBe(1);
  expect(await session.checklist()).toBeNull();
  server.assertExhausted();
});

it('restores data without update authority and permits a fresh destination declaration', async () => {
  const before = [{ step: 'Read', status: 'pending' }];
  const after = [{ step: 'Read', status: 'completed' }];
  const server = new ModelServer([
    [update(before, 'source')],
    [message('source')],
    [update(after, 'ungranted')],
    [message('read only')],
    [update(after, 'destination')],
    [message('destination')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Inspect.',
    model: 'gpt-5',
    provider,
    tools: [checklist()],
  });
  let state;
  let accepted;
  {
    await using source = await agent.session();
    await (await source.submit('Read.')).wait();
    accepted = await source.checklist();
    state = await source.saveState();
  }
  {
    await using readonly = await agent.session({ state, tools: [] });
    const expected = { ...accepted, threadId: readonly.id };
    const count = server.requests.length;
    expect(await readonly.checklist()).toEqual(expected);
    expect(server.requests).toHaveLength(count);
    await (await readonly.submit('Try an update.')).wait();
    expect(nativePlan(server.requests[2])).toBe(false);
    expect(await readonly.checklist()).toEqual(expected);
    await expect(readonly.update({ tools: [checklist()] })).rejects.toThrow();
  }
  {
    await using destination = await agent.session({ state });
    const turn = await destination.submit('Finish.');
    await turn.wait();
    expect(nativePlan(server.requests[4])).toBe(true);
    expect(await destination.checklist()).toEqual({
      threadId: destination.id,
      turnId: turn.turnId,
      explanation: null,
      plan: after,
    });
  }
  server.assertExhausted();
});

it('reads during an active tool callback without waiting for the turn to finish', async () => {
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = new ModelServer([
    [call('hold', {}, { callId: 'hold' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Wait.',
    model: 'gpt-5',
    provider,
    tools: [
      checklist(),
      tool({
        name: 'hold',
        parameters: z.object({}),
        execute: async () => {
          entered();
          await hold;
          return 'released';
        },
      }),
    ],
  });
  const session = await agent.session();
  try {
    const turn = await session.submit('Hold.');
    await reached;
    expect(await session.checklist()).toBeNull();
    expect(server.requests).toHaveLength(1);
    release();
    expect((await turn.wait()).finalOutput).toBe('done');
  } finally {
    release();
    await session.close();
  }
  server.assertExhausted();
});

it('captures opening inheritance and returns null before any local checklist update', async () => {
  const server = new ModelServer([[message('inherited')], [message('empty')]]);
  await using provider = await providerFor(server);
  const tools = [checklist()];
  const agent = new Agent({
    instructions: 'Inspect.',
    model: 'gpt-5',
    provider,
    tools,
  });
  {
    await using inherited = await agent.session();
    agent.tools = [];
    await (await inherited.submit('Read.')).wait();
    expect(nativePlan(server.requests[0])).toBe(true);
  }
  {
    await using empty = await agent.session({ tools: [] });
    await (await empty.submit('Read.')).wait();
    expect(nativePlan(server.requests[1])).toBe(false);
  }
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const profile = await mkdtemp(join(tmpdir(), 'checklist-profile-'));
  try {
    await using local = await agent.session({ storage: localStorage(profile) });
    await expect(local.checklist()).resolves.toBeNull();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
  server.assertExhausted();
});

it.each([false, true])(
  'keeps a same-named MCP leaf distinct from native authority (grant=%s)',
  async (grant) => {
    let mcpCalls = 0;
    const peer = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'planner', version: '1' },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'update_plan',
                    description: 'An unrelated MCP leaf.',
                    inputSchema: {
                      type: 'object',
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : rpc.method === 'tools/call'
              ? (mcpCalls++, { content: [{ type: 'text', text: 'MCP only' }] })
              : {};
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    peer.listen(0, '127.0.0.1');
    await once(peer, 'listening');
    try {
      const { port } = peer.address() as { port: number };
      const server = new ModelServer([
        [call('update_plan', {}, { namespace: 'mcp__planner', callId: 'mcp' })],
        ...(grant
          ? [[update([{ step: 'Native', status: 'completed' }], 'native')]]
          : []),
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Inspect.',
        model: 'gpt-5',
        provider,
        tools: [
          new HttpMCP({
            name: 'planner',
            approvalMode: 'approve',
            url: `http://127.0.0.1:${port}`,
            tools: ['update_plan'],
          }),
          ...(grant ? [checklist()] : []),
        ],
      });
      await using session = await agent.session();
      await (await session.submit('Call the distinct tools.')).wait();
      expect(mcpCalls).toBe(1);
      expect(nativePlan(server.requests[0])).toBe(grant);
      if (grant)
        expect((await session.checklist())?.plan).toEqual([
          { step: 'Native', status: 'completed' },
        ]);
      else expect(await session.checklist()).toBeNull();
      server.assertExhausted();
    } finally {
      await new Promise<void>((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
