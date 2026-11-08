import { z } from 'zod';
import { expect, it } from 'vitest';
import { Agent, captureAgentProfiles } from '../src/runtime/public-agent';
import { tool, captureTools, toolRef } from '../src/runtime/tools';
import {
  captureProfileRuntimes,
  allocatedProfileCatalogs,
  parseProfileReceipt,
  encodeProfileReceipt,
  checkProfileReceipt,
} from '../src/runtime/agent-profiles';

it('keeps same-name tools and validators in separate captured profile catalogs', () => {
  const first = tool({
    name: 'lookup',
    description: 'A',
    parameters: z.object({}),
    execute: async () => 'A',
  });
  const second = tool({
    name: 'lookup',
    description: 'B',
    parameters: z.object({}),
    execute: async () => 'B',
  });
  const b = new Agent({ name: 'B', instructions: 'B', tools: [second] });
  const a = new Agent({
    name: 'A',
    instructions: 'A',
    tools: [first],
    handoffs: [b],
  });
  const graph = captureProfileRuntimes(
    captureAgentProfiles(a),
    captureTools([first]),
    'captured root files',
  );
  expect(graph.roster[0]).toMatchObject({
    instructions: 'captured root files',
    handoffs: { transfer_to_b: 'agent_1' },
    step_defaults: [0],
  });
  expect(
    JSON.parse(graph.profiles.get('agent_0')!.catalog.specsJson)[0].description,
  ).toBe('A');
  expect(
    JSON.parse(graph.profiles.get('agent_1')!.catalog.specsJson)[0].description,
  ).toBe('B');
  const receipt = parseProfileReceipt(
    '{"active":{"profile_id":"agent_1","epoch":9007199254740993},"catalogs":{"agent_0":9007199254740994,"agent_1":9007199254740995},"generation_high_water":9007199254740995}',
  );
  const allocated = allocatedProfileCatalogs(graph, {
    ...(receipt as object),
    active_catalog: {
      generation: '9007199254740995',
      specs: JSON.parse(graph.profiles.get('agent_1')!.catalog.specsJson),
    },
  });
  expect(allocated.profiles.get('agent_1')!.catalog.generation).toBe(
    9007199254740995n,
  );
  expect(allocated.active.epoch).toBe('9007199254740993');
  expect(graph.profiles.get('agent_1')!.catalog.generation).toBe(0n);
  expect(allocated.activeCatalog.tools[0].name).toBe('lookup');
  expect(encodeProfileReceipt(allocated.active)).toBe(
    '{"profile_id":"agent_1","epoch":9007199254740993}',
  );
  expect(() =>
    allocatedProfileCatalogs(
      graph,
      parseProfileReceipt(
        '{"active":{"profile_id":"agent_1","epoch":1},"catalogs":{"agent_0":1,"agent_1":1},"generation_high_water":1}',
      ),
    ),
  ).toThrow('allocation');
  expect(() =>
    checkProfileReceipt({ profile_id: 'unknown', epoch: '1' }, graph),
  ).toThrow('admitted');
});

it('keeps native source epochs exact without converting application data', async () => {
  const { parseNative } = await import('../src/runtime/binding');
  expect(
    parseNative(
      '{"profile_id":"agent_0","profile_epoch":9007199254740993,"arguments":{"epoch":42,"profile_epoch":42}}',
    ),
  ).toEqual({
    profile_id: 'agent_0',
    profile_epoch: '9007199254740993',
    arguments: { epoch: 42, profile_epoch: 42 },
  });
  const event = parseNative(
    '{"id":"g","msg":{"type":"realtime_conversation_realtime","payload":{"OutputTranscriptDelta":{"delta":"text","profile_receipt":{"profile_id":"agent_0","epoch":9007199254740993}}}}}',
  ) as {
    msg: {
      payload: {
        OutputTranscriptDelta: { profile_receipt: { epoch: string } };
      };
    };
  };
  expect(event.msg.payload.OutputTranscriptDelta.profile_receipt.epoch).toBe(
    '9007199254740993',
  );
});

it('keeps an accepted reordered subset separate from the immutable destination template', () => {
  const first = tool({
    name: 'first',
    description: 'first',
    parameters: z.object({ count: z.number().min(1) }),
    execute: async () => 'first',
  });
  const second = tool({
    name: 'second',
    description: 'second',
    parameters: z.object({}),
    execute: async () => 'second',
  });
  const b = new Agent({ name: 'B', instructions: 'B', tools: [first, second] });
  const a = new Agent({ name: 'A', instructions: 'A', handoffs: [b] });
  const graph = captureProfileRuntimes(
    captureAgentProfiles(a),
    captureTools([]),
    'A',
  );
  const specs = JSON.parse(graph.profiles.get('agent_1')!.catalog.specsJson);
  const receipt = parseProfileReceipt(
    JSON.stringify({
      active: { profile_id: 'agent_1', epoch: 4 },
      catalogs: { agent_0: 20, agent_1: 21 },
      generation_high_water: 22,
      active_catalog: { generation: 22, specs: [specs[1], specs[0]] },
    }),
  );
  const allocated = allocatedProfileCatalogs(graph, receipt);
  expect(
    allocated.profiles.get('agent_1')!.catalog.tools.map((tool) => tool.name),
  ).toEqual(['first', 'second']);
  expect(allocated.activeCatalog.tools.map((tool) => tool.name)).toEqual([
    'second',
    'first',
  ]);
  expect(allocated.activeCatalog.generation).toBe(22n);
  expect(
    JSON.parse(allocated.activeCatalog.specsJson)[1].inputSchema.properties
      .count.minimum,
  ).toBe(1);
  expect(() =>
    allocatedProfileCatalogs(graph, {
      ...(receipt as object),
      active_catalog: { generation: '22', specs: [specs[0], specs[0]] },
    }),
  ).toThrow('fresh declarations');
});

