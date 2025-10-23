import { z } from 'zod';
import { Agent, Runner, tool } from '@openai/agents';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const dataAgentTwo = new Agent({
  name: 'Data agent',
  instructions: 'You are a data agent',
  handoffDescription: 'You know everything about the weather',
  tools: [getWeatherTool],
});

const agent = new Agent({
  name: 'Basic test agent',
  instructions: 'You are a basic agent',
  handoffs: [dataAgentTwo],
});

async function main() {
  const runner = new Runner({
    groupId: 'My group',
    traceMetadata: { user_id: '123' },
  });
  const result = await runner.run(
    agent,
    'What is the weather in San Francisco?',
  );

  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
