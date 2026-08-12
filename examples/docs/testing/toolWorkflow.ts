import { Agent, Runner, tool } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

test('runs a multi-turn tool workflow', async () => {
  const weather = tool({
    name: 'get_weather',
    description: 'Gets the weather for a city.',
    parameters: z.object({ city: z.string() }),
    execute: async ({ city }) => `${city}: sunny`,
  });
  const model = new ScriptedModel([
    // The first model turn enters the real SDK tool execution pipeline.
    [functionCall('get_weather', { city: 'Tokyo' }, { callId: 'call_1' })],
    // The second turn sees the tool result and finishes the workflow.
    [assistantMessage('It is sunny in Tokyo.')],
  ]);
  const agent = new Agent({
    name: 'Weather assistant',
    model,
    tools: [weather],
  });

  // ScriptedModel replaces model I/O; disable tracing separately so this test
  // makes no network requests.
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, 'What is the weather in Tokyo?');

  assert.equal(result.finalOutput, 'It is sunny in Tokyo.');
  assert.equal(model.calls.length, 2);
  const lastInput = model.lastCall?.request.input;
  assert(Array.isArray(lastInput));
  assert(lastInput.some((item) => item.type === 'function_call_result'));
  model.assertComplete();
});