it('encodes operation source epochs exactly without changing string catalog IDs or schema data', async () => {
  const { encodeReceipt, encodeOperationSelection } =
    await import('../src/runtime/binding');
  const source = { profile_id: 'agent_0', epoch: '9007199254740993' };
  const selection = {
    generation: '9007199254740994',
    operation_declaration_source: source,
    names: [],
  };
  const wire = encodeOperationSelection(selection);
  expect(wire).toContain('"generation":"9007199254740994"');
  expect(wire).toContain('"epoch":9007199254740993');
  expect(
    encodeReceipt({ selection, input: [{ epoch: 'application data' }] }),
  ).toContain('"epoch":9007199254740993');
  expect(
    encodeReceipt({ selection, input: [{ epoch: 'application data' }] }),
  ).toContain('"epoch":"application data"');
});

it('captures every model control in profiles and normalizes named and cleared choices', () => {
  const metadata = { owner: 'destination' };
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute: () => 'found',
  });
  const destination = new Agent<unknown>({
    name: 'destination',
    instructions: 'Use the destination settings.',
    model: 'fixture-profile-controls',
    tools: [lookup],
    modelSettings: {
      reasoningEffort: 'low',
      reasoningSummary: 'auto',
      serviceTier: 'priority',
      invocationTimeoutMs: 3210,
      toolChoice: toolRef('lookup'),
      maxOutputTokens: 91,
      temperature: 0.4,
      topP: 0.7,
      topLogprobs: 3,
      parallelToolCalls: false,
      verbosity: 'high',
      metadata,
      store: true,
      promptCacheRetention: '24h',
      promptCacheTtl: '12h',
    },
  });
  const cleared = new Agent<unknown>({
    name: 'cleared',
    instructions: 'Use cleared settings.',
    modelSettings: {
      invocationTimeoutMs: null,
      maxOutputTokens: null,
      toolChoice: null,
    },
  });
  const source = new Agent<unknown>({
    instructions: 'Source.',
    handoffs: [destination, cleared],
  });
  const graph = captureProfileRuntimes(
    captureAgentProfiles(source),
    captureTools([]),
    'Source.',
  );
  metadata.owner = 'mutated';
  expect(graph.roster[1].model).toEqual({
    model: 'fixture-profile-controls',
    reasoning_effort: 'low',
    reasoning_summary: 'auto',
    service_tier: 'priority',
    tool_choice: 'required',
    invocation_timeout_ms: 3210,
    request_controls: {
      named_tool_choice: { name: 'lookup', namespace: null },
      max_output_tokens: 91,
      temperature: 0.4,
      top_p: 0.7,
      top_logprobs: 3,
      parallel_tool_calls: false,
      verbosity: 'high',
      metadata: { owner: 'destination' },
      store: true,
      prompt_cache_retention: '24h',
      prompt_cache_ttl: '12h',
    },
    personality: null,
  });
  expect(graph.roster[0].model).toMatchObject({
    tool_choice: null,
    invocation_timeout_ms: null,
    request_controls: {},
  });
  expect(graph.roster[2].model).toMatchObject({
    tool_choice: 'auto',
    invocation_timeout_ms: null,
    request_controls: { max_output_tokens: null, named_tool_choice: null },
  });
});

it('captures terminal slots and metadata selections separately for every profile', async () => {
  const { StdioMCP } = await import('../src/runtime/mcp');
  const first = tool({
    name: 'finish',
    namespace: 'reports',
    parameters: z.object({}),
    finishTurn: false,
    execute: () => 'A',
  });
  const second = tool({
    name: 'finish',
    namespace: 'reports',
    parameters: z.object({}),
    finishTurn: true,
    execute: () => 'B',
  });
  const mcp = new StdioMCP({
    name: 'fixture',
    command: 'unused-pure-capture',
    tools: ['lookup'],
    requestMetadata: () => ({ audit: 'B' }),
  });
  const target = new Agent({
    name: 'B',
    instructions: 'B',
    tools: [second, mcp],
  });
  const root = new Agent({
    name: 'A',
    instructions: 'A',
    tools: [first],
    handoffs: [target],
  });
  const graph = captureProfileRuntimes(
    captureAgentProfiles(root),
    captureTools([first]),
    'A',
  );
  expect(graph.roster[0]).toMatchObject({
    terminal_slots: [],
    mcp_metadata_tools: {},
  });
  expect(graph.roster[1]).toMatchObject({
    terminal_slots: [0],
    mcp_metadata_tools: { fixture: ['lookup'] },
  });
  expect(JSON.stringify(graph.roster)).not.toContain('"audit"');
});
