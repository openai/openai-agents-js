import { z } from 'zod';
import {
  Agent,
  run,
  withTrace,
  OpenAIChatCompletionsModel,
  tool,
} from '@openai/agents';
import { OpenAI } from 'openai';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    console.log(`[debug] Getting weather for ${input.city}\n`);
    return `The weather in ${input.city} is sunny`;
  },
});

const client = new OpenAI();
const agent = new Agent({
  name: 'Assistant',
  model: new OpenAIChatCompletionsModel(client, 'gpt-5.2'),
  instructions: 'You only respond in haikus.',
  tools: [getWeatherTool],
});

async function main() {
  await withTrace('ChatCompletions Assistant Example', async () => {
    const result = await run(agent, "What's the weather in Tokyo?");
    console.log(`[Final response]\n${result.finalOutput}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
