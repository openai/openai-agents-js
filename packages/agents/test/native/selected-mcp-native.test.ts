import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  HttpMCP,
  checklist,
  localStorage,
  nativeGoals,
  selectMcpTools,
  tool,
  type Session,
} from '../../src';
import { jsonObject, type JsonObject } from '../../src/runtime/binding';
import { BorrowedPeer, borrowedDeclaration } from './fixtures/borrowed-mcp';
import { ModelServer, call, message } from './fixtures/model-server';

const profiles: string[] = [];
const sessions: Session[] = [];
const providers: NativeProvider[] = [];
afterEach(async () => {
  const ownedProfiles = profiles.splice(0);
  const failures: unknown[] = [];
  for (const session of sessions.splice(0).reverse()) {
    try {
      await session.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const provider of providers.splice(0).reverse()) {
    try {
      await provider.close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await ModelServer.closeAll();
  } catch (error) {
    failures.push(error);
  }
  if (!failures.length) {
    for (const profile of ownedProfiles) {
      try {
        await rm(profile, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Selected MCP cleanup failed');
});

async function providerFor(model: ModelServer) {
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: jsonObject.parse(config['model_providers.fixture'])
      .base_url as string,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  providers.push(provider);
  return provider;
}

function wireTools(
  request: JsonObject,
): Array<{ namespace: string | null; name: string; parameters: unknown }> {
  const result: Array<{
    namespace: string | null;
    name: string;
    parameters: unknown;
  }> = [];
  function add(values: unknown, namespace: string | null = null) {
    if (!Array.isArray(values)) return;
    for (const raw of values) {
      const spec = jsonObject.parse(raw);
      if (spec.type === 'namespace') add(spec.tools, spec.name as string);
      else if (spec.type === 'function')
        result.push({
          namespace,
          name: spec.name as string,
          parameters: spec.parameters,
        });
    }
  }
  add(request.tools);
  if (Array.isArray(request.input)) {
    for (const raw of request.input) {
      const item = jsonObject.parse(raw);
      if (item.type === 'additional_tools') add(item.tools);
    }
  }
  return result;
}

it.each(['gpt-5.5', 'gpt-6-astra'])(
  'dispatches two raw-schema tools in one namespace alongside an ordinary same-name function (%s)',
  async (modelName) => {
    const peer = new BorrowedPeer();
    peer.declarations.push(borrowedDeclaration('save'));
    Object.assign(peer.declarations[0].inputSchema, {
      'x-selected': { raw: true },
    });
    const selected = await selectMcpTools(
      { name: 'crm', server: peer },
      { context: undefined },
    );
    const observed: Array<{ namespace: string | null; name: string }> = [];
    const ordinary = tool({
      name: 'lookup',
      parameters: z.object({ value: z.string() }),
      execute: (_args, ctx) => {
        observed.push(ctx.call!.tool);
        return 'ordinary';
      },
    });
    const model = new ModelServer([
      [
        call(
          'lookup',
          { value: 'aa' },
          { namespace: 'crm', callId: 'crm-lookup' },
        ),
        call('save', { value: 'bb' }, { namespace: 'crm', callId: 'crm-save' }),
        call('lookup', { value: 'cc' }, { callId: 'plain-lookup' }),
      ],
      [message('done')],
    ]);
    const session = await new Agent({
      instructions: 'Use the selected tools.',
      model: modelName,
      programmaticToolCalling: false,
      provider: await providerFor(model),
      tools: [ordinary, ...selected],
    }).session();
    sessions.push(session);
    expect((await (await session.submit('run')).wait()).finalOutput).toBe(
      'done',
    );
    // Core may start independent tool calls in any order.
    const calls = peer.callTool.mock.calls.map(([name, args]) => [name, args]);
    expect(calls, JSON.stringify(calls)).toHaveLength(2);
    expect(calls, JSON.stringify(calls)).toEqual(
      expect.arrayContaining([
        ['lookup', { value: 'aa' }],
        ['save', { value: 'bb' }],
      ]),
    );
    expect(observed).toEqual([{ namespace: null, name: 'lookup' }]);
    const starts: Array<{ namespace: string | null; name: string }> = [];
    for await (const event of session.events()) {
      if (event.type === 'tool_started')
        starts.push({ namespace: event.namespace, name: event.name });
      if (event.type === 'turn_finished') break;
    }
    expect(starts, JSON.stringify(starts)).toHaveLength(3);
    expect(starts, JSON.stringify(starts)).toEqual(
      expect.arrayContaining([
        { namespace: 'crm', name: 'lookup' },
        { namespace: 'crm', name: 'save' },
        { namespace: null, name: 'lookup' },
      ]),
    );
    const tools = wireTools(model.requests[0]);
    expect(
      tools
        .filter((entry) => entry.namespace === 'crm')
        .map((entry) => entry.name)
        .sort(),
      JSON.stringify(tools.map(({ namespace, name }) => ({ namespace, name }))),
    ).toEqual(['lookup', 'save']);
    expect(
      tools.find(
        (entry) => entry.namespace === 'crm' && entry.name === 'lookup',
      )?.parameters,
    ).toEqual(peer.declarations[0].inputSchema);
    expect(
      tools.some(
        (entry) => entry.namespace !== 'crm' && entry.name === 'lookup',
      ),
    ).toBe(true);
    model.assertExhausted();
    expect(peer.close).not.toHaveBeenCalled();
  },
);

it('preserves the exact opening namespace ceiling across normal updates', async () => {
  const peer = new BorrowedPeer();
  const initial = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined },
  );
  const model = new ModelServer([[message('ready')]]);
  const session = await new Agent({
    instructions: 'No tools needed.',
    model: 'gpt-5.5',
    provider: await providerFor(model),
    tools: [...initial],
  }).session();
  sessions.push(session);
  const otherNamespace = await selectMcpTools(
    { name: 'other', server: peer },
    { context: undefined },
  );
  await expect(session.update({ tools: [...otherNamespace] })).rejects.toThrow(
    'declared when',
  );
  peer.declarations = [borrowedDeclaration('late')];
  const late = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined },
  );
  await expect(session.update({ tools: [...late] })).rejects.toThrow(
    'declared when',
  );
  expect((await (await session.submit('go')).wait()).finalOutput).toBe('ready');
  expect(peer.callTool).not.toHaveBeenCalled();
  model.assertExhausted();
});

it('reopens a local profile with a current MCP selection and rejects denied calls before dispatch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'selected-mcp-local-'));
  profiles.push(home);
  const storage = localStorage(join(home, 'profile'));
  const model = new ModelServer([
    [
      call(
        'lookup',
        { value: 'original' },
        { namespace: 'crm', callId: 'first' },
      ),
    ],
    [message('saved')],
    [
      call(
        'lookup',
        { value: 'current' },
        { namespace: 'crm', callId: 'second' },
      ),
    ],
    [message('reopened')],
    [call('lookup', { value: 'denied' }, { namespace: 'crm', callId: 'deny' })],
  ]);
  const provider = await providerFor(model);
  async function agentFor(peer: BorrowedPeer, approvedId: string) {
    peer.declarations.push(borrowedDeclaration('write'));
    const tools = await selectMcpTools(
      { name: 'crm', server: peer },
      {
        context: undefined,
        toolNames: ['lookup'],
        approval: ({ callId }) => callId === approvedId,
      },
    );
    return new Agent({
      instructions: 'Use only the selected CRM tools.',
      model: 'gpt-5.5',
      provider,
      tools: [...tools],
    });
  }

  const original = new BorrowedPeer();
  const first = await (await agentFor(original, 'first')).session({ storage });
  sessions.push(first);
  const id = first.id;
  expect((await (await first.submit('Start.')).wait()).finalOutput).toBe(
    'saved',
  );
  await first.close();

  const current = new BorrowedPeer();
  const second = await (
    await agentFor(current, 'second')
  ).session({ storage, resume: id });
  sessions.push(second);
  expect(second.id).toBe(id);
  expect((await (await second.submit('Continue.')).wait()).finalOutput).toBe(
    'reopened',
  );
  const denied = await second.submit('Request approval.');
  await expect(denied.wait()).rejects.toThrow(
    'Selected MCP call was not approved',
  );
  await second.close();

  for (const request of [model.requests[0], model.requests[2]]) {
    expect(
      wireTools(request).filter((entry) => entry.namespace === 'crm'),
    ).toEqual([
      {
        namespace: 'crm',
        name: 'lookup',
        parameters: original.declarations[0].inputSchema,
      },
    ]);
  }
  const history = z.array(jsonObject).parse(model.requests[2].input);
  const priorResult = history.find(
    (item) => item.type === 'function_call_output' && item.call_id === 'first',
  );
  expect(JSON.stringify(priorResult?.output)).toContain('original');
  expect(
    original.callTool.mock.calls.map(([name, args]) => [name, args]),
  ).toEqual([['lookup', { value: 'original' }]]);
  expect(
    current.callTool.mock.calls.map(([name, args]) => [name, args]),
  ).toEqual([['lookup', { value: 'current' }]]);
  expect(original.close).not.toHaveBeenCalled();
  expect(current.close).not.toHaveBeenCalled();
  model.assertExhausted();
});

it('composes distinct namespace names with checklist and code-mode builtins', async () => {
  const peer = new BorrowedPeer();
  peer.declarations = ['update_plan', 'exec', 'wait'].map(borrowedDeclaration);
  const selected = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined },
  );
  const model = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'borrowed-code',
        // Core's existing code-mode global for the crm.exec pair is crm__exec.
        input: 'text(await tools.crm__exec({value:"code-value"}));',
      },
    ],
    (request: JsonObject) => {
      expect(JSON.stringify(request.input)).toContain('code-value');
      return [message('ready')];
    },
  ]);
  const provider = await providerFor(model);
  await expect(
    new Agent({
      instructions: 'Invalid default collision.',
      provider,
      tools: [
        checklist(),
        tool({
          name: 'update_plan',
          parameters: z.object({}),
          execute: () => '',
        }),
      ],
    }).session(),
  ).rejects.toThrow('reserves');
  await expect(
    new Agent({
      instructions: 'Invalid code-mode collision.',
      provider,
      programmaticToolCalling: true,
      tools: [
        tool({ name: 'exec', parameters: z.object({}), execute: () => '' }),
      ],
    }).session(),
  ).rejects.toThrow('reserves');
  const session = await new Agent({
    instructions: 'No tools needed.',
    model: 'gpt-5.5',
    provider,
    tools: [checklist(), ...selected],
    programmaticToolCalling: true,
  }).session();
  sessions.push(session);
  expect((await (await session.submit('go')).wait()).finalOutput).toBe('ready');
  expect(peer.callTool.mock.calls.map(([name, args]) => [name, args])).toEqual([
    ['exec', { value: 'code-value' }],
  ]);
  model.assertExhausted();
});

