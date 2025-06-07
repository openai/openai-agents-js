import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';
import { openai } from '@ai-sdk/openai';
import { aisdk } from '@openai/agents-extensions';

const model = aisdk(openai('gpt-4.1-nano'));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    await sleep(300);
    return `The weather in ${input.city} is sunny`;
  },
});

const dataAgent = new Agent({
  name: 'Weather Data Agent',
  instructions: 'You are a weather data agent.',
  handoffDescription:
    'When you are asked about the weather, you will use tools to get the weather.',
  tools: [getWeatherTool],
  model, // Using the AI SDK model for this agent
});

const agent = new Agent({
  name: 'Helpful Assistant',
  instructions:
    'You are a helpful assistant. When you need to get the weather, you can hand off the task to the Weather Data Agent.',
  handoffs: [dataAgent],
});

async function main() {
  const result = await run(
    agent,
    'Hello what is the weather in San Francisco and oakland?',
  );
  console.log(result.finalOutput);
}

main();
