import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Agent,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  ToolCallError,
  ToolGuardrailFunctionOutputFactory,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import { createRunner, integrationModel } from '../helpers.mjs';

setTracingDisabled(true);

test('input and output guardrails preserve allow and tripwire behavior', async () => {
  const inputGuardrail = {
    name: 'deterministic input guardrail',
    runInParallel: false,
    execute: async ({ input }) => ({
      outputInfo: { input },
      tripwireTriggered: String(input).includes('BLOCK_INPUT'),
    }),
  };
  const outputGuardrail = {
    name: 'deterministic output guardrail',
    execute: async ({ agentOutput }) => ({
      outputInfo: { agentOutput },
      tripwireTriggered: agentOutput === 'BLOCK_OUTPUT',
    }),
  };
  const runner = createRunner();
  const allowedAgent = new Agent({
    name: 'Published guardrail allow agent',
    model: integrationModel,
    instructions: 'Reply exactly ALLOWED.',
    inputGuardrails: [inputGuardrail],
    outputGuardrails: [outputGuardrail],
    modelSettings: { maxTokens: 128 },
  });
  const blockedOutputAgent = new Agent({
    name: 'Published output guardrail block agent',
    model: integrationModel,
    instructions: 'Reply exactly BLOCK_OUTPUT.',
    outputGuardrails: [outputGuardrail],
    modelSettings: { maxTokens: 128 },
  });

  const allowed = await runner.run(allowedAgent, 'ALLOW_INPUT');
  assert.equal(allowed.finalOutput, 'ALLOWED');
  assert.equal(allowed.inputGuardrailResults.length, 1);
  assert.equal(allowed.outputGuardrailResults.length, 1);

  await assert.rejects(
    runner.run(allowedAgent, 'BLOCK_INPUT'),
    InputGuardrailTripwireTriggered,
  );
  await assert.rejects(
    runner.run(blockedOutputAgent, 'ALLOW_INPUT'),
    OutputGuardrailTripwireTriggered,
  );
});

test('tool input and output guardrails run in order and fail fast', async () => {
  const calls = [];
  const order = [];
  const inputGuardrail = defineToolInputGuardrail({
    name: 'published tool input guardrail',
    run: async ({ toolCall }) => {
      order.push('input');
      const { value } = JSON.parse(toolCall.arguments);
      return value === 'blocked-input'
        ? ToolGuardrailFunctionOutputFactory.throwException({ value })
        : ToolGuardrailFunctionOutputFactory.allow({ value });
    },
  });
  const outputGuardrail = defineToolOutputGuardrail({
    name: 'published tool output guardrail',
    run: async ({ output }) => {
      order.push('output');
      return output === 'blocked-output'
        ? ToolGuardrailFunctionOutputFactory.throwException({ output })
        : ToolGuardrailFunctionOutputFactory.allow({ output });
    },
  });
  const guardedTool = tool({
    name: 'guarded_action',
    description: 'Return the supplied deterministic value.',
    parameters: z.object({ value: z.string() }),
    inputGuardrails: [inputGuardrail],
    outputGuardrails: [outputGuardrail],
    execute: async ({ value }) => {
      order.push('execute');
      calls.push(value);
      return value;
    },
  });
  const createAgent = (value) =>
    new Agent({
      name: `Published guarded tool agent ${value}`,
      model: integrationModel,
      instructions: `Call guarded_action exactly once with value '${value}', then reply exactly DONE.`,
      tools: [guardedTool],
      modelSettings: {
        maxTokens: 256,
        toolChoice: 'guarded_action',
      },
    });
  const runner = createRunner();

  const allowed = await runner.run(createAgent('allowed'), 'Run the action.');
  assert.equal(allowed.finalOutput, 'DONE');
  assert.deepEqual(order.splice(0), ['input', 'execute', 'output']);
  assert.deepEqual(calls, ['allowed']);

  await assert.rejects(
    runner.run(createAgent('blocked-input'), 'Run the action.'),
    (error) =>
      error instanceof ToolCallError &&
      error.error instanceof ToolInputGuardrailTripwireTriggered,
  );
  assert.deepEqual(order.splice(0), ['input']);
  assert.deepEqual(calls, ['allowed']);

  await assert.rejects(
    runner.run(createAgent('blocked-output'), 'Run the action.'),
    (error) =>
      error instanceof ToolCallError &&
      error.error instanceof ToolOutputGuardrailTripwireTriggered,
  );
  assert.deepEqual(order, ['input', 'execute', 'output']);
  assert.deepEqual(calls, ['allowed', 'blocked-output']);
});
