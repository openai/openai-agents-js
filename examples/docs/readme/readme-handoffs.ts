import { z } from '@openai/zod';
import { Agent, run, tool } from '@openai/agents';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const dataAgent = new Agent({
  name: 'Data agent',
  instructions: 'You are a data agent',
  handoffDescription: 'You know everything about the weather',
  tools: [getWeatherTool],
});

// Use Agent.create method to ensure the finalOutput type considers handoffs
const agent = Agent.create({
  name: 'Basic test agent',
  instructions: 'You are a basic agent',
  handoffs: [dataAgent],
});

async function main() {
  const result = await run(agent, 'What is the weather in San Francisco?');
  console.log(result.finalOutput);
}

main().catch(console.error);
