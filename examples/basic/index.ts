import { z } from 'zod';
import { Agent, Runner, tool } from '@openai/agents';

let weatherCalls = 0;
const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    weatherCalls++;
    return `The weather in ${input.city} is sunny`;
  },
});

const dataAgentTwo = new Agent({
  name: 'Data agent',
  instructions:
    'Call get_weather for the requested city and report its result.',
  handoffDescription: 'You know everything about the weather',
  tools: [getWeatherTool],
});

const agent = new Agent({
  name: 'Basic test agent',
  instructions: 'Hand off weather questions to the data agent.',
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

  if (result.lastAgent !== dataAgentTwo || weatherCalls === 0) {
    throw new Error(
      'Expected a handoff to the data agent and a weather tool call.',
    );
  }
  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
