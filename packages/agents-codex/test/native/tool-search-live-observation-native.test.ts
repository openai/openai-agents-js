import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  toolSearch,
  type AgentToolStreamEvent,
  type Completed,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('exposes actual client search call/output live while redacting default readers', async () => {
  const model = new ModelServer([
    [
      {
        type: 'tool_search_call',
        id: 'provider_search',
        call_id: 'search_secret',
        execution: 'client',
        status: 'completed',
        arguments: { paths: ['lookup'], query: 'secret-query' },
      },
    ],
    [call('lookup', { key: 'invoice' }, { callId: 'lookup_actual' })],
    [message('done')],
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-live-search',
    supportsWebsockets: false,
  });
  let searchCallbacks = 0;
  let toolEffects = 0;
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Discover then use lookup.',
    tools: [
      toolSearch({
        execution: 'client',
        execute: ({ loadDefault }) => {
          searchCallbacks++;
          return loadDefault(['lookup']);
        },
      }),
      tool({
        name: 'lookup',
        description: 'Look up a known record.',
        parameters: z.object({ key: z.string().min(3) }),
        deferLoading: true,
        execute: () => {
          toolEffects++;
          return 'lookup-result';
        },
      }),
    ],
  }).session();
  const turn = await session.submit('begin');
  const detailed = Array.fromAsync(
    turn.events({ includeExecutionDetails: true }),
  );
  const defaultView = Array.fromAsync(turn.events());
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(searchCallbacks).toBe(1);
  expect(toolEffects).toBe(1);
  expect(model.requests).toHaveLength(3);
  const output = model.requests[1].input;
  expect(Array.isArray(output)).toBe(true);
  if (!Array.isArray(output)) throw new Error('Missing search output');
  const wireResult = output.find(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      item.type === 'tool_search_output' &&
      item.call_id === 'search_secret',
  ) as JsonObject | undefined;
  expect(wireResult?.tools).toEqual([
    expect.objectContaining({
      name: 'functions',
      tools: [
        expect.objectContaining({
          name: 'lookup',
          description: 'Look up a known record.',
          parameters: expect.objectContaining({
            properties: { key: { type: 'string', minLength: 3 } },
          }),
        }),
      ],
    }),
  ]);
  const observed = (await detailed).filter(
    (event) => event.type === 'hosted_tool_item_completed',
  );
  expect(observed.map((event) => event.item.type)).toEqual([
    'tool_search_call',
    'tool_search_output',
  ]);
  expect(observed[0]).toMatchObject({
    turnId: turn.turnId,
    item: {
      type: 'tool_search_call',
      id: 'provider_search',
      call_id: 'search_secret',
      execution: 'client',
      arguments: { query: 'secret-query' },
    },
  });
  expect(observed[1]).toMatchObject({
    turnId: turn.turnId,
    item: {
      type: 'tool_search_output',
      call_id: 'search_secret',
      execution: 'client',
      tools: wireResult?.tools,
    },
  });
  expect(observed[1]?.item).toHaveProperty(
    'provider_data.tools',
    wireResult?.tools,
  );
  expect(JSON.stringify(observed)).not.toContain('[agents-schema:');
  expect(observed[1]?.item).not.toHaveProperty('provider_data.id');
  const summaries = (await defaultView).filter(
    (event) => event.type === 'hosted_tool_item_completed',
  );
  expect(summaries.map((event) => event.item.type)).toEqual([
    'tool_search_call',
    'tool_search_output',
  ]);
  expect(summaries[0]?.item.id).toBe('provider_search');
  expect(JSON.stringify(summaries)).not.toContain('search_secret');
  expect(JSON.stringify(summaries)).not.toContain('secret-query');
  expect(JSON.stringify(summaries)).not.toContain('lookup');
  model.assertExhausted();
}, 30_000);

