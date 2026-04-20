// @ts-check

import { z } from 'zod';

import { Agent, getGlobalTraceProvider, run, tool } from '@openai/agents';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const agent = new Agent({
  name: 'Zod Test Agent',
  instructions:
    'You will always only respond with "Hello there!". Not more not less.',
  tools: [getWeatherTool],
});

try {
  const result = await run(agent, 'What is the weather in San Francisco?');
  console.log(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
} finally {
  await getGlobalTraceProvider().shutdown();
}
