import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  hostedShell,
  manualTool,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([false, true])(
  'retains provider-hosted Shell calls and outputs in order (assistant=%s)',
  async (assistant) => {
    const callId = 'produced-shell-call';
    const server = new ModelServer([
      [
        {
          type: 'shell_call',
          id: 'produced-shell-item',
          call_id: callId,
          status: 'completed',
          action: { commands: ['printf parity'], timeout_ms: 1000 },
          environment: {
            type: 'container_reference',
            container_id: 'cntr_shell',
          },
        },
        {
          type: 'shell_call_output',
          id: 'produced-shell-output',
          call_id: callId,
          status: 'completed',
          output: [
            {
              stdout: 'parity',
              stderr: '',
              outcome: { type: 'exit', exit_code: 0 },
            },
          ],
        },
        ...(assistant ? [message('finished')] : []),
      ],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-hosted-shell-produced-items',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Use the provider shell.',
      model: 'gpt-5.5',
      provider,
      tools: [hostedShell({ environment: { type: 'container_auto' } })],
    });

    const completed = await agent.run('Run the tool.', { returnItems: true });

    expect(completed.items?.map(({ item }) => item.type)).toEqual([
      'shell_call',
      'shell_call_output',
      ...(assistant ? ['message'] : []),
    ]);
    expect(completed.items?.slice(0, 2).map(({ item }) => item)).toMatchObject([
      { call_id: callId, id: 'produced-shell-item' },
      { call_id: callId, id: 'produced-shell-output' },
    ]);
    for (const entry of completed.items ?? []) expect(entry.agent).toBe(agent);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it('retains accepted local shell calls in produced item order', async () => {
  const action = { type: 'exec', command: ['true'] };
  const server = new ModelServer([
    [
      {
        type: 'local_shell_call',
        id: 'local-shell-item',
        call_id: 'local-shell-call',
        status: 'completed',
        action,
      },
      message('finished'),
    ],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-local-shell-items',
    supportsWebsockets: false,
  });
  const agent = new Agent({ instructions: 'Return the answer.', provider });
  const completed = await agent.run('finish', { returnItems: true });
  expect(completed.finalOutput).toBe('finished');
  expect(completed.items?.map(({ item }) => item.type)).toEqual([
    'local_shell_call',
    'message',
  ]);
  expect(completed.items?.[0]).toMatchObject({
    agent,
    item: {
      id: 'local-shell-item',
      type: 'local_shell_call',
      callId: 'local-shell-call',
      action,
      status: 'completed',
    },
  });
  expect(server.requests).toHaveLength(1);
});

it('returns only the owned tool sequence and its handoff Agents', async () => {
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    execute({ key }) {
      effects.push(key);
      return `value:${key}`;
    },
  });
  const server = new ModelServer([
    [message('previous answer')],
    [call('transfer_to_b', {}, { callId: 'handoff-a-b' })],
    [call('lookup', { key: 'current' }, { callId: 'lookup-current' })],
    [message('current answer')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-produced-items',
    supportsWebsockets: false,
  });
  const target = new Agent({
    name: 'B',
    instructions: 'Use lookup.',
    tools: [lookup],
  });
  const source = new Agent({
    name: 'A',
    instructions: 'Transfer to B.',
    provider,
    handoffs: [target],
  });
  const first = await source.run('previous input', { returnState: true });
  expect(first.items).toBeUndefined();
  expect(first.state).toBeDefined();

  const completed = await source.run('current input', {
    state: first.state,
    returnHistory: true,
    returnItems: true,
  });
  expect(completed.finalOutput).toBe('current answer');
  expect(completed.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [
          expect.objectContaining({
            type: 'output_text',
            text: 'previous answer',
          }),
        ],
      }),
    ]),
  );
  const items = completed.items ?? [];
  expect(
    items.map(({ item }) => [
      item.type,
      'callId' in item ? item.callId : undefined,
    ]),
  ).toEqual([
    ['function_call', 'handoff-a-b'],
    ['function_call_output', 'handoff-a-b'],
    ['function_call', 'lookup-current'],
    ['function_call_output', 'lookup-current'],
    ['message', undefined],
  ]);
  for (const entry of items.slice(0, 2)) expect(entry.agent).toBe(source);
  for (const entry of items.slice(2)) expect(entry.agent).toBe(target);
  expect(items[1].handoffTarget).toBe(target);
  expect(effects).toEqual(['current']);
  expect(server.requests).toHaveLength(4);
});

it('bounds the original tool output after the turn completes', async () => {
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute() {
      effects.push('executed');
      return 'x'.repeat(8 * 1024 * 1024);
    },
  });
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'large-output' })],
    [message('finished')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-produced-items',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    tools: [lookup],
    provider,
  });

  await expect(
    agent.run('lookup', { returnItems: true }),
  ).rejects.toMatchObject({
    name: 'NativeError',
    message: 'Produced run items exceed the one-shot result limit',
  });
  expect(effects).toEqual(['executed']);
  expect(server.requests).toHaveLength(2);
});

