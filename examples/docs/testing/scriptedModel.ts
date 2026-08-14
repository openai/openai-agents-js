import assert from 'node:assert/strict';
import { Agent, Runner, tool } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/testing';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Gets the weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `${city}: sunny`,
});

const model = new ScriptedModel([
  [functionCall('get_weather', { city: 'Tokyo' }, { callId: 'weather_call' })],
  [assistantMessage('It is sunny in Tokyo.')],
]);

const agent = new Agent({
  name: 'Weather assistant',
  instructions: 'Answer weather questions.',
  model,
  tools: [getWeather],
});

const runner = new Runner({ tracingDisabled: true });
const result = await runner.run(agent, 'What is the weather in Tokyo?');

assert.equal(result.finalOutput, 'It is sunny in Tokyo.');
assert.equal(model.calls.length, 2);

const secondRequest = model.lastCall?.request.input;
assert.ok(Array.isArray(secondRequest));
assert.ok(secondRequest.some((item) => item.type === 'function_call_result'));

model.assertComplete();
