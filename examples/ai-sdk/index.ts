import { Agent, ModelSettings, run, tool } from '@openai/agents';
import { aisdk, AiSdkModel } from '@openai/agents-extensions';
import { z } from 'zod';

export async function runAgents(
  model: AiSdkModel,
  modelSettings: ModelSettings,
) {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

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
    modelSettings,
  });

  const agent = new Agent({
    name: 'Helpful Assistant',
    instructions:
      'You are a helpful assistant. When you need to get the weather, you can hand off the task to the Weather Data Agent.',
    handoffs: [dataAgent],
    model, // Using the AI SDK model for this agent
    modelSettings,
  });

  const result = await run(
    agent,
    'Hello what is the weather in San Francisco and oakland?',
  );
  console.log(result.finalOutput);
}

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

(async function () {
  const openRouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const _gptOSS = aisdk(openRouter('openai/gpt-oss-120b'));
  const _gpt = aisdk(openai('gpt-5.2'));
  const _claude = aisdk(anthropic('claude-sonnet-4-5'));
  const _gemini = aisdk(google('gemini-3-flash-preview'));
  void _gptOSS;
  void _gpt;
  void _claude;
  void _gemini;
  // Switch the model to use for testing
  const model = _gptOSS;

  const modelSettings: ModelSettings =
    model === _claude
      ? {
          providerData: {
            providerOptions: {
              anthropic: { thinking: { type: 'enabled', budgetTokens: 10000 } },
            },
          },
        }
      : {};

  await runAgents(model, modelSettings);
})();