it('observes provider-completed server search call and output with no call id', async () => {
  const model = new ModelServer([
    [
      {
        type: 'tool_search_call',
        id: 'provider_call',
        call_id: null,
        execution: 'server',
        status: 'completed',
        arguments: { query: 'server-only' },
      },
      {
        type: 'tool_search_output',
        id: 'provider_output',
        call_id: null,
        execution: 'server',
        status: 'completed',
        tools: [],
      },
      message('done'),
    ],
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-server-search',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    model: 'gpt-5.5',
    provider,
    instructions: 'Search for tools.',
    tools: [toolSearch({ execution: 'server' })],
  }).session();
  const turn = await session.submit('begin');
  const events = Array.fromAsync(
    turn.events({ includeExecutionDetails: true }),
  );
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(
    (await events).filter(
      (event) => event.type === 'hosted_tool_item_completed',
    ),
  ).toMatchObject([
    {
      turnId: turn.turnId,
      item: {
        type: 'tool_search_call',
        id: 'provider_call',
        callId: null,
        execution: 'server',
        arguments: { query: 'server-only' },
      },
    },
    {
      turnId: turn.turnId,
      item: {
        type: 'tool_search_output',
        id: 'provider_output',
        callId: null,
        execution: 'server',
        tools: [],
      },
    },
  ]);
  model.assertExhausted();
}, 30_000);

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-configured-tool-search',
    supportsWebsockets: false,
  });
}

it('observes server tool search in the configured child without leaking into the root turn', async () => {
  const parentModel = new ModelServer([
    [call('nested', { input: 'Find the tool.' }, { callId: 'parent-nested' })],
    [message('parent complete')],
  ]);
  const childModel = new ModelServer([
    [
      {
        type: 'tool_search_call',
        id: 'child-search-call',
        call_id: null,
        execution: 'server',
        status: 'completed',
        arguments: { query: 'child-owned query' },
      },
      {
        type: 'tool_search_output',
        id: 'child-search-output',
        call_id: null,
        execution: 'server',
        status: 'completed',
        tools: [],
      },
      message('child complete'),
    ],
  ]);
  await using parentProvider = await providerFor(parentModel);
  await using childProvider = await providerFor(childModel);
  const child = new Agent({
    name: 'configured-child',
    provider: childProvider,
    model: 'gpt-5.5',
    instructions: 'Find the tool.',
    tools: [toolSearch({ execution: 'server' })],
  });
  const childEvents: AgentToolStreamEvent[] = [];
  let childResult: Completed | undefined;
  const nested = child.asTool({
    toolName: 'nested',
    returnItems: true,
    customOutputExtractor(result) {
      childResult = result;
      return result.finalOutput;
    },
    onStream(event) {
      childEvents.push(event);
    },
  });
  await using session = await new Agent({
    provider: parentProvider,
    model: 'gpt-5.5',
    instructions: 'Use the configured child.',
    tools: [nested],
  }).session();
  const parent = await session.submit('Begin.');
  const rootEvents = Array.fromAsync(
    parent.events({ includeExecutionDetails: true }),
  );

  expect((await parent.wait()).finalOutput).toBe('parent complete');
  expect(childResult?.finalOutput).toBe('child complete');
  parentModel.assertExhausted();
  childModel.assertExhausted();
  expect(childModel.requests[0]?.tools).toContainEqual(
    expect.objectContaining({ type: 'tool_search', execution: 'server' }),
  );
  for (const request of parentModel.requests) {
    expect(request.tools).not.toContainEqual(
      expect.objectContaining({ type: 'tool_search' }),
    );
  }
  expect(
    (await rootEvents).filter(
      (event) => event.type === 'hosted_tool_item_completed',
    ),
  ).toEqual([]);

  const produced = childResult?.items?.flatMap(({ agent, item }) => {
    if (
      item.type !== 'tool_search_call' &&
      item.type !== 'tool_search_output'
    ) {
      return [];
    }
    expect(agent).toBe(child);
    return [item];
  });
  expect(produced).toMatchObject([
    {
      type: 'tool_search_call',
      id: 'child-search-call',
      execution: 'server',
      callId: null,
      arguments: { query: 'child-owned query' },
    },
    {
      type: 'tool_search_output',
      id: 'child-search-output',
      execution: 'server',
      callId: null,
      tools: [],
    },
  ]);

  const searchEvents = childEvents.flatMap(({ agent, callId, event }) => {
    if (event.type !== 'hosted_tool_item_completed') return [];
    expect(agent).toBe(child);
    expect(callId).toBe('parent-nested');
    expect(event.turnId).toBe(childResult?.turn.turnId);
    expect(event.turnId).not.toBe(parent.turnId);
    return [event.item];
  });
  expect(searchEvents).toMatchObject([
    { type: 'tool_search_call', id: 'child-search-call', status: 'completed' },
    {
      type: 'tool_search_output',
      id: 'child-search-output',
      status: 'completed',
    },
  ]);
  expect(JSON.stringify(searchEvents)).not.toContain('child-owned query');
}, 30_000);
