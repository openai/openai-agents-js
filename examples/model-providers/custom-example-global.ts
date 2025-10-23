import {
  Agent,
  Runner,
  setTracingDisabled,
  tool,
  OpenAIProvider,
  setDefaultOpenAIClient,
  setOpenAIAPI,
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
 * This example uses a custom provider for all requests by default. We do three things:
 * 1. Create a custom client.
 * 2. Set it as the default OpenAI client, and don't use it for tracing.
 * 3. Set the default API as Chat Completions, as most LLM providers don't yet support Responses API.
 *
 * Note that in this example, we do not set up tracing, under the assumption that you don't have an API key
 * from platform.openai.com. If you do have one, you can set the `OPENAI_API_KEY` env var for tracing.
 */

// Create a custom OpenAI client and provider
const openaiClient = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
});
const modelProvider = new OpenAIProvider({
  openAIClient: openaiClient,
});
setDefaultOpenAIClient(openaiClient); // Pass the OpenAI client instance
setOpenAIAPI('chat_completions');
setTracingDisabled(true);

// Tool definition
const getWeather = tool({
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: z.object({
    city: z.string().describe('The city to get weather for'),
  }),
  async execute(input) {
    // input: { city: string }
    console.log(`[debug] getting weather for ${input.city}`);
    return `The weather in ${input.city} is sunny.`;
  },
});

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You only respond in haikus.',
    model: MODEL_NAME,
    tools: [getWeather],
  });

  const runner = new Runner({ modelProvider });
  const result = await runner.run(agent, "What's the weather in Tokyo?");
  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
