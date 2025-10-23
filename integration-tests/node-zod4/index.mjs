// @ts-check

import { z } from 'zod';

import {
  Agent,
  run,
  tool,
  setTraceProcessors,
  ConsoleSpanExporter,
  BatchTraceProcessor,
} from '@openai/agents';

setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const agent = new Agent({
  name: 'Test Agent',
  instructions:
    'You will always only respond with "Hello there!". Not more not less.',
  tools: [getWeatherTool],
});

const result = await run(agent, 'What is the weather in San Francisco?');
console.log(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