it('captures resumed manual outputs before restored interaction handlers finish', async () => {
  const lookup = manualTool({
    name: 'lookup',
    description: 'Ask lookup.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'resumed-lookup' })],
    [message('resumed answer')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-restored-produced-items',
    supportsWebsockets: false,
  });
  // A public factory override has been holding opening until the restored turn
  // finishes, making early callback completion deterministic.
  class RestoringAgent extends Agent {
    override async session(...args: Parameters<Agent['session']>) {
      const session = await super.session(...args);
      if (args[0]?.state) await session.wait();
      return session;
    }
  }
  const agent = new RestoringAgent({
    provider,
    instructions: 'Ask lookup, then answer.',
    tools: [lookup],
  });
  await using original = await agent.session();
  const turn = await original.submit('lookup');
  const completion = turn.wait().catch((error: unknown) => error);
  for await (const event of original.events()) {
    if (event.type === 'action_requested') break;
  }
  const state = await original.suspend();
  expect(await completion).toBeInstanceOf(InteractionRequired);
  await original.close();
  let replies = 0;
  const completed = await agent.run(null, {
    state,
    returnItems: true,
    async onInteraction(event) {
      if (event.type !== 'action_requested')
        throw new Error('Expected manual request');
      replies++;
      return event.reply('restored value');
    },
  });
  expect(replies).toBe(1);
  expect(completed.finalOutput).toBe('resumed answer');
  expect(completed.items?.map(({ item }) => item.type)).toEqual([
    'function_call_output',
    'message',
  ]);
  expect(completed.items?.[0].item).toMatchObject({
    callId: 'resumed-lookup',
    output: 'restored value',
  });
  for (const entry of completed.items ?? []) expect(entry.agent).toBe(agent);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it('retains accepted discovery calls and outputs in the produced sequence', async () => {
  const selected = tool({
    name: 'invoice',
    description: 'Find the invoice',
    deferLoading: true,
    parameters: z.object({ key: z.string() }),
    execute: ({ key }) => `paid:${key}`,
  });
  const server = new ModelServer([
    [
      {
        type: 'tool_search_call',
        call_id: 'find-invoice',
        execution: 'client',
        arguments: { query: 'invoice', limit: 5 },
      },
    ],
    [call('invoice', { key: 'A1' }, { callId: 'use-invoice' })],
    [message('settled')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-discovery-produced-items',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Find and use the invoice.',
    programmaticToolCalling: false,
    tools: [selected],
  });
  const completed = await agent.run('Find invoice A1.', { returnItems: true });
  expect(
    completed.items?.map(({ item }) => [
      item.type,
      'callId' in item ? item.callId : undefined,
    ]),
  ).toEqual([
    ['tool_search_call', 'find-invoice'],
    ['tool_search_output', 'find-invoice'],
    ['function_call', 'use-invoice'],
    ['function_call_output', 'use-invoice'],
    ['message', undefined],
  ]);
  expect(completed.items?.[0].item).toMatchObject({ status: 'completed' });
  expect(completed.items?.[0].item.data).toMatchObject({
    arguments: { query: 'invoice', limit: 5 },
  });
  expect(completed.items?.[1].item.data.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'namespace',
        name: 'functions',
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            name: 'invoice',
            parameters: expect.objectContaining({
              properties: { key: { type: 'string' } },
            }),
          }),
        ]),
      }),
    ]),
  );
  for (const entry of completed.items ?? []) expect(entry.agent).toBe(agent);
  expect(completed.finalOutput).toBe('settled');
  expect(server.requests).toHaveLength(3);
  server.assertExhausted();
});

it('keeps function and server-search identities separate when their call IDs match', async () => {
  let effects = 0;
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute() {
      effects++;
      return 'looked up';
    },
  });
  const server = new ModelServer([
    [
      call('lookup', {}, { callId: 'shared' }),
      {
        type: 'tool_search_call',
        call_id: 'shared',
        execution: 'server',
        arguments: {},
      },
      {
        type: 'tool_search_output',
        call_id: 'shared',
        execution: 'server',
        status: 'completed',
        tools: [],
      },
    ],
    [message('settled')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-search-family',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    model: 'fixture-produced-call-family',
    provider,
    tools: [lookup],
    programmaticToolCalling: false,
    instructions: 'Use lookup.',
  });
  const completed = await agent.run('lookup', { returnItems: true });
  expect(completed.items?.map(({ item }) => [item.type, item.status])).toEqual([
    ['function_call', 'completed'],
    ['tool_search_call', 'completed'],
    ['tool_search_output', 'completed'],
    ['function_call_output', 'completed'],
    ['message', 'completed'],
  ]);
  expect(effects).toBe(1);
  expect(completed.finalOutput).toBe('settled');
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});
