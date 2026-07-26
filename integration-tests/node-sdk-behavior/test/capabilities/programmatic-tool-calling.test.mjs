import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Agent,
  programmaticToolCallingTool,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import { createRunner, integrationModel } from '../helpers.mjs';

setTracingDisabled(true);

test('programmatic tool calling retains program-owned calls and output', async () => {
  const calls = [];
  const inventoryOutput = z.object({ units: z.number().int() });
  const readInventory = tool({
    name: 'read_inventory',
    description: 'Return deterministic available units for one item.',
    parameters: z.object({ sku: z.enum(['alpha', 'beta']) }),
    outputSchema: inventoryOutput,
    allowedCallers: ['programmatic'],
    execute: async ({ sku }) => {
      calls.push(sku);
      return { units: sku === 'alpha' ? 7 : 11 };
    },
  });
  const agent = new Agent({
    name: 'Published programmatic tool agent',
    model: integrationModel,
    instructions:
      "Use Programmatic Tool Calling. Generate a JavaScript program that calls read_inventory for 'alpha' and 'beta' with Promise.all, adds their units, and returns the result. Then answer exactly TOTAL:18.",
    tools: [readInventory, programmaticToolCallingTool()],
    modelSettings: {
      maxTokens: 1024,
      toolChoice: 'programmatic_tool_calling',
    },
  });

  const result = await createRunner().run(
    agent,
    'Calculate the total inventory.',
    { maxTurns: 5 },
  );
  const functionCalls = result.newItems.filter(
    (item) =>
      item.type === 'tool_call_item' &&
      item.rawItem?.type === 'function_call' &&
      item.rawItem?.caller?.type === 'program',
  );

  assert.deepEqual(calls.sort(), ['alpha', 'beta']);
  assert.equal(functionCalls.length, 2);
  assert.ok(
    result.newItems.some(
      (item) =>
        item.type === 'tool_call_item' && item.rawItem?.type === 'program',
    ),
  );
  assert.ok(
    result.newItems.some(
      (item) =>
        item.type === 'tool_call_output_item' &&
        item.rawItem?.type === 'program_output',
    ),
  );
  assert.equal(result.finalOutput, 'TOTAL:18');
});
