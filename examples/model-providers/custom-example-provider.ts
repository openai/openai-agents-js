import {
  Agent,
  Runner,
  tool,
  setTracingDisabled,
  ModelProvider,
  OpenAIChatCompletionsModel,
} from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

// Read environment variables
const BASE_URL = process.env.EXAMPLE_BASE_URL || '';
const API_KEY = process.env.EXAMPLE_API_KEY || '';
const MODEL_NAME = process.env.EXAMPLE_MODEL_NAME || '';

if (!BASE_URL || !API_KEY || !MODEL_NAME) {
  throw new Error(
    'Please set EXAMPLE_BASE_URL, EXAMPLE_API_KEY, EXAMPLE_MODEL_NAME via env var or code.',
  );
}

/**
 * This example uses a custom provider for some calls to Runner.run(), and direct calls to OpenAI for others.
 * Steps:
 * 1. Create a custom OpenAI client.
 * 2. Create a ModelProvider that uses the custom client.
 * 3. Use the ModelProvider in calls to Runner.run(), only when we want to use the custom LLM provider.
 *
 * Note that in this example, we disable tracing under the assumption that you don't have an API key
 * from platform.openai.com. If you do have one, you can set the `OPENAI_API_KEY` env var for tracing.
 */

const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
setTracingDisabled(true);

class CustomModelProvider implements ModelProvider {
  async getModel(modelName?: string) {
    return new OpenAIChatCompletionsModel(client, modelName || MODEL_NAME);
  }
}

const CUSTOM_MODEL_PROVIDER = new CustomModelProvider();

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: z.object({ city: z.string() }),
  async execute(input) {
    console.log(`[debug] getting weather for ${input.city}`);
    return `The weather in ${input.city} is sunny.`;
  },
});

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You only respond in haikus.',
    tools: [getWeather],
  });

  // This will use the custom model provider
  const runner = new Runner({ modelProvider: CUSTOM_MODEL_PROVIDER });
  const result = await runner.run(agent, "What's the weather in Tokyo?");
  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
