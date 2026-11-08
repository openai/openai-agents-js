import { z } from 'zod';
import { expect, it } from 'vitest';
import { Agent, captureAgentProfiles } from '../src/runtime/public-agent';
import { tool, captureTools } from '../src/runtime/tools';
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
