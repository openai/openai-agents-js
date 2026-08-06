import assert from 'node:assert/strict';
import test from 'node:test';

import { Agent, setTracingDisabled, tool } from '@openai/agents';
import { z } from 'zod';

import {
  assertInstalledPackageBoundary,
  createRunner,
  getToolCalls,
  getToolOutputs,
  hasRawModelEvent,
  integrationModel,
  runAgent,
} from '../helpers.mjs';

setTracingDisabled(true);

test('loads the SDK from the Verdaccio-installed package', () => {
  assertInstalledPackageBoundary();
});

for (const stream of [false, true]) {
  test(`Responses function tools preserve calls, outputs, and usage (${stream ? 'streaming' : 'non-streaming'})`, async () => {
    const calls = [];
    const doubleNumber = tool({
      name: 'double_number',
      description: 'Double the supplied number.',
      parameters: z.object({ value: z.number().int() }),
      execute: async ({ value }) => {
        calls.push(value);
        return value * 2;
      },
    });
    const agent = new Agent({
      name: 'Published Responses tool agent',
      model: integrationModel,
      instructions:
        'Call double_number exactly once with value 21, then reply exactly RESULT:42.',
      tools: [doubleNumber],
      modelSettings: { maxTokens: 512 },
    });
    const runner = createRunner();
    const executed = await runAgent(runner, agent, 'Use the tool now.', {
      stream,
    });
    const result = stream ? executed.result : executed;

    assert.deepEqual(calls, [21]);
    assert.equal(result.finalOutput, 'RESULT:42');
    assert.equal(getToolCalls(result, 'double_number').length, 1);
    assert.equal(getToolOutputs(result).length, 1);
    assert.ok(result.state.usage.totalTokens > 0);
    if (stream) {
      assert.ok(hasRawModelEvent(executed.events));
    }
  });
}

test('Responses structured output is parsed by the installed package', async () => {
  const statusSchema = z.object({
    status: z.literal('READY'),
    value: z.literal(42),
    note: z.null(),
  });
  const agent = new Agent({
    name: 'Published structured output agent',
    model: integrationModel,
    instructions: 'Return status READY, value 42, and note null.',
    outputType: statusSchema,
    modelSettings: { maxTokens: 256 },
  });

  const result = await createRunner().run(
    agent,
    'Return the requested structured result.',
  );

  assert.deepEqual(result.finalOutput, {
    status: 'READY',
    value: 42,
    note: null,
  });
  assert.ok(result.state.usage.totalTokens > 0);
});