it('rejects a borrowed/native MCP pair collision before native connection startup', async () => {
  const peer = new BorrowedPeer();
  const selected = await selectMcpTools(
    { name: 'mcp__crm', server: peer },
    { context: undefined },
  );
  const model = new ModelServer([]);
  const provider = await providerFor(model);
  await expect(
    new Agent({
      instructions: 'Never connect.',
      model: 'gpt-5.5',
      provider,
      tools: [
        ...selected,
        new HttpMCP({
          name: 'crm',
          url: 'http://127.0.0.1:1/mcp',
          tools: ['lookup'],
        }),
      ],
    }).session(),
  ).rejects.toThrow('Duplicate selected tool mcp__crm.lookup');
  expect(peer.callTool).not.toHaveBeenCalled();
  model.assertExhausted();
});

it.each(['create_goal', 'get_goal', 'update_goal'])(
  'keeps the NativeGoals reservation in functions while dispatching crm.%s',
  async (name) => {
    const peer = new BorrowedPeer();
    peer.declarations = [borrowedDeclaration(name)];
    const selected = await selectMcpTools(
      { name: 'crm', server: peer },
      { context: undefined },
    );
    const functions = await selectMcpTools(
      { name: 'functions', server: peer },
      { context: undefined },
    );
    const home = await mkdtemp(join(tmpdir(), 'selected-mcp-goals-'));
    profiles.push(home);
    const storage = localStorage(join(home, 'profile'));
    const model = new ModelServer([
      [call(name, { value: 'borrowed' }, { namespace: 'crm', callId: name })],
      [message('ready')],
    ]);
    const provider = await providerFor(model);
    const ordinary = tool({
      name,
      parameters: z.object({}),
      execute: () => 'ordinary',
    });
    for (const collision of [ordinary, ...functions]) {
      await expect(
        new Agent({
          instructions: 'Reject the real builtin collision.',
          provider,
          tools: [nativeGoals(), collision],
        }).session({ storage }),
      ).rejects.toThrow('NativeGoals reserves');
    }
    expect(model.requests).toHaveLength(0);
    expect(peer.callTool).not.toHaveBeenCalled();
    const session = await new Agent({
      instructions: 'Call only the borrowed CRM tool.',
      model: 'gpt-5.5',
      provider,
      programmaticToolCalling: false,
      tools: [nativeGoals(), ...selected],
    }).session({ storage });
    sessions.push(session);
    expect((await (await session.submit('go')).wait()).finalOutput).toBe(
      'ready',
    );
    expect(wireTools(model.requests[0])).toContainEqual({
      namespace: 'crm',
      name,
      parameters: peer.declarations[0].inputSchema,
    });
    expect(
      peer.callTool.mock.calls.map(([toolName, args]) => [toolName, args]),
    ).toEqual([[name, { value: 'borrowed' }]]);
    expect(await session.goal()).toBeNull();
    model.assertExhausted();
  },
);
